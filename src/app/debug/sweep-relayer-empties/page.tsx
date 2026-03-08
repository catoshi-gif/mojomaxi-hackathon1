// File: src/app/debug/sweep-relayer-empties/page.tsx
"use client";

import React, { useMemo, useRef, useState } from "react";

type ApiResult =
  | { ok: true; dry: true; relayer: string; programId: string; found: number; candidates: any[]; stats?: any }
  | {
      ok: true;
      dry: false;
      relayer: string;
      programId: string;
      closed: number;
      txs: number;
      sigs: string[];
      candidates: any[];
      stats?: any;
    }
  | { ok: false; error: string };

type StreamLine =
  | {
      type: "start";
      relayer: string;
      programId: string;
      dry: boolean;
      limit: number;
      include2022: boolean;
      timeoutMs: number;
      sigLimit: number;
      maxPairs: number;
      maxDays: number;
    }
  | { type: "phase"; name: string }
  | { type: "progress"; program: "classic" | "token2022"; scanned: number; total: number; found: number; elapsedMs: number }
  | { type: "done"; ok: true; dry: boolean; found: number; candidates: any[]; stats: any }
  | { type: "error"; ok: false; status: number; error: string };

export default function SweepRelayerEmptiesPage() {
  const [secret, setSecret] = useState("");
  const [limit, setLimit] = useState(200);
  const [include2022, setInclude2022] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(45000);
  const [sigLimit, setSigLimit] = useState(2000);
  const [maxDays, setMaxDays] = useState(30);
  const [maxPairs, setMaxPairs] = useState(2000);
  const [beforeSig, setBeforeSig] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);

  const [phase, setPhase] = useState<string>("");
  const [progressText, setProgressText] = useState<string>("");
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  const buildEndpoint = useMemo(() => {
    return (isDry: boolean, stream: boolean) => {
      const params = new URLSearchParams();
      if (isDry) params.set("dry", "1");
      if (stream) params.set("stream", "1");
      params.set("limit", String(Math.max(1, Math.min(500, Number(limit) || 200))));
      if (include2022) params.set("include2022", "1");
      params.set("timeoutMs", String(Math.max(2000, Math.min(120000, Number(timeoutMs) || 45000))));
      params.set("sigLimit", String(Math.max(50, Math.min(10000, Number(sigLimit) || 2000))));
      params.set("maxDays", String(Math.max(1, Math.min(365, Number(maxDays) || 30))));
      params.set("maxPairs", String(Math.max(5, Math.min(10000, Number(maxPairs) || 2000))));
      if (beforeSig.trim()) params.set("before", beforeSig.trim());
      return `/api/debug/sweep-relayer-empties?${params.toString()}`;
    };
  }, [limit, include2022, timeoutMs, sigLimit, maxDays, maxPairs, beforeSig]);

  function pushLog(line: string) {
    setLogLines((prev) => {
      const next = [...prev, line];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }

  function buildHeaders() {
    // IMPORTANT:
    // Cloudflare/WAF rules often block browser requests that include an "Authorization" header
    // (even if same-origin). To avoid CF false positives, we only send x-admin-secret.
    // The API route still supports Authorization: Bearer <secret> for non-browser usage.
    return {
      "x-admin-secret": secret,
    } as Record<string, string>;
  }

  async function runStream(isDry: boolean) {
    setLoading(true);
    setResult(null);
    setPhase("");
    setProgressText("");
    setProgressPct(null);
    setLogLines([]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch(buildEndpoint(isDry, true), {
        method: "GET",
        headers: buildHeaders(),
        cache: "no-store",
        credentials: "include", // ensure cf_clearance and same-site cookies are sent
        signal: ac.signal,
      });

      // If Cloudflare blocks, it often returns HTML. Surface that clearly.
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok) {
        const text = await res.text();
        const preview = text.slice(0, 800);
        setResult({
          ok: false,
          error: `HTTP ${res.status}: ${contentType.includes("text/html") ? "Cloudflare/WAF HTML block page" : preview}`,
        });
        pushLog(`HTTP ${res.status} content-type=${contentType}`);
        if (contentType.includes("text/html")) {
          pushLog(preview);
        }
        return;
      }

      if (!res.body) {
        setResult({ ok: false, error: "No response body (stream unavailable)" });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);

          if (!line) continue;

          let evt: StreamLine | null = null;
          try {
            evt = JSON.parse(line);
          } catch {
            pushLog(`(non-json) ${line.slice(0, 160)}`);
            continue;
          }

          if (!evt) continue;

          if (evt.type === "start") {
            setPhase("starting");
            pushLog(
              `start relayer=${evt.relayer} program=${evt.programId} dry=${evt.dry} sigLimit=${evt.sigLimit} maxDays=${evt.maxDays} include2022=${evt.include2022} timeoutMs=${evt.timeoutMs}`
            );
            continue;
          }

          if (evt.type === "phase") {
            setPhase(evt.name);
            pushLog(`phase: ${evt.name}`);
            continue;
          }

          if (evt.type === "progress") {
            const pct = evt.total > 0 ? Math.round((evt.scanned / evt.total) * 100) : null;
            setProgressPct(pct);
            setProgressText(
              `${evt.program}: scanned ${evt.scanned}/${evt.total} • found ${evt.found} • ${Math.round(evt.elapsedMs / 1000)}s`
            );
            if (evt.scanned % 500 === 0 || evt.found % 10 === 0) {
              pushLog(`progress ${evt.program}: ${evt.scanned}/${evt.total} found=${evt.found} (${Math.round(evt.elapsedMs / 1000)}s)`);
            }
            continue;
          }

          if (evt.type === "done") {
            pushLog(`done found=${evt.found}`);
            setPhase("done");
            setProgressPct(100);
            setProgressText(`Done. Found ${evt.found}.`);
            setResult({
              ok: true,
              dry: evt.dry,
              relayer: evt.stats?.relayer ?? "",
              programId: evt.stats?.programId ?? "",
              found: evt.found,
              candidates: evt.candidates,
              stats: evt.stats,
            } as any);
            return;
          }

          if (evt.type === "error") {
            pushLog(`error ${evt.status}: ${evt.error}`);
            setPhase("error");
            setResult({ ok: false, error: evt.error });
            return;
          }
        }
      }

      setResult({ ok: false, error: "Stream ended unexpectedly (no done/error event)." });
    } catch (e: any) {
      if (String(e?.name || "").toLowerCase().includes("abort")) {
        setResult({ ok: false, error: "Aborted." });
      } else {
        setResult({ ok: false, error: String(e?.message || e) });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  async function runJson(isDry: boolean) {
    setLoading(true);
    setResult(null);
    setPhase("");
    setProgressText("");
    setProgressPct(null);
    setLogLines([]);

    try {
      const res = await fetch(buildEndpoint(isDry, false), {
        method: "GET",
        headers: buildHeaders(),
        cache: "no-store",
        credentials: "include",
      });

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: `Non-JSON response: ${text.slice(0, 800)}` };
      }
      setResult(data as ApiResult);
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  function stop() {
    try {
      abortRef.current?.abort();
    } catch {
      // ignore
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-6 text-black bg-white">
      <h1 className="text-2xl font-semibold">Relayer Rent Sweep (One-Time)</h1>

      <p className="mt-2 text-sm text-neutral-700">
        Scans recent relayer-signed transactions to discover EC-PDA swap authorities, then finds empty EC-PDA token
        accounts (bins) and optionally closes them on-chain via <code>sweep_ec_pda_bins</code>.
      </p>

      <div className="mt-6 rounded-xl border border-neutral-200 p-4 bg-white text-black">
        <label className="block text-sm font-medium text-black">Admin Secret</label>

        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="ADMIN_SWEEP_SECRET"
          autoComplete="off"
          className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2
                     text-sm text-black bg-white placeholder:text-neutral-500
                     focus:outline-none focus:ring-2 focus:ring-black"
        />

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-black">Limit</label>
            <input
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2
                         text-sm text-black bg-white
                         focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-black">Timeout (ms)</label>
            <input
              type="number"
              min={2000}
              max={120000}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2
                         text-sm text-black bg-white
                         focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>

          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 text-sm text-black">
              <input
                type="checkbox"
                checked={include2022}
                onChange={(e) => setInclude2022(e.target.checked)}
              />
              Include Token-2022
            </label>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-black">Signature scan limit</label>
            <input
              type="number"
              min={50}
              max={10000}
              value={sigLimit}
              onChange={(e) => setSigLimit(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2
                         text-sm text-black bg-white
                         focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-black">Max days back</label>
            <input
              type="number"
              min={1}
              max={365}
              value={maxDays}
              onChange={(e) => setMaxDays(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2
                         text-sm text-black bg-white
                         focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-black">Before signature (pagination)</label>
            <input
              type="text"
              value={beforeSig}
              onChange={(e) => setBeforeSig(e.target.value)}
              placeholder="(optional) paste a signature to continue scanning older history"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2
                         text-sm text-black bg-white
                         focus:outline-none focus:ring-2 focus:ring-black"
            />
            <p className="mt-1 text-xs text-neutral-600">
              Tip: run a scan, then click “Use nextBefore” to step back in time without rescanning the same period.
            </p>
          </div>


          <div>
            <label className="block text-sm font-medium text-black">Max vault+nonce pairs</label>
            <input
              type="number"
              min={5}
              max={10000}
              value={maxPairs}
              onChange={(e) => setMaxPairs(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2
                         text-sm text-black bg-white
                         focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => runStream(true)}
              disabled={loading || !secret}
              className="w-full rounded-md border border-black bg-white px-3 py-2 text-sm font-medium
                         text-black hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Running…" : "Dry Run (Live)"}
            </button>
          </div>

          <div className="flex items-end">
            <button
              type="button"
              onClick={() => runStream(false)}
              disabled={loading || !secret}
              className="w-full rounded-md bg-black px-3 py-2 text-sm font-medium
                         text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Running…" : "Close (Live)"}
            </button>
          </div>

          <div className="flex items-end">
            <button
              type="button"
              onClick={stop}
              disabled={!loading}
              className="w-full rounded-md border border-neutral-400 bg-white px-3 py-2 text-sm font-medium
                         text-black hover:opacity-90 disabled:opacity-50"
            >
              Stop
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between text-sm text-neutral-700">
          <div>
            <span className="font-medium text-black">Phase:</span> {phase || "—"}
          </div>
          <div>
            <span className="font-medium text-black">Progress:</span>{" "}
            {progressPct == null ? "—" : `${progressPct}%`}{" "}
            {progressText ? `• ${progressText}` : ""}
          </div>
        </div>

        <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3">
          <div className="text-xs font-semibold text-neutral-700">Live log</div>
          <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap text-xs text-black">
            {logLines.length ? logLines.join("\n") : "No events yet…"}
          </pre>
        </div>

        <div className="mt-3 text-xs text-neutral-500">
          If you prefer non-stream JSON (single response), you can use the JSON buttons:
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => runJson(true)}
              disabled={loading || !secret}
              className="rounded-md border border-neutral-400 bg-white px-3 py-2 text-xs font-medium text-black disabled:opacity-50"
            >
              Dry Run (JSON)
            </button>
            <button
              type="button"
              onClick={() => runJson(false)}
              disabled={loading || !secret}
              className="rounded-md border border-neutral-400 bg-white px-3 py-2 text-xs font-medium text-black disabled:opacity-50"
            >
              Close (JSON)
            </button>
          </div>
          {(result as any)?.stats?.nextBefore ? (
            <div className="mt-2 flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBeforeSig(String((result as any).stats.nextBefore || ""))}
                  disabled={loading}
                  className="rounded-md border border-neutral-400 bg-white px-2 py-1 text-[11px] font-medium text-black disabled:opacity-50"
                >
                  Use nextBefore
                </button>
                <span className="text-[11px] text-neutral-600">
                  Continue older history (pagination) using the nextBefore cursor from the last scan.
                </span>
              </div>
              <div className="text-[11px] text-neutral-600 break-all">
                <span className="font-medium text-black">nextBefore:</span>{" "}
                {String((result as any).stats.nextBefore)}
              </div>
              {(result as any)?.stats?.windowStartAt ? (
                <div className="text-[11px] text-neutral-600">
                  <span className="font-medium text-black">Window:</span>{" "}
                  {String((result as any).stats.windowStartAt)} → {String((result as any).stats.windowEndAt || "")}
                </div>
              ) : null}
            </div>
          ) : null}

        </div>
      </div>

      {result && (
        <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-4 text-black">
          <div className="flex flex-col gap-2">
            <div className="text-sm font-semibold">{result.ok ? "Result" : "Error"}</div>

            {(() => {
              const closed = (result as any).closed ?? (result as any).stats?.closed ?? 0;
              const txs = (result as any).txs ?? (result as any).stats?.txs ?? ((result as any).sigs?.length || 0);
              const failed =
                (result as any).stats?.failedTxs ??
                ((result as any).txResults?.filter((t: any) => t && t.ok === false).length || 0);

              return (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={
                      "rounded-full px-2 py-1 " +
                      (closed > 0 ? "bg-green-100 text-green-900" : "bg-neutral-100 text-neutral-800")
                    }
                  >
                    Closed: {closed}
                  </span>
                  <span className="rounded-full bg-neutral-100 px-2 py-1 text-neutral-800">Txs: {txs}</span>
                  {failed > 0 ? (
                    <span className="rounded-full bg-red-100 px-2 py-1 text-red-900">Failed: {failed}</span>
                  ) : null}
                  {(result as any).stats?.stopReason ? (
                    <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">
                      {(result as any).stats.stopReason}
                    </span>
                  ) : null}
                </div>
              );
            })()}

            {Array.isArray((result as any).sigs) && (result as any).sigs.length ? (
              <div className="text-xs text-neutral-800">
                <div className="font-semibold">Signatures</div>
                <div className="mt-1 flex max-h-32 flex-col gap-1 overflow-auto">
                  {(result as any).sigs.slice(0, 50).map((s: string) => (
                    <a
                      key={s}
                      className="break-all text-blue-700 underline"
                      href={`https://solscan.io/tx/${s}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s}
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <pre className="mt-3 max-h-[520px] overflow-auto whitespace-pre-wrap text-xs text-black">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </main>
  );
}
