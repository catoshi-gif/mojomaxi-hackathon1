// FULL FILE REPLACEMENT for: src/app/webhooks/_components/ActivityPanel.tsx
"use client";

// Disable client equity fetch fallback in Activity Panel (freeze totals as provided by server)
const DISABLE_ACTIVITY_PANEL_EQUITY_FETCH = true;

// Force hydration as the only source of rebalance totals (no local fallback)
const USE_LOCAL_DERIVED_TOTALS = false;

/**
 * ActivityPanel — preserved UI with safe, throttled hydration.
 *
 * This file fixes a Vercel build error caused by a duplicate constant declaration
 * while keeping the intended behavior:
 *  - NEVER show SWAP_REBALANCE leg events in the Activity panel.
 *  - ONLY show aggregated REBALANCE events (after all legs are completed).
 *  - Keep rebalance totals frozen; do not overwrite with live equity.
 *  - Preserve UI/UX exactly.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { sumRebalanceVolumeUsd } from "@/lib/rebalanceMath";
import { Card, CardContent } from "@/components/ui/card";
import Image from "next/image";
import { useWallet } from "@solana/wallet-adapter-react";
import { formatUsdUnitDynamic as fmtUsdUnit } from "@/lib/formatUsd";
import { usePageVisible } from "@/lib/usePageVisible";
import { useInactivity, withJitterMs } from "@/lib/useActivityGate";

type AnyObj = Record<string, any>;

type RebalancePair = {
  inMint?: string | null;
  outMint?: string | null;
  inSymbol?: string | null;
  outSymbol?: string | null;
  inputSymbol?: string | null;
  outputSymbol?: string | null;
  inTotalUsd?: number | null;
  outTotalUsd?: number | null;
  usdIn?: number | null;
  usdOut?: number | null;
  amountInUi?: number | null;
  amountOutUi?: number | null;
  inUsdPrice?: number | null;
  outUsdPrice?: number | null;
  txUrl?: string | null;
};

type EventRow = {
  id?: string;
  setId?: string;
  ts?: number;
  kind?: string;
  direction?: "BUY" | "SELL" | string;
  ok?: boolean | null;
  txUrl?: string | null;
  txUrls?: string[] | null;
  source?: "tradingview" | "mojomaxi" | string | null;

  // trade fields
  runId?: string | null;
  inSymbol?: string | null;
  outSymbol?: string | null;
  inputSymbol?: string | null;
  outputSymbol?: string | null;
  inputMint?: string | null;
  outputMint?: string | null;
  amountInUi?: number | null;
  amountOutUi?: number | null;
  inAmount?: number | null;
  outAmount?: number | null;
  inUsdPrice?: number | null;
  outUsdPrice?: number | null;
  unitPriceUsd?: number | null;
  inTotalUsd?: number | null;
  outTotalUsd?: number | null;
  usdIn?: number | null;
  usdOut?: number | null;

  // Optional extra fields
  headlineCompact?: string | null;
  pnlUsd?: number | null;
  pnlPct?: number | null;

  // For REBALANCE summary rows:
  rebalancePairs?: Array<RebalancePair>;
  totalUsd?: number | null;
  lastTotalUsd?: number | null;
  aggregated?: boolean;
  volumeUsd?: number | null;
};

type Props = { setId?: string; wallet?: string; limit?: number };

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function fmtNum(n: number | null | undefined, maxFrac = 6) {
  if (!(typeof n === "number" && Number.isFinite(n))) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 100000 ? 0 : abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.min(digits, maxFrac) });
}

function fmtUsd(n: number | null | undefined) {
  if (!(typeof n === "number" && Number.isFinite(n))) return "";
  return fmtUsdUnit(n);
}

function fmtUsd2(n: number | null | undefined) {
  if (!(typeof n === "number" && Number.isFinite(n))) return "$—";
  const p = Number(n);
  return p.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtTime(ts?: number) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

// "Weak" symbol heuristic — looks like a mint prefix or non-standard symbol
function isWeakSymbol(sym?: string | null, mint?: string | null) {
  if (!sym) return true;
  const s = String(sym).trim();
  if (!s) return true;
  const base58ish = /^[1-9A-HJ-NP-Za-km-z]{3,5}$/.test(s);
  const tooShort = s.length <= 4;
  const mintPrefix = (mint || "").slice(0, 4);
  const equalsMintPrefix = mintPrefix && s === mintPrefix;
  const hasLower = /[a-z]/.test(s);
  const strongWhen = /^[A-Z][A-Z0-9]{2,}$/.test(s);
  return !strongWhen || base58ish || tooShort || Boolean(equalsMintPrefix) || hasLower;
}

function tokenSide(qty: number | null | undefined, sym: string | null | undefined, priceUsd?: number | null) {
  const q = typeof qty === "number" && isFinite(qty) ? qty : null;
  const s = sym || "";
  const p = typeof priceUsd === "number" && isFinite(priceUsd) ? priceUsd : null;
  if (q == null) return s ? s : "";
  let priceStr = "";
  if (p != null) {
    const SU = String(s || "").toUpperCase();
    if (SU === "USDC" || SU === "USDT" || SU === "PYUSD") {
      priceStr = fmtUsd2(p);
    } else {
      priceStr = fmtUsd(p);
    }
  }
  const right = p != null ? ` @ ${priceStr}` : "";
  return `${fmtNum(q)} ${s}${right}`;
}

function moneySideUSD(usd: number | null | undefined, sym?: string | null | undefined) {
  const u = typeof usd === "number" && isFinite(usd) ? usd : null;
  const s = sym || "";
  return u != null ? `${fmtUsd(u)}${s ? ` ${s}` : ""}` : "";
}

function tryInjectedWallet(): string {
  try {
    const g: any = globalThis as any;
    const providers = [g?.solana, g?.phantom?.solana, g?.backpack?.solana, g?.solflare, g?.solflare?.solana].filter(Boolean);
    for (const p of providers) {
      const pk = p?.publicKey?.toBase58?.() || p?.publicKey?.toString?.();
      if (typeof pk === "string" && pk.length > 0) return pk;
    }
  } catch {}
  return "";
}

// Single declaration used across filtering/grouping steps
const REBALANCE_WINDOW_MS = 3 * 60_000;

export default function ActivityPanel({ setId, wallet: walletProp, limit = 200 }: Props) {
  const { publicKey } = useWallet();
  const keyFromAdapter = (publicKey as any)?.toBase58?.() || (publicKey as any)?.toString?.();
  const wallet = walletProp || keyFromAdapter || tryInjectedWallet() || undefined;

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [rowsDisplay, setRowsDisplay] = useState<EventRow[]>([]);

  // Pagination (client-only; panel-only refresh)
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  const [fetchLimit, setFetchLimit] = useState<number>(Math.max(limit ?? 200, PAGE_SIZE));

  const totalPages = Math.max(1, Math.ceil(rowsDisplay.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;
  const pageRows = useMemo(() => rowsDisplay.slice(pageStart, pageEnd), [rowsDisplay, pageStart, pageEnd]);

  // Grow fetch limit when displayed rows are insufficient (accounts for aggregation)
  useEffect(() => {
    const need = page * PAGE_SIZE;
    const have = rowsDisplay.length;
    const maxLimit = 200; // API clamp (existing behavior on backend)
    if (have < need && fetchLimit < Math.min(maxLimit, need)) {
      // Bump by at least one page to avoid multiple quick refetches
      setFetchLimit(Math.min(maxLimit, Math.max(need, fetchLimit + PAGE_SIZE)));
    }
  }, [page, rowsDisplay.length, fetchLimit]);

  // Build query (unchanged behavior; uses fetchLimit for pagination)
  const query = useMemo(() => {
    const s = new URLSearchParams();
    if (setId) s.set("setId", setId);
    else if (wallet) s.set("wallet", wallet);
    s.set("limit", String(fetchLimit));
    return s;
  }, [setId, wallet, fetchLimit]);
const makeEventKey = (e: any) => {
  const ts = Number(e?.ts ?? e?.t ?? 0) || 0;
  const sig =
    String(e?.signature || e?.sig || e?.txid || e?.tx || e?.txSig || "")
      .trim();
  const kind = String(e?.kind || e?.type || "");
  const dir = String(e?.direction || e?.side || "");
  const inMint = String(e?.inputMint || e?.inMint || "");
  const outMint = String(e?.outputMint || e?.outMint || "");
  const ain = String(e?.amountIn ?? e?.inAmount ?? "");
  const aout = String(e?.amountOut ?? e?.outAmount ?? "");
  // Prefer explicit ids when available; otherwise build a stable-ish composite.
  return String(e?.id || e?._id || "") || `${ts}|${kind}|${dir}|${sig}|${inMint}|${outMint}|${ain}|${aout}`;
};

const mergeEvents = (prev: AnyObj[], incoming: AnyObj[], max: number) => {
  if (!incoming?.length) return prev;
  const seen = new Set<string>();
  const out: AnyObj[] = [];
  // Incoming first (newest first expected), then previous
  for (const e of [...incoming, ...prev]) {
    const k = makeEventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
};


  // Light visibility/idle-gated polling (no UI change)
  const visible = usePageVisible();
  const { idle } = useInactivity(60_000);
  const [pollTick, setPollTick] = useState(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Phase 1 perf: delta polling + ETag. Keeps UI identical but reduces payload/CPU.
  const cursorTsRef = useRef<number>(0);
  const etagRef = useRef<string>("");

  useEffect(() => {
    // Reset cursor/etag when scope changes
    cursorTsRef.current = 0;
    etagRef.current = "";
  }, [setId, wallet]);

  useEffect(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current as any);
      pollingRef.current = null;
    }
    if (visible && !idle) {
      pollingRef.current = setInterval(() => {
        setPollTick((t) => (t + 1) % 1_000_000);
      }, withJitterMs(12_000, 0.2));
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current as any);
        pollingRef.current = null;
      }
    };
  }, [visible, idle]);

  // Fetch events
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const q = new URLSearchParams(query.toString());
// Delta poll: ask only for events newer than our last cursor.
if (cursorTsRef.current > 0) q.set("sinceTs", String(cursorTsRef.current));
const url = `/api/events/recent?${q.toString()}`;
let r: Response;
try {
  r = await fetch(url, {
    cache: "no-store",
    headers: etagRef.current ? { "if-none-match": etagRef.current } : undefined,
  });
}
        catch (e) {
          r = new Response("{}", { status: 200, headers: new Headers({ "content-type": "application/json" }) });
        }
        if (r.status === 304) {
  // No changes; keep current rows.
  return;
}
// Track server etag for next poll (best-effort)
const newEtag = r.headers.get("etag");
if (newEtag) etagRef.current = newEtag;

const j = await r.json().catch(() => ({}));
if (!cancelled) {
  const events = Array.isArray(j?.events) ? (j.events as AnyObj[]) : [];
  // Advance cursor to the latest timestamp the server knows about (best-effort).
  const serverCursor =
    Number(j?.cursorTs ?? j?.cursor ?? 0) ||
    Math.max(
      0,
      ...events
        .map((e: any) => Number(e?.ts ?? e?.t ?? 0))
        .filter((n: any) => Number.isFinite(n))
    );
  if (serverCursor > 0) cursorTsRef.current = Math.max(cursorTsRef.current, serverCursor);

  const mode = String(j?.mode || "");
  if (mode === "delta" && cursorTsRef.current > 0) {
    setRows((prev) => mergeEvents(prev as any, events as any, fetchLimit) as any);
  } else {
    setRows(events as EventRow[]);
  }
}
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, pollTick]);

  // Normalize and filter rows; aggregate rebalance events; hide legs
  useEffect(() => {
    // 1) Normalize each event with symbol aliasing and frozen USD preference.
    const norm: EventRow[] = rows.map((e) => {
      const dir = String((e?.direction || "") as any).toUpperCase() as "BUY" | "SELL" | string;

      // Symbol aliasing
      const inSym = (e?.inSymbol || e?.inputSymbol || null) as string | null;
      const outSym = (e?.outSymbol || e?.outputSymbol || null) as string | null;

      const inAmt = Number((e as any)?.amountInUi ?? (e as any)?.inAmount ?? Number.NaN);
      const outAmt = Number((e as any)?.amountOutUi ?? (e as any)?.outAmount ?? Number.NaN);

      // Prefer frozen USD totals if present
      const usdIn_frozen = ((): number | null => {
        const a = (e as any)?.inTotalUsd;
        const b = (e as any)?.usdIn;
        return typeof a === "number" && isFinite(a) ? a : (typeof b === "number" && isFinite(b) ? b : null);
      })();
      const usdOut_frozen = ((): number | null => {
        const a = (e as any)?.outTotalUsd;
        const b = (e as any)?.usdOut;
        return typeof a === "number" && isFinite(a) ? a : (typeof b === "number" && isFinite(b) ? b : null);
      })();

      let unitPriceUsd: number | null = null;
      if (typeof (e as any)?.unitPriceUsd === "number" && isFinite((e as any).unitPriceUsd)) {
        unitPriceUsd = Number((e as any).unitPriceUsd);
      } else if (dir === "BUY" && outAmt && usdIn_frozen != null) {
        unitPriceUsd = usdIn_frozen / outAmt;
      } else if (dir === "SELL" && inAmt && usdOut_frozen != null) {
        unitPriceUsd = usdOut_frozen / inAmt;
      }

      // Ensure a single txUrl is present for link display
      const __txLegacy = (e as any)?.tx || (e as any)?.signature || (e as any)?.sig || (e as any)?.txSig || (e as any)?.transaction || (e as any)?.transactionHash || (e as any)?.hash || (e as any)?.txid || null;
      const __txUrl = ((): string | undefined => {
        const u = (e as any)?.txUrl;
        if (typeof u === "string" && u) return u;
        if (typeof __txLegacy === "string" && __txLegacy) return `https://solscan.io/tx/${__txLegacy}`;
        return undefined;
      })();

      const out: EventRow = {
        ...e,
        direction: dir,
        inSymbol: inSym ?? undefined,
        outSymbol: outSym ?? undefined,
        usdIn: usdIn_frozen ?? undefined,
        usdOut: usdOut_frozen ?? undefined,
        txUrl: __txUrl ?? (e as any)?.txUrl ?? undefined,
        unitPriceUsd: unitPriceUsd ?? undefined,
      };

      // Passthrough frozen totals and related fields if present (do not drop them)
      const passthrough: any = {};
      if ((e as any)?.totalUsd != null) passthrough.totalUsd = (e as any).totalUsd;
      if ((e as any)?.lastTotalUsd != null) passthrough.lastTotalUsd = (e as any).lastTotalUsd;
      if ((e as any)?.totalsUsdByMint && typeof (e as any).totalsUsdByMint === 'object') passthrough.totalsUsdByMint = (e as any).totalsUsdByMint;
      if ((e as any)?.totalsUiByMint && typeof (e as any).totalsUiByMint === 'object') passthrough.totalsUiByMint = (e as any).totalsUiByMint;
      if (Array.isArray((e as any)?.txUrls)) passthrough.txUrls = (e as any).txUrls;
      if (Array.isArray((e as any)?.rebalancePairs)) passthrough.rebalancePairs = (e as any).rebalancePairs;
      if ((e as any)?.aggregated != null) passthrough.aggregated = Boolean((e as any).aggregated);
      return { ...out, ...passthrough };
    });

    // 2) Collapse rapid BUY/SELL duplicates (merge webhook+executor legs within 20s per set+pair).
    const BUYSELL_WINDOW_MS = 20_000;
    const sortedForDedup = [...norm].sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
    const makeKey = (e: EventRow) => {
      const set = String(e?.setId || "");
      const d = String(e?.direction || "");
      const a = String((e as any)?.inMint || (e as any)?.inputMint || (e as any)?.inSymbol || "");
      const b = String((e as any)?.outMint || (e as any)?.outputMint || (e as any)?.outSymbol || "");
      return `${set}|${d}|${a}->${b}`;
    };
    const byKey: Record<string, EventRow> = {};
    const collapsed: EventRow[] = [];
    for (const e of sortedForDedup) {
      const k = makeKey(e);
      const prev = byKey[k];
      const dir = String((e?.direction || "")).toUpperCase();
      const isBuySell = dir === "BUY" || dir === "SELL";
      if (prev && isBuySell && Math.abs(Number(e?.ts || 0) - Number(prev?.ts || 0)) <= BUYSELL_WINDOW_MS) {
        const txs = new Set<string>();
        if (Array.isArray(prev.txUrls)) prev.txUrls.forEach((u) => u && txs.add(u));
        if (prev.txUrl) txs.add(prev.txUrl);
        if (Array.isArray(e.txUrls)) e.txUrls.forEach((u) => u && txs.add(u));
        if (e.txUrl) txs.add(e.txUrl);
        byKey[k] = {
          ...prev,
          ...e,
          ts: Math.max(Number(prev?.ts || 0), Number(e?.ts || 0)),
          source: prev?.source === "tradingview" || e?.source === "tradingview" ? "tradingview" : (e?.source || prev?.source || null),
          txUrl: txs.size ? Array.from(txs)[0] : undefined,
          txUrls: txs.size ? Array.from(txs) : undefined,
        };
      } else {
        if (prev) collapsed.push(prev);
        byKey[k] = e;
      }
    }
    const normAll: EventRow[] = [...collapsed, ...Object.values(byKey)];

    // 3) HIDE all rebalance leg events; keep ONLY aggregated summaries.
    const filtered = normAll.filter((row) => {
      const kind = String(row?.kind || "").toUpperCase();
      if (kind === "SWAP_REBALANCE") return false; // product requirement: never show legs
      if (kind === "FIRST_REBALANCE_EQUITY" || kind === "REBALANCE_BASELINE") return false; // hide baseline snapshot events (internal)
      if (kind !== "REBALANCE") return true;
      const aggregated = !!(row as any)?.aggregated;
      const hasPairs = Array.isArray((row as any)?.rebalancePairs) && (row as any).rebalancePairs.length > 0;
      const hasUrls = Array.isArray((row as any)?.txUrls) && (row as any).txUrls.length > 0;
      return (hasPairs || hasUrls);  // hide empty aggregated placeholder rows
    });

    // 3b) Drop weak duplicate REBALANCE rows that have no txs/pairs if a stronger one exists for same run (by runId/nonce) or bucket.
    const strongKeys = new Set<string>();
    const buckets = new Set<string>();
    for (const r of filtered) {
      if (String(r?.kind || "").toUpperCase() !== "REBALANCE") continue;
      const sid = String(r?.setId || "");
      const runId = typeof (r as any)?.runId === "string" ? (r as any).runId : "";
      const nonce = String((r as any)?.rebalanceNonce || (r as any)?.swapNonce || (r as any)?.nonce || "");
      const key = runId ? `${sid}|${runId}` : (nonce ? `${sid}|nonce:${nonce}` : "");
      if (key) strongKeys.add(key);
      const b = `${sid}|${Math.floor(Number(r?.ts || 0) / REBALANCE_WINDOW_MS)}`;
      buckets.add(b);
    }
    const filtered2 = filtered.filter((r) => {
      if (String(r?.kind || "").toUpperCase() !== "REBALANCE") return true;
      const sid = String(r?.setId || "");
      const runId = typeof (r as any)?.runId === "string" ? (r as any).runId : "";
      const nonce = String((r as any)?.rebalanceNonce || (r as any)?.swapNonce || (r as any)?.nonce || "");
      const key = runId ? `${sid}|${runId}` : (nonce ? `${sid}|nonce:${nonce}` : "");
      const aggregated = !!(r as any)?.aggregated;
      const hasPairs = Array.isArray((r as any)?.rebalancePairs) && (r as any).rebalancePairs.length > 0;
      const hasUrls = Array.isArray((r as any)?.txUrls) && (r as any).txUrls.length > 0;
      if (!key && aggregated && !hasPairs && !hasUrls) {
        const b = `${sid}|${Math.floor(Number(r?.ts || 0) / REBALANCE_WINDOW_MS)}`;
        if (strongKeys.has(`${sid}|${runId}`) || strongKeys.has(`${sid}|nonce:${nonce}`) || buckets.has(b)) {
          return false;
        }
      }
      return true;
    });

    // 4) Collapse duplicate REBALANCE rows per runId or time bucket, keep the most "final".
    const rebGroups: Record<string, EventRow[]> = {};
    for (const r of filtered2) {
      if (String(r?.kind || "").toUpperCase() !== "REBALANCE") continue;
      const sid = String(r?.setId || "");
      const runId = typeof (r as any)?.runId === "string" ? (r as any).runId : "";
      const nonce = String((r as any)?.rebalanceNonce || (r as any)?.swapNonce || (r as any)?.nonce || "");
      const keyPart = runId ? runId : (nonce ? `nonce:${nonce}` : `${Math.floor(Number(r?.ts || 0) / REBALANCE_WINDOW_MS)}`);
      const key = `${sid}|${keyPart}`;
      (rebGroups[key] ||= []).push(r);
    }

    const merged2: EventRow[] = [];
    const computeVolumeForRow = (row: EventRow): number | undefined => {
      try {
        const legs = (row as any)?.legs || (row as any)?.rebalanceLegs;
        if (Array.isArray(legs) && legs.length) {
          try {
            const vol = sumRebalanceVolumeUsd(legs as any, undefined, { preferLegExecutionPrices: true });
            if (typeof vol === "number" && Number.isFinite(vol)) return vol;
          } catch {}
        }
        const pairs = Array.isArray((row as any)?.rebalancePairs) ? (row as any).rebalancePairs : [];
        if (Array.isArray(pairs) && pairs.length) {
          const vol = pairs.reduce((acc: number, p: any) => {
            const v = typeof p?.usdIn === "number" && isFinite(p.usdIn) ? Math.abs(p.usdIn) :
                      typeof p?.inTotalUsd === "number" && isFinite(p.inTotalUsd) ? Math.abs(p.inTotalUsd) :
                      typeof p?.usdOut === "number" && isFinite(p.usdOut) ? Math.abs(p.usdOut) :
                      typeof p?.outTotalUsd === "number" && isFinite(p.outTotalUsd) ? Math.abs(p.outTotalUsd) : 0;
            return acc + v;
          }, 0);
          return vol;
        }
      } catch {}
      return undefined;
    };

    const seenG = new Set<string>();
    for (const r of filtered2) {
      if (String(r?.kind || "").toUpperCase() !== "REBALANCE") { merged2.push(r); continue; }
      const sid = String(r?.setId || "");
      const bucket = Math.floor(Number(r?.ts || 0) / REBALANCE_WINDOW_MS);
      const runId = typeof (r as any)?.runId === 'string' ? (r as any).runId : '';
      const nonce = String((r as any)?.rebalanceNonce || (r as any)?.swapNonce || (r as any)?.nonce || '');
      const gk = runId ? `${sid}|${runId}` : (nonce ? `${sid}|nonce:${nonce}` : `${sid}|${bucket}`);
      if (seenG.has(gk)) continue;
      const g = rebGroups[gk] || [r];
      let pick = [...g].sort((a, b) => {
        const agA = (a as any)?.aggregated ? 1 : 0;
        const agB = (b as any)?.aggregated ? 1 : 0;
        if (agA !== agB) return agB - agA;
        const tA = Array.isArray((a as any)?.txUrls) ? ((a as any).txUrls as string[]).length : (a as any)?.txUrl ? 1 : 0;
        const tB = Array.isArray((b as any)?.txUrls) ? ((b as any).txUrls as string[]).length : (b as any)?.txUrl ? 1 : 0;
        if (tA !== tB) return tB - tA;
        return Number((b as any)?.ts || 0) - Number((a as any)?.ts || 0);
      })[0];
      if ((pick as any)?.volumeUsd == null) {
        const v = computeVolumeForRow(pick);
        if (typeof v === "number" && Number.isFinite(v)) {
          pick = { ...(pick as any), volumeUsd: v } as any;
        }
      }
      // Guard: never surface a purely-aggregated REBALANCE without txs/pairs
if (String((pick as any)?.kind || '').toUpperCase() === 'REBALANCE') {
  const hasPairs = Array.isArray((pick as any)?.rebalancePairs) && (pick as any).rebalancePairs.length > 0;
  const hasUrls  = Array.isArray((pick as any)?.txUrls) ? ((pick as any).txUrls as any[]).length > 0 : !!(pick as any)?.txUrl;
  const isAgg    = !!(pick as any)?.aggregated;
  if (isAgg && !hasPairs && !hasUrls) {
    // Skip adding this placeholder
  } else {
    merged2.push(pick);
  }
} else {
  merged2.push(pick);
}
      seenG.add(gk);
    }

    // 5) Final sort desc and commit
    merged2.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    setRowsDisplay(merged2);
  }, [rows]);

  // ---------------- Symbol Hydration (non-visual) ----------------
  const symbolCacheRef = useRef<Record<string, string>>({}); // mint -> symbol
  const symbolInflight = useRef<boolean>(false);
  const symbolCooldownUntil = useRef<number>(0);
  const SYMBOL_HYDRATE_COOLDOWN_MS = 10_000;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const now = Date.now();
        if (symbolInflight.current) return;
        if (now < symbolCooldownUntil.current) return;

        // Collect mints needing hydration
        const needed: string[] = [];
        for (const e of rowsDisplay) {
          if (String(e?.kind || "").toUpperCase() !== "REBALANCE") continue;
          const pairs = Array.isArray(e.rebalancePairs) ? e.rebalancePairs : [];
          for (const p of pairs) {
            const inWeak = isWeakSymbol(p.inSymbol ?? p.inputSymbol, p.inMint);
            const outWeak = isWeakSymbol(p.outSymbol ?? p.outputSymbol, p.outMint);
            if (inWeak && p.inMint && !symbolCacheRef.current[p.inMint]) needed.push(String(p.inMint));
            if (outWeak && p.outMint && !symbolCacheRef.current[p.outMint]) needed.push(String(p.outMint));
          }
        }
        const queryMints = Array.from(new Set(needed));
        if (!queryMints.length) return;

        symbolInflight.current = true;
        const url = `/api/tokens/meta?mints=${encodeURIComponent(queryMints.join(","))}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json().catch(() => ({}));
        const items: any[] = Array.isArray(j?.items) ? j.items : [];
        for (const it of items) {
          const mint = String(it?.mint || it?.address || "");
          let sym = String(it?.symbol || "");
          if (mint === "So11111111111111111111111111111111111111112") sym = "SOL"; // WSOL -> SOL
          if (mint && sym) symbolCacheRef.current[mint] = sym;
        }

        if (cancelled) return;

        // Patch rows only if something changed
        let changedAny = false;
        const next = rowsDisplay.map((e) => {
          if (String(e?.kind || "").toUpperCase() !== "REBALANCE" || !Array.isArray(e.rebalancePairs)) return e;
          let changedRow = false;
          const pairs = e.rebalancePairs.map((p) => {
            let inSymbol = p.inSymbol ?? p.inputSymbol ?? null;
            let outSymbol = p.outSymbol ?? p.outputSymbol ?? null;
            if (isWeakSymbol(inSymbol, p.inMint) && p.inMint && symbolCacheRef.current[p.inMint]) {
              inSymbol = symbolCacheRef.current[p.inMint];
              changedRow = true;
            }
            if (isWeakSymbol(outSymbol, p.outMint) && p.outMint && symbolCacheRef.current[p.outMint]) {
              outSymbol = symbolCacheRef.current[p.outMint];
              changedRow = true;
            }
            return changedRow ? { ...p, inSymbol, outSymbol, inputSymbol: inSymbol, outputSymbol: outSymbol } : p;
          });
          if (changedRow) {
            changedAny = true;
            return { ...e, rebalancePairs: pairs };
          }
          return e;
        });
        if (changedAny) setRowsDisplay(next);
      } catch {
        symbolCooldownUntil.current = Date.now() + SYMBOL_HYDRATE_COOLDOWN_MS;
      } finally {
        symbolInflight.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rowsDisplay]);

  // ---------------- (Disabled) Equity Hydration ----------------
  // We keep the implementation but disable it via DISABLE_ACTIVITY_PANEL_EQUITY_FETCH
  const hydrationCacheRef = useRef<Record<string, number>>({}); // key -> totalUsd
  const hydrationInflightRef = useRef<Record<string, boolean>>({});
  const hydrationCooldownUntilRef = useRef<Record<string, number>>({});
  const HYDRATE_COOLDOWN_MS = 5_000; // retry window to avoid hot loops

  const rebalanceRowKey = (r: EventRow, idx: number): string => {
    const sid = String(r?.setId || "");
    const runId = String((r as any)?.runId || "");
    const ts = Number(r?.ts || 0);
    const tx = String((r as any)?.txUrl || "");
    const id = (r as any)?.id ? String((r as any).id) : "";
    return id || `${sid}|${runId}|${ts}|${tx}|${idx}`;
  };

  const recomputePnlFromHydrated = (rowsIn: EventRow[]): EventRow[] => {
    const next = [...rowsIn];
    const bySet: Record<string, EventRow[]> = {};
    for (const r of next) {
      if (String(r?.kind || "").toUpperCase() !== "REBALANCE") continue;
      const sid = String(r?.setId || "");
      (bySet[sid] ||= []).push(r);
    }
    for (const sid of Object.keys(bySet)) {
      const arr = bySet[sid].sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
      let prevTotal: number | undefined = undefined;
      for (const r of arr) {
        const t = Number((r as any)?.totalUsd);
        const hasT = Number.isFinite(t) && t >= 0;
        const prev = prevTotal;
        if (prev != null && (r as any).lastTotalUsd !== prev) {
          (r as any).lastTotalUsd = prev;
        }
        if (prev != null && hasT && prev! > 0) {
          const diff = t - prev!;
          (r as any).pnlLastUsd = diff;
          (r as any).pnlLastPct = diff / prev!;
        }
        if (hasT) prevTotal = t;
      }
    }
    return next;
  };

  useEffect(() => {
    // When disabled, NEVER hydrate from live equity; we only show server-frozen totals.
    if (DISABLE_ACTIVITY_PANEL_EQUITY_FETCH) return;

let cancelled = false;
    const doHydrate = async () => {
      try {
        const candidates = rowsDisplay
          .map((r, idx) => ({ r, idx }))
          .filter(({ r }) => String(r?.kind || "").toUpperCase() === "REBALANCE" && !(typeof (r as any)?.totalUsd === "number" && Number.isFinite((r as any).totalUsd)));
        if (!candidates.length) return;
        let changed = false;
        const nextRows = [...rowsDisplay];
        for (const { r, idx } of candidates) {
          const key = rebalanceRowKey(r, idx);
          if (hydrationCacheRef.current[key] != null) {
            const v = hydrationCacheRef.current[key]!;
            if ((r as any).totalUsd !== v) {
              (nextRows[idx] as any) = { ...(nextRows[idx] as any), totalUsd: v };
              changed = true;
            }
            continue;
          }
          const now = Date.now();
          const cdUntil = hydrationCooldownUntilRef.current[key] || 0;
          if (now < cdUntil) continue;
          if (hydrationInflightRef.current[key]) continue;
          hydrationInflightRef.current[key] = true;
          try {
            const sid = String(r?.setId || "");
            const runId = String((r as any)?.runId || "");
            const ts = Number(r?.ts || 0);
            const wParam = wallet ? `&wallet=${encodeURIComponent(wallet)}` : "";
            const urls: string[] = [];
            if (sid && runId) urls.push(`/api/vault/equity?setId=${encodeURIComponent(sid)}${wParam}&runId=${encodeURIComponent(runId)}`);
            if (sid && ts) urls.push(`/api/vault/equity?setId=${encodeURIComponent(sid)}${wParam}&ts=${encodeURIComponent(String(ts))}`);
            if (sid && ts) urls.push(`/api/vault/equity?setId=${encodeURIComponent(sid)}${wParam}&ts=${encodeURIComponent(String(ts))}`);
            if (sid) urls.push(`/api/vault/equity?setId=${encodeURIComponent(sid)}${wParam}`);
            let hydrated: number | undefined = undefined;
            for (const u of urls) {
              try {
                const resp = await fetch(u, { cache: "no-store" });
                if (!resp.ok) continue;
                const j = await resp.json().catch(() => ({}));
                const n = Number(j?.equityUsd ?? j?.totalUsd ?? j?.equity ?? j?.value);
                if (Number.isFinite(n) && n >= 0) { hydrated = n; break; }
              } catch {}
            }
            if (hydrated != null) {
              hydrationCacheRef.current[key] = hydrated;
              if ((r as any).totalUsd !== hydrated) {
                (nextRows[idx] as any) = { ...(nextRows[idx] as any), totalUsd: hydrated };
                changed = true;
              }
            } else {
              hydrationCooldownUntilRef.current[key] = Date.now() + HYDRATE_COOLDOWN_MS;
            }
          } finally {
            hydrationInflightRef.current[key] = false;
          }
        }
        if (changed && !cancelled) {
          const recomputed = recomputePnlFromHydrated(nextRows);
          setRowsDisplay(recomputed);
        }
      } catch {}
    };
    void doHydrate();
    return () => { cancelled = true; };
  }, [rowsDisplay]);

  return (
    <Card className="bg-background/40 shadow-none">
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold">Activity</div>
          <div className="flex items-center gap-1 text-xs">
            <button
              className="px-2 py-0.5 rounded border border-border disabled:opacity-40"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="previous page"
            >
              &lt; prev
            </button>
            {(() => {
              const maxLinks = 4;
              const pagesToShow = Math.min(totalPages, maxLinks);
              const elems: React.ReactNode[] = [];
              for (let n = 1; n <= pagesToShow; n++) {
                elems.push(
                  <button
                    key={n}
                    className={cx(
                      "px-2 py-0.5 rounded border border-transparent hover:border-border",
                      n === page ? "underline font-semibold" : "opacity-80"
                    )}
                    onClick={() => setPage(n)}
                    aria-current={n === page ? "page" : undefined}
                  >
                    {n}
                  </button>
                );
              }
              if (totalPages > maxLinks) {
                elems.push(<span key="ellipsis" className="px-2 py-0.5 opacity-70">…</span>);
              }
              return elems;
            })()}
            <button
              className="px-2 py-0.5 rounded border border-border disabled:opacity-40"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label="next page"
            >
              next &gt;
            </button>
          </div>
          {loading ? <div className="text-xs text-muted-foreground">loading…</div> : null}
          <div className="text-xs text-muted-foreground">total: {rowsDisplay.length}</div>
        </div>
        <div className="space-y-3">
          {pageRows.map((e, idx) => {
            const ok = e.ok ?? true;
            const title = (() => {
              if (String(e?.kind || "").toUpperCase() === "REBALANCE") return "rebalance";
              if (String(e?.direction || "").toUpperCase() === "BUY") return "buy";
              if (String(e?.direction || "").toUpperCase() === "SELL") return "sell";
              return (e.kind || "event").toLowerCase();
            })();
            return (
              <div
                key={(e.id || idx) + String(e.ts || "")}
                className={cx(
                  "rounded-lg border border-transparent ring-1 ring-white/10 bg-background/10 p-3 transition-colors hover:bg-background/20"
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cx("h-1.5 w-1.5 rounded-full", ok ? "bg-brandMint" : "bg-brandPink")} />
                  <span
                    className={cx(
                      "text-sm font-semibold",
                      e.direction === "BUY" ? "text-brandMint" : "",
                      e.direction === "SELL" ? "text-brandPink" : ""
                    )}
                  >
                    {title}
                  </span>
                  <span className="text-muted-foreground text-[11px]">set</span>
                  <span className="font-mono text-[11px]">{e.setId?.slice(0, 8)}</span>
                  {e.source === "tradingview" ? (
                    <span className="ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none text-white/80 ring-1 ring-white/10">
                      <Image src="/brand/tradingview-96.png" alt="tradingview" width={14} height={14} />
                      tradingview
                    </span>
                  ) : null}
                  <span className="text-muted-foreground text-[11px] ml-auto flex items-center gap-2">
                    <span>{fmtTime(e.ts)}</span>
                    {Array.isArray((e as any).txUrls) && (e as any).txUrls.length > 0 ? (
                      <span className="ml-2 inline-flex flex-wrap items-center gap-1">
                        {(e as any).txUrls.map((u: string, i: number) => (
                          <a
                            key={u + i}
                            href={u}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-[10px] underline opacity-80 hover:text-foreground"
                          >
                            tx{String(i + 1)}
                          </a>
                        ))}
                      </span>
                    ) : e.txUrl ? (
                      <a href={e.txUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
                        view tx
                      </a>
                    ) : ((e as any)?.tx || (e as any)?.signature || (e as any)?.sig || (e as any)?.txSig || (e as any)?.transaction || (e as any)?.transactionHash || (e as any)?.hash || (e as any)?.txid) ? (
                      <a
                        href={`https://solscan.io/tx/${(e as any)?.tx || (e as any)?.signature || (e as any)?.sig || (e as any)?.txSig || (e as any)?.transaction || (e as any)?.transactionHash || (e as any)?.hash || (e as any)?.txid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground"
                      >
                        view tx
                      </a>
                    ) : null}
                  </span>
                </div>
                {/* Details line */}
                <div className="mt-1 text-sm">
                  {(() => {
                    const kind = String(e.kind || "").toUpperCase();
                    const dir = String(e.direction || "").toUpperCase();

                    const inAmt = Number((e as any)?.inAmount ?? (e as any)?.amountInUi ?? Number.NaN);
                    const outAmt = Number((e as any)?.outAmount ?? (e as any)?.amountOutUi ?? Number.NaN);
                    const price = typeof e.unitPriceUsd === "number" ? e.unitPriceUsd : null;

                    const inSym = e.inSymbol || (e as any)?.inputSymbol || "";
                    const outSym = e.outSymbol || (e as any)?.outputSymbol || "";

                    const usdIn =
                      typeof (e as any)?.usdIn === "number"
                        ? (e as any).usdIn
                        : typeof (e as any)?.inTotalUsd === "number"
                        ? (e as any).inTotalUsd
                        : null;
                    const usdOut =
                      typeof (e as any)?.usdOut === "number"
                        ? (e as any).usdOut
                        : typeof (e as any)?.outTotalUsd === "number"
                        ? (e as any).outTotalUsd
                        : null;

                    // Deposit/Withdraw: render single-side amount without an arrow.
                    if (kind.includes("DEPOSIT") || kind.includes("WITHDRAW")) {
                      const amt = Number.isFinite(inAmt) ? inAmt : Number.isFinite(outAmt) ? outAmt : NaN;
                      const sym = inSym || outSym;
                      const usd = usdIn ?? usdOut ?? null;
                      return (
                        <>
                          {tokenSide(amt, sym, null)} {usd != null ? <>({fmtUsd2(usd)})</> : null}
                        </>
                      );
                    }

                    if (dir === "BUY" && isFinite(inAmt)) {
                      // BUY: show Token B amount @ its market price, then ONLY Token A units acquired, and frozen USD total in parentheses.
                      const priceIn = ((): number | null => {
                        // Prefer frozen/unit price for the *input* token (Token B)
                        const p = (e as any)?.inUsdPrice;
                        if (typeof p === "number" && isFinite(p)) return p;
                        const usdInFrozen = ((): number | null => {
                          const a = (e as any)?.usdIn;
                          const b = (e as any)?.inTotalUsd;
                          return typeof a === "number" && isFinite(a) ? a : typeof b === "number" && isFinite(b) ? b : null;
                        })();
                        if (usdInFrozen != null && isFinite(inAmt) && inAmt) return usdInFrozen / inAmt;
                        const sym = String(inSym || "").toUpperCase();
                        if (sym === "USDC" || sym === "USDT" || sym === "PYUSD") return 1;
                        return null;
                      })();
                      return (
                        <>
                          {tokenSide(inAmt, inSym, priceIn)} → {tokenSide(outAmt, outSym, null)}
                          {usdIn != null ? <> ({fmtUsd2(usdIn)})</> : null}
                        </>
                      );
                    }

                    if (dir === "SELL" && isFinite(inAmt)) {
                      // SELL: existing headline + colored P+L vs previous BUY for the same set
                      const base = (
                        <>
                          {tokenSide(inAmt, inSym, price)} → {moneySideUSD(usdOut, outSym)}
                        </>
                      );
                      // Prefer server-provided P&L from backend when available
                      let pnlEl: React.ReactNode = null;
                      const serverPnlUsd = typeof (e as any)?.pnlUsd === "number" && Number.isFinite((e as any).pnlUsd) ? (e as any).pnlUsd as number : null;
                      const serverPnlPct = typeof (e as any)?.pnlPct === "number" && Number.isFinite((e as any).pnlPct) ? (e as any).pnlPct as number : null;
                      const serverPnlLastUsd =
                        typeof (e as any).pnlLastUsd === "number" && isFinite((e as any).pnlLastUsd) ? (e as any).pnlLastUsd : null;
                      const serverPnlLastPct =
                        typeof (e as any).pnlLastPct === "number" && isFinite((e as any).pnlLastPct) ? (e as any).pnlLastPct : null;
                      if (serverPnlUsd != null && serverPnlPct != null) {
                        pnlEl = (
                          <>
                            {" "}
                            <span className={(serverPnlUsd ?? 0) >= 0 ? "text-brandMint" : "text-brandPink"}>
                              P+L: {((serverPnlPct ?? 0) * 100).toFixed(2)}% ({fmtUsd2(serverPnlUsd ?? 0)})
                            </span>
                          </>
                        );
                      }
                      if (!pnlEl) {
                        try {
                          const sid = String(e.setId || "");
                          const idxSelf = pageStart + idx; // position in rowsDisplay
                          let prevBuy: any = null;
                          for (let j = idxSelf + 1; j < rowsDisplay.length; j++) {
                            const cand = rowsDisplay[j] as any;
                            if (String(cand?.setId || "") !== sid) continue;
                            if (String(cand?.direction || "").toUpperCase() !== "BUY") continue;
                            prevBuy = cand;
                            break;
                          }
                          if (prevBuy) {
                            const buyUsd = ((): number | null => {
                              const a = prevBuy?.usdIn;
                              const b = prevBuy?.inTotalUsd;
                              return typeof a === "number" && isFinite(a) ? a : typeof b === "number" && isFinite(b) ? b : null;
                            })();
                            const sellUsd = ((): number | null => {
                              const a = (e as any)?.usdOut;
                              const b = (e as any)?.outTotalUsd;
                              return typeof a === "number" && isFinite(a) ? a : typeof b === "number" && isFinite(b) ? b : null;
                            })();
                            if (buyUsd != null && sellUsd != null && isFinite(buyUsd) && buyUsd !== 0) {
                              const diff = sellUsd - buyUsd;
                              const pct = diff / buyUsd;
                              pnlEl = (
                                <>
                                  {" "}
                                  <span className={(diff ?? 0) >= 0 ? "text-brandMint" : "text-brandPink"}>
                                    P+L: {((pct ?? 0) * 100).toFixed(2)}% ({fmtUsd2(diff ?? 0)})
                                  </span>
                                </>
                              );
                            }
                          }
                        } catch {
                          // ignore
                        }
                      }
                      return (
                        <>
                          {base}
                          {pnlEl}
                        </>
                      );
                    }

                    if (kind === "REBALANCE") {
                      // Hydrated-only path: show frozen total (row.totalUsd) and P+L vs previous frozen total.
                      const totalForDisplay: number | null = (() => {
                        const n = Number((e as any)?.totalUsd);
                        return Number.isFinite(n) && n >= 0 ? n : null;
                      })();

                      const prevTotalExplicit: number | null = (() => {
                        const n = Number((e as any)?.lastTotalUsd);
                        return Number.isFinite(n) && n >= 0 ? n : null;
                      })();

                      // Prefer server-provided "since last rebalance" P&L when present
                      const serverPnlLastUsd =
                        typeof (e as any).pnlLastUsd === "number" && Number.isFinite((e as any).pnlLastUsd) ? (e as any).pnlLastUsd : null;
                      const serverPnlLastPct =
                        typeof (e as any).pnlLastPct === "number" && Number.isFinite((e as any).pnlLastPct) ? (e as any).pnlLastPct : null;

                      let usd: number | null = serverPnlLastUsd;
                      let pct: number | null = serverPnlLastPct;

                      if ((usd == null || !Number.isFinite(usd)) || (pct == null || !Number.isFinite(pct))) {
                        if (totalForDisplay != null && prevTotalExplicit != null && prevTotalExplicit > 0) {
                          usd = totalForDisplay - prevTotalExplicit;
                          pct = usd / prevTotalExplicit;
                        } else {
                          // Derive previous from the nearest older hydrated REBALANCE row of the same set, if visible
                          const sid = String((e as any)?.setId || "");
                          const idxSelf = pageStart + idx;
                          const curr = totalForDisplay;
                          if (curr != null) {
                            for (let j = idxSelf + 1; j < rowsDisplay.length; j++) {
                              const cand = rowsDisplay[j] as any;
                              if (String(cand?.setId || "") !== sid) continue;
                              if (String(cand?.kind || "").toUpperCase() !== "REBALANCE") continue;
                              const denom = Number(cand?.totalUsd);
                              if (Number.isFinite(denom) && denom > 0) {
                                usd = curr - denom;
                                pct = usd / denom;
                                break;
                              }
                            }
                          }
                        }
                      }

                      return (
                        <>
                          {totalForDisplay != null ? <>Total {fmtUsd(totalForDisplay)}</> : <>rebalance</>}
                          {usd != null && Number.isFinite(usd) && pct != null && Number.isFinite(pct) ? (
                            <>
                              {" "}
                              • <span className={usd >= 0 ? "text-brandMint" : "text-brandPink"}>P+L: {(pct * 100).toFixed(2)}% ({fmtUsd2(usd)})</span>
                            </>
                          ) : null}
                        </>
                      );
                    }

                    return <>{e.headlineCompact || "—"}</>;
                  })()}
                </div>
              </div>
            );
          })}
          {rowsDisplay.length === 0 && <div className="text-sm text-muted-foreground px-1">no events yet.</div>}
        </div>
      </CardContent>
    </Card>
  );
}
