// filepath: src/lib/usePrices.ts
"use client";

import * as React from "react";
import { usePollingGate } from "@/lib/useActivityGate";

export type PriceMap = Record<string, number>;

function uniq(arr: string[]): string[] {
  const s = new Set<string>();
  const out: string[] = [];
  for (const v of arr || []) {
    const t = (v || "").trim();
    if (!t || s.has(t)) continue;
    s.add(t);
    out.push(t);
  }
  return out;
}

function isAbortLike(err: any): boolean {
  if (!err) return false;
  const name = (err as any)?.name || "";
  const code = (err as any)?.code;
  const msg = String((err as any)?.message || err || "");
  if (name === "AbortError" || code === 20) return true;
  if (/AbortError|operation was aborted|signal was aborted/i.test(msg)) return true;
  const cause: any = (err as any)?.cause;
  if (cause && (cause.name === "AbortError" || /AbortError/i.test(String(cause.message || "")))) return true;
  return false;
}

export function usePrices(mintsInput: string[] | null | undefined, refreshMs: number = 10_000) {
  const { shouldPoll } = usePollingGate();
  // Stable string key (join is ~5x faster than JSON.stringify for string arrays)
  const _mintsKey = (mintsInput || []).filter(Boolean).join("\0");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mints = React.useMemo(() => uniq(mintsInput || []), [_mintsKey]);
  const [data, setData] = React.useState<PriceMap>({});
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const load = React.useCallback(async () => {
    if (!mints.length) { setData({}); setError(null); return; }
    // cancel any in-flight
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const url = `/api/prices?mints=${encodeURIComponent(mints.join(","))}`;
      // Allow browser/CDN caching (ETag + Cache-Control) from /api/prices.
      // We still poll, but we want revalidation/edge caching instead of forcing origin hits.
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json().catch(() => ({} as any));
      const map: PriceMap = (j?.data || j?.prices || {}) || {};
      const out: PriceMap = {};
      for (const [k,v] of Object.entries(map)) {
        const n = Number(v);
        if (Number.isFinite(n)) out[k] = n;
      }
      setData(out);
    } catch (e:any) {
      if (isAbortLike(e)) return; // ignore
      setError(String(e?.message || e));
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setLoading(false);
    }
  }, [mints]);

  React.useEffect(() => {
    let id: number | null = null;
    const start = () => {
      if (!shouldPoll) return;
      // initial load immediately
      load().catch(() => {});
      if (refreshMs > 0) {
        id = window.setInterval(() => { load().catch(() => {}); }, refreshMs);
      }
    };
    start();
    return () => { if (id) window.clearInterval(id); };
  }, [load, refreshMs, shouldPoll]);

  // refresh on window focus
  React.useEffect(() => {
    const fn = () => { load().catch(() => {}); };
    window.addEventListener("focus", fn);
    return () => window.removeEventListener("focus", fn);
  }, [load]);

  return { data, loading, error, reload: load };
}
