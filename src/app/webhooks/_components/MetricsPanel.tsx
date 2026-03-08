'use client';

/**
 * MetricsPanel – Surgical replacement (syntax-verified)
 * - Preserves existing UI/UX
 * - Fixes earlier scoping error for `evForSetLocal` and a var name mismatch
 * - Keeps parity features:
 *   • Title recompute to avoid BASE/QUOTE placeholders
 *   • Rebalance cadence/rebalances
 *   • Equity fallback via /api/vault/equity
 *   • Runtime "Xd Yh Zm"
 *   • __hasVault set correctly so rows render
 */

import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import SharePLCardPreviewModal from '@/components/share/SharePLCardPreviewModal';
import SharePLCardButton from '@/components/share/SharePLCardButton';
import { buildPnlCardUrl } from '@/lib/pnlShare';
import { usePollingGate } from '@/lib/useActivityGate';

type AnyObj = Record<string, any>;
type VaultType = 'webhooks' | 'rebalance';
type Status = 'flat' | 'buy' | 'sell';

type Totals = {
  totalRealizedUsd: number;
  totalVolumeUsd: number;
  topTrade: { label: string; amount: number } | null;
};

type TokenMeta = {
  address?: string;
  mint?: string;
  symbol?: string;
  name?: string;
  logoURI?: string;
  decimals?: number;
};

type Row = {
  setId: string;
  type: VaultType;
  label?: string;
  displayTitle?: string;
  createdAt?: number;
  realizedUsd: number;
  currentPnlUsd: number | null;
  volumeUsd: number;
  status: Status;
  lastUpdated?: number;

  // authoritative aggregates
  aggTotalUsd?: number | null;
  aggPnlUsd?: number | null;
  aggPnlPct?: number | null;
  aggRuntimeSec?: number | null;

  // rebalance-only
  aggCadenceHours?: number | null;
  aggTotalRebalances?: number | null;

  // webhooks-only
  totalTrades?: number | null;
  successRate?: number | null;
  wins?: number | null;
  losses?: number | null;

  __hasVault?: boolean;
};

/* ------------------------------- utils ----------------------------------- */

/** Add slight jitter to polling intervals to prevent thundering-herd spikes.
 * Preserves intended cadence on average, only spreads requests in time.
 */
function withJitterMs(baseMs: number, jitterPct: number = 0.2): number {
  const base = Number(baseMs);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const pct = Math.max(0, Math.min(0.5, Number(jitterPct)));
  const delta = (Math.random() * 2 - 1) * pct; // [-pct, +pct]
  const v = Math.round(base * (1 + delta));
  return Math.max(250, v);
}



function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}
function toNum(v: unknown): number | null {
  const n = Number(v as any);
  return Number.isFinite(n) ? n : null;
}
function trimStr(s: unknown): string { return String(s ?? '').trim(); }
function upper(s: unknown): string { return String(s ?? '').toUpperCase(); }
function canon(s: unknown): string { return trimStr(s); }

function fmtUsd(n: number | null | undefined): string {
  if (!isNum(n)) return '$0.00';
  try {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    const v = Math.round(n * 100) / 100;
    return `$${v.toFixed(2)}`;
  }
}
function fmtPct(n: number | null | undefined): string {
  if (!isNum(n)) return '—';
  const v = Math.round(Number(n || 0) * 100) / 100;
  try { return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`; }
  catch { return `${v.toFixed(2)}%`; }
}
function fmtCreated(n?: number | null) {
  try { if (!n) return '—'; return new Date(n).toLocaleString(); } catch { return '—'; }
}

/** Human readable runtime: "Xd Yh Zm" (or "Xm"). */
function humanRuntime(seconds: number | null): string {
  if (!isNum(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if ((d || h) && m) parts.push(`${m}m`);
  if (!d && !h && m) return `${m}m`;
  return parts.join(' ') || '0m';
}

/* event helpers */

type AnyEvent = Record<string, any>;

/** Parity helper: find earliest starting/baseline equity USD from events (first start, not min). */
function findEarliestStartingUsdFromEvents(events: AnyEvent[]): number | null {
  try {
    const arr = Array.isArray(events) ? events : [];
    if (arr.length === 0) return null;
    // Sort chronologically (sec precision)
    const withTs = arr
      .map((e) => ({ t: readEventTsSec(e), e }))
      .filter((x) => isNum(x.t))
      .sort((a, b) => (a.t! - b.t!));
    // Walk from earliest to latest; return the FIRST baseline-equity we see.
    for (const { e } of withTs) {
      const candidates = [
        (e as any)?.startingTotalUsd, (e as any)?.startTotalUsd,
        (e as any)?.totalUsdSnapshot, (e as any)?.baselineUsd,
        (e as any)?.equityAtStart, (e as any)?.startEquity, (e as any)?.startTotal,
        (e as any)?.vaultUsdBefore, (e as any)?.totalUsdBefore, (e as any)?.equityBeforeUsd,
        (e as any)?.frozenTotalUsd, (e as any)?.frozen_equity_total, (e as any)?.frozenEquityUsd
      ];
      for (const v of candidates) {
        const n = toNum(v);
        if (isNum(n)) return n!;
      }
      // Also treat explicit FIRST_REBALANCE_EQUITY events as baseline with `totalUsdSnapshot`
      const k = String((e as any)?.kind || (e as any)?.type || '').toUpperCase();
      if (k === 'FIRST_REBALANCE_EQUITY') {
        const n = toNum((e as any)?.totalUsdSnapshot ?? (e as any)?.baselineUsd);
        if (isNum(n)) return n!;
      }
    }
    return null;
  } catch {
    return null;
  }
}
/** Latest baseline equity USD from events (START override wins, strong preference for startingTotalUsd). */
function findLatestStartingUsdFromEvents(events: AnyEvent[]): number | null {
  try {
    const arr = Array.isArray(events) ? events : [];
    if (arr.length === 0) return null;
    // Sort chronologically
    const withTs = arr
      .map((e) => ({ t: readEventTsSec(e), e }))
      .filter((x) => typeof x.t === 'number' && Number.isFinite(x.t as number))
      .sort((a, b) => (a.t! - b.t!));

    // Pass 1: strictly prefer the latest explicit 'startingTotalUsd' or 'startTotalUsd'
    for (let i = withTs.length - 1; i >= 0; i--) {
      const { e } = withTs[i];
      const c1 = (e as any)?.startingTotalUsd ?? (e as any)?.startTotalUsd;
      const n1 = Number(c1);
      if (Number.isFinite(n1)) return n1;
    }

    // Pass 2: explicit FIRST_REBALANCE_EQUITY snapshot
    for (let i = withTs.length - 1; i >= 0; i--) {
      const { e } = withTs[i];
      const kind = upper((e as any)?.kind || (e as any)?.type || (e as any)?.event);
      if (kind === 'FIRST_REBALANCE_EQUITY') {
        const n2 = Number((e as any)?.totalUsdSnapshot ?? (e as any)?.baselineUsd);
        if (Number.isFinite(n2)) return n2;
      }
    }

    // Pass 3: other baseline-ish fields as ultimate fallbacks
    for (let i = withTs.length - 1; i >= 0; i--) {
      const { e } = withTs[i];
      const candidates = [
        (e as any)?.totalUsdSnapshot, (e as any)?.baselineUsd,
        (e as any)?.equityAtStart, (e as any)?.startEquity, (e as any)?.startTotal,
        (e as any)?.vaultUsdBefore, (e as any)?.totalUsdBefore, (e as any)?.equityBeforeUsd,
        (e as any)?.frozenTotalUsd, (e as any)?.frozen_equity_total, (e as any)?.frozenEquityUsd
      ];
      for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n)) return n;
      }
    }

    return null;
  } catch { return null; }
}


/** Additional helpers to mirror SharePLCardPreviewModal parity fallbacks. */
function parseCadenceHours(v: any): number | null {
  if (isNum(v)) return v;
  const s = trimStr(v).toLowerCase();
  if (!s) return null;
  const m = s.match(/(\d+)\s*h/);
  if (m) { const n = Number(m[1]); return Number.isFinite(n) ? n : null; }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function readEventTsSec(e: AnyEvent): number | null {
  const raw = e?.ts ?? e?.timestamp ?? e?.time ?? e?.blockTime ?? e?.createdAt ?? e?.created_at ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return raw > 1e12 ? Math.round(raw / 1000) : Math.round(raw);
  }
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 1e12 ? Math.round(n / 1000) : Math.round(n);
    const d = Date.parse(raw);
    if (Number.isFinite(d)) return Math.round(d / 1000);
  }
  return null;
}
/** Timestamp (seconds) of the FIRST baseline event for a rebalance set. */
function findFirstBaselineTimestampSec(events: AnyEvent[]): number | null {
  try {
    const arr = Array.isArray(events) ? events : [];
    if (arr.length === 0) return null;
    const withTs = arr
      .map((e) => ({ t: readEventTsSec(e), e }))
      .filter((x) => isNum(x.t))
      .sort((a, b) => (a.t! - b.t!));
    for (const { t, e } of withTs) {
      // Explicit start event
      const kind = String((e as any)?.kind || (e as any)?.type || '').toUpperCase();
      const hasBaselineField =
        isNum(toNum((e as any)?.startingTotalUsd ?? (e as any)?.startTotalUsd ?? (e as any)?.baselineUsd ??
                    (e as any)?.totalUsdSnapshot ?? (e as any)?.equityAtStart ?? (e as any)?.startEquity ?? (e as any)?.startTotal ??
                    (e as any)?.vaultUsdBefore ?? (e as any)?.totalUsdBefore ?? (e as any)?.equityBeforeUsd ??
                    (e as any)?.frozenTotalUsd ?? (e as any)?.frozen_equity_total ?? (e as any)?.frozenEquityUsd));
      if (kind === 'FIRST_REBALANCE_EQUITY' || hasBaselineField) {
        return t as number;
      }
    }
    return null;
  } catch {
    return null;
  }
}


function isRebalanceEvent(e: AnyEvent): boolean {
  try {
    const fields: Array<string> = [
      e?.kind, e?.type, e?.event, e?.action, e?.direction, e?.eventType,
      Array.isArray(e?.tags) ? e.tags.join(' ') : '',
      e?.title, e?.label
    ].filter(Boolean).map((s: any) => String(s).toLowerCase());
    const joined = fields.join(' ');
    return joined.includes('rebal');
  } catch { return false; }
}

function rebalanceGroupKey(e: AnyEvent): string | null {
  const id =
    e?.rebalanceId ?? e?.rebalance_id ??
    e?.batchId ?? e?.batch_id ??
    e?.groupId ?? e?.group_id ??
    e?.rebalanceGroupId ?? e?.rebalance_group_id ?? null;
  if (!id) return null;
  return String(id);
}

function countAggregatedRebalances(events: AnyEvent[]): number {
  const rebals = events.filter(isRebalanceEvent);
  if (rebals.length === 0) return 0;
  const byId = new Map<string, number>();
  for (const e of rebals) {
    const key = rebalanceGroupKey(e);
    if (key) byId.set(key, (byId.get(key) || 0) + 1);
  }
  if (byId.size > 0) return byId.size;
  const times = rebals
    .map((e) => readEventTsSec(e))
    .filter((t): t is number => isNum(t))
    .sort((a, b) => a - b);
  if (times.length === 0) return rebals.length;
  let clusters = 1;
  for (let i = 1; i < times.length; i++) {
    if ((times[i] - times[i - 1]) > 90) clusters++;
  }
  return clusters;
}

function eventDir(e: AnyObj): 'BUY' | 'SELL' | null {
  const s = upper(e?.dir || e?.direction || e?.type || e?.kind || '');
  if (s.includes('BUY')) return 'BUY';
  if (s.includes('SELL')) return 'SELL';
  return null;
}
function eventTs(e: AnyObj): number {
  const cands = [e?.ts, e?.timeMs, e?.time, e?.timestamp, e?.createdAt];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
function eventSetId(e: AnyObj): string { return canon(e?.setId || e?.id || e?.set || e?.sid || ''); }
function eventNotionalUsd(e: AnyObj): number | null {
  // NOTE: "Volume" must only reflect executed swap notional.
  // Equity snapshots (e.g., aggregated REBALANCE totalUsd or FIRST_REBALANCE_EQUITY totalUsdSnapshot)
  // must NOT be counted as volume.
  const kind = upper((e as any)?.kind || (e as any)?.type || (e as any)?.event || (e as any)?.action || '');
  if (kind.includes('FIRST_REBALANCE_EQUITY') || kind.includes('EQUITY')) {
    return null;
  }

  // Prefer explicit volume fields when present (authoritative).
  const explicitVol =
    toNum((e as any)?.volumeUsd) ??
    toNum((e as any)?.volumeUSD) ??
    toNum((e as any)?.swapVolumeUsd);
  if (isNum(explicitVol)) return Number(explicitVol);

  // Common executed swap payload fields (Jupiter quote totals).
  // IMPORTANT: for volume we count *one side* of the swap. Prefer inTotalUsd.
  const inTot =
    toNum((e as any)?.inTotalUsd) ??
    toNum((e as any)?.inTotalUSD) ??
    toNum((e as any)?.usdIn) ??
    toNum((e as any)?.inputUsd) ??
    toNum((e as any)?.inUsd);
  if (isNum(inTot)) return Number(inTot);

  const outTot =
    toNum((e as any)?.outTotalUsd) ??
    toNum((e as any)?.outTotalUSD) ??
    toNum((e as any)?.usdOut) ??
    toNum((e as any)?.outputUsd) ??
    toNum((e as any)?.outUsd);
  if (isNum(outTot)) return Number(outTot);

  // Legacy/other event fields that sometimes represent executed swap notional.
  const direct =
    toNum((e as any)?.notionalUsd) ??
    toNum((e as any)?.notional) ??
    toNum((e as any)?.usd) ??
    toNum((e as any)?.amountUsd) ??
    toNum((e as any)?.valueUsd) ??
    toNum((e as any)?.swapUsd) ??
    toNum((e as any)?.swapUsdValue);
  if (isNum(direct)) return Number(direct);

  // Some events may carry legs/swaps arrays (e.g., REBALANCE summaries).
  // Sum executed leg notionals (prefer inTotalUsd on each leg).
  try {
    const legs: any[] =
      (Array.isArray((e as any)?.legs) ? (e as any).legs : null) ||
      (Array.isArray((e as any)?.swaps) ? (e as any).swaps : null) ||
      (Array.isArray((e as any)?.rebalancePairs) ? (e as any).rebalancePairs : null) ||
      null;

    if (Array.isArray(legs) && legs.length) {
      let sum = 0;
      for (const l of legs) {
        const legIn =
          toNum(l?.inTotalUsd) ??
          toNum(l?.inTotalUSD) ??
          toNum(l?.usdIn) ??
          toNum(l?.inputUsd) ??
          toNum(l?.inUsd);
        if (isNum(legIn)) { sum += Number(legIn); continue; }

        const legOut =
          toNum(l?.outTotalUsd) ??
          toNum(l?.outTotalUSD) ??
          toNum(l?.usdOut) ??
          toNum(l?.outputUsd) ??
          toNum(l?.outUsd);
        if (isNum(legOut)) { sum += Number(legOut); continue; }

        const v =
          toNum(l?.notionalUsd) ??
          toNum(l?.notional) ??
          toNum(l?.usd) ??
          toNum(l?.amountUsd) ??
          toNum(l?.valueUsd) ??
          toNum(l?.swapUsd) ??
          toNum(l?.swapUsdValue) ??
          toNum(l?.volumeUsd);
        if (isNum(v)) sum += Number(v);
      }
      if (Number.isFinite(sum) && sum > 0) return sum;
    }
  } catch {}

  // Do NOT fall back to totalUsd snapshots (equity). Those are not volume.
  return null;
}



function eventIsSuccessful(e: AnyObj): boolean {
  const ok = (e as any)?.ok;
  if (ok === false) return false;
  const sig = String((e as any)?.signature || (e as any)?.sig || "").trim();
  if (sig && sig.length >= 20) return true;
  if (ok === true) return true;
  // Older events may omit ok/signature; treat as successful if it looks like a completed swap
  // by having both sides populated.
  const inMint = String((e as any)?.inMint || (e as any)?.inputMint || "").trim();
  const outMint = String((e as any)?.outMint || (e as any)?.outputMint || "").trim();
  return !!(inMint && outMint);
}


/** Normalize possibly truncated set idss from events to full known ids. */
function normalizeSetId(sid: string, known: string[]): string {
  const s = trimStr(sid);
  if (!s) return s;
  if (known.includes(s)) return s;
  const matches = known.filter((k) => k.startsWith(s));
  if (matches.length === 1) return matches[0];
  return s;
}

/** Treat these titles as placeholders requiring recompute. */
function isPlaceholderTitle(s?: string | null): boolean {
  const t = upper(trimStr(s));
  // Treat generic boilerplate titles as placeholders so we can recompute better ones
  if (!t) return true;
  if (/BUY\s+BASE\s+SELL\s+FOR\s+QUOTE/.test(t)) return true;
  if (/^REBALANCE:\s*—\s*$/.test(t)) return true;
  if (/^MOJOMAXI\s+BOT$/.test(t)) return true;
  return false;
}

/* storage */
function lsDel(key: string) { try { localStorage.removeItem(key); } catch {} }

/** Best-effort local cleanup for stale/deleted sets so ghost rows never reappear.
 * We only wipe client-side caches / derived metrics. No UI or server state changes.
 */
async function cleanupStaleSetCaches(staleIds: string[], wallet: string) {
  try {
    const ids = Array.from(new Set((staleIds || []).map((s) => canon(s)).filter(Boolean)));
    if (!ids.length) return;

    // purge per-set caches
    for (const id of ids) {
      lsDel(`mm:status:${id}`);
      lsDel(`mm:agg:${id}`);
    }

    // prune title cache entries
    try {
      const key = 'mm:titleCache';
      const cur = lsGet<Record<string, string>>(key) || {};
      let changed = false;
      for (const id of ids) { if (cur && (id in cur)) { delete (cur as any)[id]; changed = true; } }
      if (changed) lsSet(key, cur);
    } catch {}

    // NOTE: we *do not* clear events or server keys here; server-side deletion is handled elsewhere.
    // We *also* leave mm:events:recent:* cache intact; filtering happens in-memory.
  } catch {}
}

function lsGet<T = any>(key: string): T | null {
  try { const x = localStorage.getItem(key); if (!x) return null; return JSON.parse(x) as T; } catch { return null; }
}
function lsSet(key: string, val: any) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

/* deep pick */
function deepPickNumber(obj: any, keys: string[]): number | null {
  for (const path of keys) {
    const parts = path.split('.');
    let cur: any = obj;
    let ok = true;
    for (const k of parts) {
      if (cur && typeof cur === 'object' && k in cur) cur = (cur as any)[k];
      else { ok = false; break; }
    }
    if (ok) {
      const n = toNum(cur);
      if (isNum(n)) return n;
    }
  }
  return null;
}

/* ------------------------------- fetchers -------------------------------- */

const ONE_HOUR_MS = 60 * 60 * 1000;

const EVENTS_CLIENT_TTL_MS = ONE_HOUR_MS;
const SETS_CLIENT_TTL_MS = ONE_HOUR_MS;
const VAULTMAP_CLIENT_TTL_MS = ONE_HOUR_MS;
const AGGREGATE_CLIENT_TTL_MS = ONE_HOUR_MS;
const EQUITY_CLIENT_TTL_MS = ONE_HOUR_MS;

async function safeJson(url: string, init?: RequestInit): Promise<{ ok: boolean; json: any | null }> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...(init || {}) });
    if (!res.ok) return { ok: false, json: null };
    const json = await res.json().catch(() => null);
    return { ok: true, json };
  } catch {
    return { ok: false, json: null };
  }
}

async function fetchTokenMetaMulti(mints: string[]): Promise<Record<string, TokenMeta>> {
  const uniq = Array.from(new Set((mints || []).map((m) => trimStr(m)).filter(Boolean)));
  if (!uniq.length) return {};
  try {
    const url = `/api/tokens/meta?mints=${encodeURIComponent(uniq.join(','))}`;
    const { ok, json } = await safeJson(url);
    if (!ok || !json) return {};
    const items: any[] = Array.isArray((json as any)?.items) ? (json as any).items : [];
    const map: Record<string, TokenMeta> = {};
    for (const it of items) {
      const k = it?.address || it?.mint;
      if (k) map[String(k)] = it as TokenMeta;
    }
    return map;
  } catch {
    return {};
  }
}

async function fetchDexSymbol(mint: string): Promise<string | null> {
  const q = encodeURIComponent(String(mint || '').trim());
  const urls = [
    `/api/dexscreener/symbol?mint=${q}`,
    `/api/dex/symbol?mint=${q}`,
    `/api/tokens/symbol?mint=${q}`,
  ];
  for (const u of urls) {
    try {
      const { ok, json } = await safeJson(u);
      if (!ok || !json) continue;
      const sym =
        (typeof (json as any)?.symbol === 'string' && (json as any).symbol) ||
        (typeof (json as any)?.data?.symbol === 'string' && (json as any).data.symbol) ||
        (typeof (json as any)?.token?.symbol === 'string' && (json as any).token.symbol) ||
        '';
      if (sym && typeof sym === 'string' && sym.trim()) return sym.trim().toUpperCase();
    } catch {}
  }
  try {
    const { ok, json } = await safeJson(`/api/tokens/search?q=${q}`);
    if (ok && json) {
      const arr: any[] =
        Array.isArray((json as any).tokens)
          ? (json as any).tokens
          : (Array.isArray((json as any).items) ? (json as any).items : []);
      const hit = arr.find((t: any) => String((t?.address || t?.mint || t?.id) || '').trim().toLowerCase() === decodeURIComponent(q).toLowerCase());
      const sym = hit && (hit.symbol || hit.name);
      if (sym && typeof sym === 'string' && sym.trim()) return sym.trim().toUpperCase();
    }
  } catch {}
  return null;
}

async function resolveSymbolsForMints(mints: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const list = Array.from(new Set((mints || []).map((s) => trimStr(s)).filter(Boolean)));
  if (!list.length) return out;
  const meta = await fetchTokenMetaMulti(list);
  for (const m of list) {
    const tm: any = (meta as any)[m];
    const hit = tm && (tm.symbol || tm.name);
    if (hit && String(hit).trim()) {
      out[m] = String(hit).trim().toUpperCase();
      continue;
    }
    try {
      const sym = await fetchDexSymbol(m);
      if (sym) out[m] = sym;
    } catch {}
  }
  return out;
}

function extractMintsFromEventsForSet(events: AnyObj[], setId: string): string[] {
  const target = canon(setId);
  const bag = new Set<string>();
  const push = (v: any) => {
    const s = trimStr(v);
    if (!s) return;
    bag.add(s);
  };
  for (const e of (events || [])) {
    if (!eventIsSuccessful(e)) continue;
    const sid = normalizeSetId(eventSetId(e), [target]);
    if (sid !== target) continue;
    if (Array.isArray((e as any).mints)) for (const m of (e as any).mints) push(m);
    if (Array.isArray((e as any).tokens)) for (const t of (e as any).tokens) push((t && (t.mint || t.address || t.id)));
    push((e as any).inputMint); push((e as any).outputMint);
    push((e as any).mintIn); push((e as any).mintOut);
    push((e as any).mintA); push((e as any).mintB);
    try { push((e as any).tokenA?.mint); push((e as any).tokenB?.mint); } catch {}
    try {
      if (Array.isArray((e as any).pairs)) for (const p of (e as any).pairs) { push(p?.a?.mint || p?.mintA); push(p?.b?.mint || p?.mintB); }
      if (Array.isArray((e as any).legs)) for (const leg of (e as any).legs) { push(leg?.inputMint); push(leg?.outputMint); }
    } catch {}
  }
  return Array.from(bag);
}

function symbolFrom(meta?: TokenMeta): string {
  if (!meta) return '';
  const s = trimStr(meta.symbol);
  return s ? ('' + s).toUpperCase() : '';
}

function buildWebhookTitleFromSetDoc(whSet: any, symMap: Record<string, string>, aggTitle?: string | null): string | null {
  if (!whSet) return null;
  const mintIn = trimStr(whSet?.prefs?.mintIn || whSet?.mintIn || whSet?.buyMint || '');
  const mintOut = trimStr(whSet?.prefs?.mintOut || whSet?.mintOut || whSet?.sellMint || '');
  if (!mintIn && !mintOut) {
    const label = trimStr(whSet?.label || '');
    return label || null;
  }
  let base = symMap[mintIn] || '';
  let quote = symMap[mintOut] || '';

  if ((!base || base === 'BASE') && aggTitle) {
    const m = String(aggTitle).match(/buy\s+([A-Z0-9]+)\s+sell\s+for\s+([A-Z0-9]+)/i);
    if (m) {
      base = base || (m[1] || '').toUpperCase();
      quote = quote || (m[2] || '').toUpperCase();
    }
  }
  base = base || 'BASE';
  quote = quote || 'QUOTE';
  return `webhooks: buy ${base} sell for ${quote}`;
}

function buildRebalanceTitleFromSymbols(symbols: string[]): string {
  const parts = (symbols || []).filter(Boolean);
  return parts.length ? `rebalance: ${parts.join(', ')}` : 'rebalance: —';
}

async function fetchSetsForWallet(wallet: string): Promise<{ bySetId: Record<string, AnyObj>; rebalById: Record<string, AnyObj> }> {
  const bySetId: Record<string, AnyObj> = {};
  const rebalById: Record<string, AnyObj> = {};

  const now = Date.now();
  const wkey = `mm:sets:webhooks:${wallet}`;
  const rkey = `mm:sets:rebalance:${wallet}`;
  const wCached = lsGet<{ ts: number; sets: AnyObj[] }>(wkey);
  const rCached = lsGet<{ ts: number; sets: AnyObj[] }>(rkey);

  const wFresh = !!(wCached && now - wCached.ts < SETS_CLIENT_TTL_MS && Array.isArray(wCached.sets) && wCached.sets.length > 0);
  const rFresh = !!(rCached && now - rCached.ts < SETS_CLIENT_TTL_MS && Array.isArray(rCached.sets) && rCached.sets.length > 0);

  let wSets: AnyObj[] | null = wFresh ? wCached!.sets : null;
  let rSets: AnyObj[] | null = rFresh ? rCached!.sets : null;

  try {
    if (wSets == null) {
      const { ok, json } = await safeJson(`/api/webhooks/for/${encodeURIComponent(wallet)}`);
      wSets = ok && json && Array.isArray(json?.sets) ? json.sets : [];
      lsSet(wkey, { ts: now, sets: wSets });
    }
  } catch { wSets = wSets || []; }

  try {
    if (rSets == null) {
      const { ok, json } = await safeJson(`/api/rebalance/for/${encodeURIComponent(wallet)}`);
      rSets = ok && json && Array.isArray(json?.sets) ? json.sets : [];
      lsSet(rkey, { ts: now, sets: rSets });
    }
  } catch { rSets = rSets || []; }

  for (const s of (wSets || [])) {
    const id = canon(s?.id || s?.setId);
    if (!id) continue;
    bySetId[id] = s;
  }
  for (const s of (rSets || [])) {
    const id = canon(s?.id || s?.setId);
    if (!id) continue;
    rebalById[id] = s;
  }
  return { bySetId, rebalById };
}

async function fetchVaultMap(ids: string[]): Promise<Record<string, string | null>> {
  if (!ids?.length) return {};
  const uniq = Array.from(new Set(ids.map(canon).filter(Boolean)));
  const joined = uniq.join(',');
  const now = Date.now();
  const key = `mm:vaults:${joined}`;
  const cached = lsGet<{ ts: number; map: Record<string, string | null> }>(key);
  if (cached && now - cached.ts < VAULTMAP_CLIENT_TTL_MS) return cached.map || {};

  const out: Record<string, string | null> = {};
  const jobs = uniq.map(async (setId) => {
    try {
      const { ok, json } = await safeJson(`/api/vaults/debug/${encodeURIComponent(setId)}`);
      if (!ok || !json) return;
      const v = trimStr((json as any)?.vault || (json as any)?.authority || (json as any)?.address || '');
      if (v) out[setId] = v;
    } catch {}
  });
  await Promise.all(jobs);
  lsSet(key, { ts: Date.now(), map: out });
  return out;
}

async function fetchVaultStatusMap(ids: string[]): Promise<Record<string, { status?: string; state?: string; updatedAt?: number | null }>> {
  const out: Record<string, { status?: string; state?: string; updatedAt?: number | null }> = {};
  try {
    const uniq = Array.from(new Set((ids || []).map(canon).filter(Boolean)));
    if (!uniq.length) return out;
    const now = Date.now();
    // Cache per-id in localStorage so we don't hammer the endpoint
    const TTL = 15 * 1000; // 15s is enough for UI freshness
    const jobs = uniq.map(async (id) => {
      const key = `mm:status:${id}`;
      const cached = lsGet<{ ts: number; row: { status?: string; state?: string; updatedAt?: number | null } }>(key);
      if (cached && (now - cached.ts) < TTL) { out[id] = cached.row || {}; return; }
      const { ok, json } = await safeJson(`/api/vaults/status/${encodeURIComponent(id)}`);
      if (ok && json && typeof json === 'object') {
        const row: any = json;
        const state = String(row?.status ?? row?.state ?? '').toLowerCase();
        const updatedAt = toNum(row?.updatedAt);
        out[id] = { status: state || undefined, state: state || undefined, updatedAt: isNum(updatedAt) ? updatedAt! : undefined };
        lsSet(key, { ts: now, row: out[id] });
      }
    });
    await Promise.all(jobs);
  } catch {
    /* best-effort */
  }
  return out;
}


async function fetchRecentEvents(wallet: string, limit: number): Promise<AnyObj[]> {
  const key = `mm:events:recent:${wallet}:${limit}`;
  const cached = lsGet<{ ts: number; events: AnyObj[] }>(key);
  const now = Date.now();
  if (cached && now - cached.ts < EVENTS_CLIENT_TTL_MS) {
    const evts = Array.isArray(cached.events) ? [...cached.events] : [];
    evts.sort((a, b) => eventTs(a) - eventTs(b));
    return evts;
  }
  const url = `/api/events/recent?wallet=${encodeURIComponent(wallet)}&limit=${Math.max(1, Math.min(500, limit))}`;
  const { ok, json } = await safeJson(url);
  if (!ok || !json) return [];
  const events: AnyObj[] = Array.isArray(json?.events) ? json.events : Array.isArray(json) ? json : [];
  events.sort((a, b) => eventTs(a) - eventTs(b));
  lsSet(key, { ts: now, events });
  return events;
}

/**
 * Direct setId-based recent events fetch (parity with SharePLCardPreviewModal).
 * We only call this as a fallback when the wallet-wide feed seems incomplete.
 * Cached very lightly to avoid hammering the API from the metrics panel.
 */
const setEventsCache = new Map<string, { ts: number; events: AnyObj[] }>();
async function fetchRecentEventsBySetId(setId: string, limit: number = 500): Promise<AnyObj[]> {
  const ck = canon(setId);
  if (!ck) return [];
  const now = Date.now();
  const ttlMs = 20_000;
  const cached = setEventsCache.get(ck);
  if (cached && (now - cached.ts) < ttlMs) return cached.events;

  try {
    const url = `/api/events/recent?setId=${encodeURIComponent(ck)}&limit=${Math.max(1, Math.min(1000, limit))}`;
    const { ok, json } = await safeJson(url);
    if (!ok || !json) return [];
    const events = Array.isArray((json as any)?.events) ? (json as any).events as AnyObj[] : (Array.isArray(json) ? (json as any) : []);
    setEventsCache.set(ck, { ts: now, events });
    return events;
  } catch {
    return [];
  }
}

/**
 * Robust baseline helper:
 * - Looks ONLY at FIRST_REBALANCE_EQUITY events for this set
 * - Uses the LATEST one (so restart overrides previous)
 * - Baseline amount prefers totalUsdSnapshot, then baselineUsd, startingTotalUsd, totalUsd, amount, equityUsd, valueUsd
 * - Runtime uses ts/createdAt, via readEventTsSec
 */



async function deriveRebalanceBaselineAndRuntime(setId: string): Promise<{
  baselineUsd: number | null;
  baselineTsSec: number | null;
}> {
  try {
    const ev = await fetchRecentEventsBySetId(setId, 500);
    const list = Array.isArray(ev) ? ev : [];
    if (!list.length) return { baselineUsd: null, baselineTsSec: null };

    // For rebalance bots, treat the latest event that has startingTotalUsd
    // as the authoritative baseline (REBAL_SET rows in your event feed).
    const withStart = list.filter((e: any) => {
      const n = toNum((e as any)?.startingTotalUsd ?? (e as any)?.startTotalUsd ?? (e as any)?.totalUsdSnapshot ?? (e as any)?.baselineUsd);
      return isNum(n);
    });
    if (!withStart.length) {
      return { baselineUsd: null, baselineTsSec: null };
    }

    // Latest baseline wins so each new Start overrides the previous baseline
    const baselineEvent = withStart.reduce((best, cur) => {
      const bestTs = readEventTsSec(best as AnyEvent) ?? 0;
      const curTs = readEventTsSec(cur as AnyEvent) ?? 0;
      return curTs >= bestTs ? cur : best;
    }) as AnyEvent;

    const baselineVal = toNum((baselineEvent as any).startingTotalUsd ?? (baselineEvent as any).startTotalUsd ?? (baselineEvent as any).totalUsdSnapshot ?? (baselineEvent as any).baselineUsd);
    const baselineUsd = isNum(baselineVal) ? baselineVal : null;

    const tsSec = readEventTsSec(baselineEvent as AnyEvent);
    const baselineTsSec = isNum(tsSec) ? tsSec : null;

    return { baselineUsd, baselineTsSec };
  } catch {
    return { baselineUsd: null, baselineTsSec: null };
  }
}


const aggregatorCache = new Map<string, { ts: number; data: AnyObj }>();
async function fetchSetAggregateCached(setId: string): Promise<AnyObj | null> {
  const ck = canon(setId); if (!ck) return null;
  const now = Date.now();
  const cached = aggregatorCache.get(ck);
  if (cached && now - cached.ts < AGGREGATE_CLIENT_TTL_MS) return cached.data;
  const lsKey = `mm:agg:${ck}`;
  const lsCached = lsGet<{ ts: number; data: AnyObj }>(lsKey);
  if (lsCached && now - lsCached.ts < AGGREGATE_CLIENT_TTL_MS) {
    aggregatorCache.set(ck, lsCached);
    return lsCached.data;
  }

  const endpoints = [
    `/api/share/resolve-set?setId=${encodeURIComponent(ck)}`,
    `/api/share/resolve-set/${encodeURIComponent(ck)}`,
    `/api/share/resolve-set/cached/${encodeURIComponent(ck)}`,
  ];

  let data: AnyObj | null = null;
  for (const ep of endpoints) {
    try {
      const { ok, json } = await safeJson(ep);
      if (!ok || !json) continue;
      const maybe = json as AnyObj;
      const hasTitle = !!trimStr((maybe as any)?.setTitle);
      const hasAnyStats =
        isNum(Number((maybe as any)?.totalUsd)) ||
        isNum(Number((maybe as any)?.pnlUsd)) ||
        isNum(Number((maybe as any)?.pnlPct)) ||
        isNum(Number((maybe as any)?.runtimeSec)) ||
        isNum(Number((maybe as any)?.cadenceHours)) ||
        isNum(Number((maybe as any)?.totalRebalances)) ||
        isNum(Number((maybe as any)?.totalTrades));
      if (hasTitle || hasAnyStats) { data = maybe as AnyObj; break; }
    } catch {}
  }

  if (!data) return null;
  aggregatorCache.set(ck, { ts: now, data });
  lsSet(lsKey, { ts: now, data });
  return data;
}

/**
 * NOTE: changed to include wallet so /api/vault/equity can derive the vault PDA.
 */
async function fetchVaultEquityTotalUsd(setId: string, wallet?: string | null): Promise<number | null> {
  const ck = canon(setId); if (!ck) return null;
  const now = Date.now();
  const key = `mm:equity:${ck}${wallet ? `:${wallet}` : ''}`;
  const cached = lsGet<{ ts: number; usd: number | null }>(key);
  if (cached && now - cached.ts < EQUITY_CLIENT_TTL_MS) return isNum(cached.usd) ? cached.usd : null;

  const walletParam = wallet ? `&wallet=${encodeURIComponent(wallet)}` : '';
  const endpoints = [
    `/api/vault/equity?setId=${encodeURIComponent(ck)}${walletParam}`,
    `/api/vault/equity/${encodeURIComponent(ck)}${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''}`,
  ];

  let usd: number | null = null;
  for (const ep of endpoints) {
    try {
      const { ok, json } = await safeJson(ep);
      if (!ok || !json) continue;
      usd = deepPickNumber(json, [
        'totalUsd',
        'equity.totalUsd',
        'equity.currentUsd',
        'equityUsd',
        'equity.equityUsd',
        'currentUsd',
        'usd',
        'balanceUsd',
      ]);
      if (isNum(usd)) break;
    } catch {}
  }

  lsSet(key, { ts: now, usd: isNum(usd) ? usd : null });
  return isNum(usd) ? usd : null;
}

async function fetchPersistedTitles(wallet: string, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!wallet || !ids?.length) return out;
  try {
    const qs = `wallet=${encodeURIComponent(wallet)}&ids=${encodeURIComponent(ids.join(','))}`;
    const { ok, json } = await safeJson(`/api/metrics/title?${qs}`);
    if (!ok || !json) return out;
    const map = (json as any)?.map || {};
    for (const [id, payload] of Object.entries(map)) {
      const t = trimStr((payload as any)?.title);
      if (t) out[id] = t;
    }
  } catch {}
  return out;
}

async function persistMetricsTitle(wallet: string, setId: string, title: string, type: 'webhooks' | 'rebalance') {
  if (!wallet || !setId || !title) return;
  try {
    await fetch('/api/metrics/title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, setId, title, type }),
      cache: 'no-store',
    });
  } catch {}
}

/* ------------------------------- component -------------------------------- */

export default function MetricsPanel({ eventsLimit = 200, isMojoPro }: { eventsLimit?: number; isMojoPro?: boolean }) {
  const { publicKey } = useWallet();
  const wallet = useMemo(() => (publicKey ? publicKey.toBase58() : ''), [publicKey]);
  const [proActive, setProActive] = useState<boolean>(typeof isMojoPro === 'boolean' ? !!isMojoPro : false);

  useEffect(() => {
    if (typeof isMojoPro === 'boolean') { setProActive(!!isMojoPro); return; }
    let on = true;
    const w = publicKey?.toBase58?.() || '';
    if (!w) { setProActive(false); return; }
    (async () => {
      try {
        const r = await fetch(`/api/subs/mojo-pro/status?wallet=${encodeURIComponent(w)}`, { cache: 'no-store' });
        const j = await r.json();
        if (on) setProActive(!!j?.status?.active);
      } catch {
        if (on) setProActive(false);
      }
    })();
    return () => { on = false; };
  }, [publicKey, isMojoPro]);


  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals>({ totalRealizedUsd: 0, totalVolumeUsd: 0, topTrade: null });

  const [shareOpen, setShareOpen] = useState(false);
  const [shareImageUrl, setShareImageUrl] = useState('');
  const [shareFilename, setShareFilename] = useState<string | undefined>();
  const [shareDebugId, setShareDebugId] = useState<string | undefined>();
  const [shareSetId, setShareSetId] = useState<string | undefined>();

  const { shouldPoll } = usePollingGate();
  const lastWalletRef = useRef<string>('');
  const titleCacheRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let off = false;

    async function load(w: string) {
      setLoading(true);
      try {
        const { bySetId, rebalById } = await fetchSetsForWallet(w);
        const webhookIdSet = new Set<string>(Object.keys(bySetId));
        const rebalanceIdSet = new Set<string>(Object.keys(rebalById));
        const allSetIds = Array.from(new Set([...webhookIdSet, ...rebalanceIdSet]));

        const vaultMap = await fetchVaultMap(allSetIds);
        const events = await fetchRecentEvents(w, Math.max(1, Math.min(500, eventsLimit || 200)));
        const statusMap = await fetchVaultStatusMap(Array.from(webhookIdSet));
        const knownIds = Array.from(new Set([...webhookIdSet, ...rebalanceIdSet]));

        const perSet: Record<string, { realizedUsd: number; volumeUsd: number; status: Status; createdAt?: number; lastSellTs?: number }> = {};
        const bySymbolPnl: Record<string, number> = {};
        const hasEvents = new Set<string>();

        
        // Filter out events that belong to sets the dashboard no longer knows about
        const __allowedSet = new Set<string>([...webhookIdSet, ...rebalanceIdSet]);
        const filteredEvents = (events || []).filter((e) => {
          const rawSid = eventSetId(e);
          if (!rawSid) return false;
          const sid = normalizeSetId(rawSid, Array.from(__allowedSet));
          return __allowedSet.has(sid);
        });
        const chrono = [...filteredEvents].sort((a, b) => eventTs(a) - eventTs(b));

        // --- Rebalance volume de-duplication ---
        // Rebalance runs can emit both:
        //  - per-leg SWAP events (each with inTotalUsd/outTotalUsd), and
        //  - a REBALANCE summary event that also contains legs[]
        // Counting both will double-count volume. We compute a per-(setId, rebalanceGroupKey) volume
        // and only add it once per group (prefer per-leg swap events if present).
        const __rebVolBySet: Record<string, Record<string, { sumSwap: number; hasSwap: boolean; sumSummary: number; hasSummary: boolean }>> = {};
        for (const e of chrono) {
          const rawSid = eventSetId(e);
          if (!rawSid) continue;
          const sid = normalizeSetId(rawSid, knownIds);
          if (!rebalanceIdSet.has(sid)) continue;

          const gk = rebalanceGroupKey(e);
          if (!gk) continue;

          if (!__rebVolBySet[sid]) __rebVolBySet[sid] = {};
          if (!__rebVolBySet[sid][gk]) __rebVolBySet[sid][gk] = { sumSwap: 0, hasSwap: false, sumSummary: 0, hasSummary: false };

          const bucket = __rebVolBySet[sid][gk];

          // Summary-with-legs
          const legs = Array.isArray((e as any)?.legs)
            ? (e as any).legs
            : Array.isArray((e as any)?.swaps)
              ? (e as any).swaps
              : null;
          if (legs && legs.length) {
            let s = 0;
            for (const l of legs) {
              const v =
                toNum(l?.notionalUsd) ??
                toNum(l?.notional) ??
                toNum(l?.usd) ??
                toNum(l?.amountUsd) ??
                toNum(l?.valueUsd) ??
                toNum(l?.inTotalUsd) ??
                toNum(l?.outTotalUsd) ??
                toNum(l?.swapUsd) ??
                toNum(l?.swapUsdValue) ??
                toNum(l?.volumeUsd);
              if (isNum(v)) s += Number(v);
            }
            if (Number.isFinite(s) && s > 0) {
              bucket.sumSummary += s;
              bucket.hasSummary = true;
            }
          }

          // Per-leg swap event (signature or explicit buy/sell or quote totals)
          const hasSig = !!trimStr((e as any)?.signature || (e as any)?.sig || '');
          const dir = eventDir(e);
          const hasQuoteTotals = isNum(toNum((e as any)?.inTotalUsd)) || isNum(toNum((e as any)?.outTotalUsd));
          const looksLikeSwap = hasSig || dir === 'BUY' || dir === 'SELL' || hasQuoteTotals;

          if (looksLikeSwap) {
            const v = eventNotionalUsd(e);
            if (isNum(v) && Number(v) > 0) {
              bucket.sumSwap += Number(v);
              bucket.hasSwap = true;
            }
          }
        }

        const __rebChosenVol: Record<string, Record<string, number>> = {};
        for (const [sid, byKey] of Object.entries(__rebVolBySet)) {
          __rebChosenVol[sid] = {};
          for (const [gk, b] of Object.entries(byKey)) {
            const chosen = b.hasSwap ? b.sumSwap : (b.hasSummary ? b.sumSummary : 0);
            if (Number.isFinite(chosen) && chosen > 0) __rebChosenVol[sid][gk] = chosen;
          }
        }
        const __rebSeen: Record<string, Set<string>> = {};

        for (const e of chrono) {
          const rawSid = eventSetId(e);
          if (!rawSid) continue;
          const sid = normalizeSetId(rawSid, knownIds);
          hasEvents.add(sid);

          const dir = eventDir(e);
          // Volume attribution (dedup rebalance groups)
          let __volumeAdd: number | null = null;
          const __gk = rebalanceIdSet.has(sid) ? rebalanceGroupKey(e) : null;
          if (__gk && __rebChosenVol[sid] && (__gk in __rebChosenVol[sid])) {
            if (!__rebSeen[sid]) __rebSeen[sid] = new Set<string>();
            if (!__rebSeen[sid].has(__gk)) {
              __volumeAdd = __rebChosenVol[sid][__gk];
              __rebSeen[sid].add(__gk);
            } else {
              __volumeAdd = null; // already counted for this rebalance group
            }
          } else {
            __volumeAdd = eventNotionalUsd(e);
          }
          const createdAt = eventTs(e);

          if (!perSet[sid]) perSet[sid] = { realizedUsd: 0, volumeUsd: 0, status: 'flat', createdAt };
          else if (createdAt && (!perSet[sid].createdAt || createdAt < (perSet[sid].createdAt as number))) perSet[sid].createdAt = createdAt;

          if (isNum(__volumeAdd)) perSet[sid].volumeUsd += Number(__volumeAdd);

          if (dir === 'BUY') {
            perSet[sid].status = 'buy';
          } else if (dir === 'SELL') {
            perSet[sid].status = 'sell';
            const r = toNum((e as any)?.pnlUsd);
            if (isNum(r)) perSet[sid].realizedUsd += Number(r);
            perSet[sid].lastSellTs = createdAt || perSet[sid].lastSellTs;
            const sym = ('' + ((e as any)?.outputSymbol || (e as any)?.outSymbol || '')).toUpperCase();
            if (sym) bySymbolPnl[sym] = (bySymbolPnl[sym] || 0) + (toNum((e as any)?.pnlUsd) || 0);
          }
        }

        const totalRealizedUsd = Object.values(perSet).reduce((acc, v) => acc + (v.realizedUsd || 0), 0);
        let totalVolumeUsd = Object.values(perSet).reduce((acc, v) => acc + (v.volumeUsd || 0), 0);
        // Fallback: use Mojo Points lifetime as total volume if event-derived volume is 0
        if (totalVolumeUsd <= 0 && w) {
          try {
            const { ok, json } = await safeJson(`/api/mojo/points?owner=${encodeURIComponent(w)}&season=lifetime`);
            if (ok && json && json.points != null) {
              const pts = Number((json as any).points || 0);
              if (Number.isFinite(pts) && pts > 0) totalVolumeUsd = pts;
            }
          } catch {}
        }
        let topTrade: Totals['topTrade'] = null;
        const topSym = Object.keys(bySymbolPnl).sort((a, b) => Math.abs(bySymbolPnl[b]) - Math.abs(bySymbolPnl[a]))[0];
        if (topSym) topTrade = { label: `${topSym} ${fmtUsd(Math.abs(bySymbolPnl[topSym]))}`, amount: bySymbolPnl[topSym] };
        if (!off) setTotals({ totalRealizedUsd, totalVolumeUsd, topTrade });

        const seedAll = new Set<string>([...webhookIdSet, ...rebalanceIdSet]);
        // Proactively cleanup client caches for stale sets (present in events but not in dashboard sets)
        const staleFromEvents = Array.from(hasEvents).filter((sid) => !seedAll.has(sid));
        if (staleFromEvents.length > 0) {
          cleanupStaleSetCaches(staleFromEvents, w);
        }


        try {
          const idList = Array.from(seedAll);
          const persisted = await fetchPersistedTitles(w, idList);
          if (persisted && Object.keys(persisted).length) {
            titleCacheRef.current = { ...titleCacheRef.current, ...persisted };
            const key = 'mm:titleCache';
            const prev = lsGet<Record<string, string>>(key) || {};
            lsSet(key, { ...prev, ...persisted });
          }
        } catch {}

        const seeds = new Map<string, Row>();
        for (const sid of seedAll) {
          const type: VaultType = webhookIdSet.has(sid) ? 'webhooks' : rebalanceIdSet.has(sid) ? 'rebalance' : 'webhooks';
          const label = trimStr(type === 'rebalance' ? (rebalById[sid]?.label || bySetId[sid]?.label || '') : (bySetId[sid]?.label || rebalById[sid]?.label || ''));
          const createdAt = perSet[sid]?.createdAt || Number(bySetId[sid]?.createdAt || rebalById[sid]?.createdAt || 0) || undefined;
          const realizedUsd = perSet[sid]?.realizedUsd || 0;
          const volumeUsd = perSet[sid]?.volumeUsd || 0;
          const status = perSet[sid]?.status || 'flat';
          seeds.set(sid, {
            setId: sid, type, label, createdAt,
            realizedUsd, volumeUsd, status,
            currentPnlUsd: null,
          });
        }

        const rowsEnriched: Row[] = await Promise.all(
          Array.from(seeds.values()).map(async (r0) => {
            const r: Row = { ...r0 };
            const agg = await fetchSetAggregateCached(r.setId);

            let hasVault = !!vaultMap[r.setId] || hasEvents.has(r.setId);

            if (agg && typeof agg === 'object') {
              // Precompute per-set events (used by multiple parity fallbacks in this branch)
              let evForSetLocal: AnyEvent[] = [];
              try {
                const evAll = Array.isArray(events) ? events : [];
                evForSetLocal = evAll.filter((e: any) => normalizeSetId(eventSetId(e), knownIds) === r.setId) as AnyEvent[];
                if (!evForSetLocal || evForSetLocal.length === 0) {
                  try {
                    const alt2 = await fetchRecentEventsBySetId(r.setId, 500);
                    if (Array.isArray(alt2) && alt2.length) evForSetLocal = alt2 as AnyEvent[];
                  } catch {}
                }
              } catch {}

              const totalUsd = deepPickNumber(agg, ['totalUsd','equity.totalUsd','equity.currentUsd','stats.equity.currentUsd','totals.totalUsd']);
              const pnlUsd = deepPickNumber(agg, ['pnlUsd','agg.pnlUsd','equity.realizedUsd','stats.equity.realizedUsd']);
              const pnlPct = deepPickNumber(agg, ['pnlPct','agg.pnlPct','equity.pnlPct','stats.pnlPct']);
              const runtime = deepPickNumber(agg, ['runtimeSec','stats.runtimeSec','agg.runtimeSec']);
              const cadence = deepPickNumber(agg, ['cadenceHours','rebalance.cadence','rebalance.cadence_hours','cadence_hours']);
              const rebalances = deepPickNumber(agg, ['totalRebalances','rebalance.totalRebalances','rebalance.rebalanceCount','rebalance.rebalancesCount','rebalancesCount','stats.rebalance.rebalances']);
              const totalTrades = deepPickNumber(agg, ['totalTrades','webhooks.totalTrades','stats.webhooks.totalTrades']);
              const winRate = deepPickNumber(agg, ['winRatePct','webhooks.winRatePct','stats.webhooks.winRatePct']);
              const wins = deepPickNumber(agg, ['wins','webhooks.wins','stats.webhooks.wins']);
              const losses = deepPickNumber(agg, ['losses','webhooks.losses','stats.webhooks.losses']);
              const setTitleAgg = trimStr((agg as any)?.setTitle);
              const botType = trimStr((agg as any)?.botType).toLowerCase();

              if (isNum(totalUsd)) r.aggTotalUsd = totalUsd;
              if (isNum(pnlUsd)) r.aggPnlUsd = pnlUsd;
              if (isNum(pnlPct)) r.aggPnlPct = pnlPct;
              if (isNum(runtime)) r.aggRuntimeSec = runtime;

              if (isNum(cadence)) r.aggCadenceHours = cadence;
              if (isNum(rebalances)) r.aggTotalRebalances = rebalances;

              if (isNum(totalTrades)) r.totalTrades = totalTrades;
              if (isNum(winRate)) r.successRate = winRate;
              if (isNum(wins)) r.wins = wins;
              if (isNum(losses)) r.losses = losses;

              if (botType === 'rebalance') r.type = 'rebalance';

              // Rebalance P&L parity: derive from equity total minus startingTotalUsd (prefer), then fallbacks
              if (r.type === 'rebalance' && isNum(r.aggTotalUsd)) {
                const baseFromAgg = deepPickNumber(agg, ['startingTotalUsd','equity.startingTotalUsd','totalUsdSnapshot','equity.totalUsdSnapshot','baselineUsd','equity.baselineUsd','baseline','equity.baseline']);
                if (isNum(baseFromAgg)) {
                  r.aggPnlUsd = (r.aggTotalUsd as number) - (baseFromAgg as number);
                } else {
                  // Prefer baseline from set doc when aggregator lacks it (strongly prefer startingTotalUsd)
const baseFromSetDoc = deepPickNumber(rebalById[r.setId] || {}, ['startingTotalUsd','startTotalUsd','totalUsdSnapshot','baselineUsd']);
if (isNum(baseFromSetDoc)) {
  r.aggPnlUsd = (r.aggTotalUsd as number) - (baseFromSetDoc as number);
} else {
try {
                    const baseFromEvents = findLatestStartingUsdFromEvents(evForSetLocal as any[]);
                    if (isNum(baseFromEvents)) r.aggPnlUsd = (r.aggTotalUsd as number) - (baseFromEvents as number);
                  } catch {}
                }}
              }

              
              // Runtime override for REBALANCE bots: time since FIRST_REBALANCE_EQUITY (baseline) was recorded
              try {
                if (r.type === 'rebalance') {
                  const firstTs = findFirstBaselineTimestampSec(evForSetLocal as any[]);
                  if (isNum(firstTs)) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    const sec = Math.max(0, nowSec - (firstTs as number));
                    r.aggRuntimeSec = sec;
                  }
                }
              } catch {}
// Rebalance parity fallbacks (cadence/rebalances) if aggregator incomplete
              if (r.type === 'rebalance') {
                if (!isNum(r.aggCadenceHours) || (r.aggCadenceHours as number) <= 0) {
                  const rawCad = (rebalById[r.setId] as any)?.cadence ?? (rebalById[r.setId] as any)?.cadenceHours;
                  const hours = parseCadenceHours(rawCad);
                  if (isNum(hours)) r.aggCadenceHours = hours;
                }
                if (!isNum(r.aggTotalRebalances) || (r.aggTotalRebalances as number) === 0) {
                  try {
                    const count = countAggregatedRebalances(evForSetLocal as any[]);
                    if (isNum(count) && count > 0) r.aggTotalRebalances = count;
                  } catch {}
                }
              }

              // Title resolve
              let resolvedTitle: string | null = setTitleAgg || null;
              if (resolvedTitle) {
                const t0 = String(resolvedTitle).trim();
                if (r.type === 'rebalance' && /^webhooks:/i.test(t0)) resolvedTitle = null;
                if (r.type === 'webhooks' && /^rebalance:/i.test(t0)) resolvedTitle = null;
              }
              const isAggPlaceholder = isPlaceholderTitle(resolvedTitle);
              if (isAggPlaceholder) {
                if (r.type === 'webhooks') {
                  const wh = bySetId[r.setId];
                  if (wh) {
                    const mints: string[] = [trimStr(wh?.prefs?.mintIn || (wh as any)?.mintIn || (wh as any)?.buyMint || ''), trimStr(wh?.prefs?.mintOut || (wh as any)?.mintOut || (wh as any)?.sellMint || '')].filter(Boolean);
                    const symMap: Record<string, string> = await resolveSymbolsForMints(mints);
                    const computed = buildWebhookTitleFromSetDoc(wh, symMap, resolvedTitle);
                    if (computed && !isPlaceholderTitle(computed)) resolvedTitle = computed;
                  }
                } else if (r.type === 'rebalance') {
                  const rb = rebalById[r.setId];
                  if (rb) {
                    const mints: string[] = Array.isArray(rb.mints) ? rb.mints : [];
                    let mintsFinal: string[] = mints;
                    if (!mintsFinal || mintsFinal.length < 2) {
                      try { mintsFinal = extractMintsFromEventsForSet(events, r.setId); } catch {}
                    }
                    const symMap = await resolveSymbolsForMints(mintsFinal);
                    const symbols = mintsFinal.map((m) => symMap[m]).filter(Boolean);
                    const computed = buildRebalanceTitleFromSymbols(symbols);
                    if (computed && !isPlaceholderTitle(computed)) resolvedTitle = computed;
                  }
                }
              }

              if (resolvedTitle) {
                r.displayTitle = resolvedTitle;
                try { await persistMetricsTitle(wallet, r.setId, resolvedTitle, r.type === 'rebalance' ? 'rebalance' : 'webhooks'); } catch {}
                (titleCacheRef.current as any)[r.setId] = resolvedTitle;
                try {
                  const key = 'mm:titleCache';
                  const prev = lsGet<Record<string, string>>(key) || {};
                  lsSet(key, { ...prev, [r.setId]: resolvedTitle });
                } catch {}
              }

              // Prefer live vault equity if available (parity with vault dashboard)
              try {
                const eq = await fetchVaultEquityTotalUsd(r.setId, w);
                if (isNum(eq)) {
                  r.aggTotalUsd = eq;
                } else if (!isNum(r.aggTotalUsd)) {
                  r.aggTotalUsd = undefined;
                }
              } catch {}

              

              // If live equity arrived (or changed), recompute rebalance P&L against startingTotalUsd snapshot
              if (r.type === 'rebalance' && isNum(r.aggTotalUsd)) {
                // Prefer baseline from aggregator -> set doc -> events
                let __baseline =
                  deepPickNumber(agg, ['startingTotalUsd','equity.startingTotalUsd','totalUsdSnapshot','equity.totalUsdSnapshot','baselineUsd','equity.baselineUsd','baseline','equity.baseline']) ??
                  deepPickNumber(rebalById[r.setId] || {}, ['startingTotalUsd','startTotalUsd','totalUsdSnapshot','baselineUsd']);
                if (!isNum(__baseline)) {
                  try {
                    const __b = findLatestStartingUsdFromEvents(evForSetLocal as any[]);
                    if (isNum(__b)) __baseline = __b;
                  } catch {}
                }
                if (isNum(__baseline)) {
                  const __recomp = (r.aggTotalUsd as number) - (__baseline as number);
                  if (!isNum(r.aggPnlUsd) || Math.abs((r.aggPnlUsd as number) - __recomp) > 0.005) {
                    r.aggPnlUsd = __recomp;
                  }
                }
              }
r.__hasVault = true;
            } else {
              // No aggregate; compute best-effort title from set docs
              if (r.label && !isPlaceholderTitle(r.label)) {
                r.displayTitle = r.label;
                try { await persistMetricsTitle(wallet, r.setId, r.displayTitle, r.type === 'rebalance' ? 'rebalance' : 'webhooks'); } catch {}
                (titleCacheRef.current as any)[r.setId] = r.label;
                try {
                  const key = 'mm:titleCache';
                  const prev = lsGet<Record<string, string>>(key) || {};
                  lsSet(key, { ...prev, [r.setId]: r.displayTitle! });
                } catch {}
              } else {
                let computed: string | null = null;
                if (r.type === 'webhooks') {
                  const wh = bySetId[r.setId];
                  if (wh) {
                    const mints: string[] = [trimStr(wh?.prefs?.mintIn || wh?.mintIn || wh?.buyMint || ''), trimStr(wh?.prefs?.mintOut || wh?.mintOut || wh?.sellMint || '')].filter(Boolean);
                    const symMap: Record<string, string> = await resolveSymbolsForMints(mints);
                    computed = buildWebhookTitleFromSetDoc(wh, symMap, null);
                  }
                } else if (r.type === 'rebalance') {
                  const rb = rebalById[r.setId];
                  if (rb) {
                    const mints: string[] = Array.isArray(rb.mints) ? rb.mints : [];
                    let mintsFinal: string[] = mints;
                    if (!mintsFinal || mintsFinal.length < 2) {
                      try { mintsFinal = extractMintsFromEventsForSet(events, r.setId); } catch {}
                    }
                    const symMap = await resolveSymbolsForMints(mintsFinal);
                    const symbols = mintsFinal.map((m) => symMap[m]).filter(Boolean);
                    computed = buildRebalanceTitleFromSymbols(symbols);
                  }
                }
                if (computed) {
                  r.displayTitle = computed;
                  try { await persistMetricsTitle(wallet, r.setId, r.displayTitle, r.type === 'rebalance' ? 'rebalance' : 'webhooks'); } catch {}
                  (titleCacheRef.current as any)[r.setId] = r.displayTitle!;
                  try {
                    const key = 'mm:titleCache';
                    const prev = lsGet<Record<string, string>>(key) || {};
                    lsSet(key, { ...prev, [r.setId]: r.displayTitle! });
                  } catch {}
                }
              }

              // --- Parity fallbacks to mirror SharePLCardPreviewModal ---
              try {
                const evAll = Array.isArray(events) ? events : [];
                let evForSet = evAll.filter((e: any) => normalizeSetId(eventSetId(e), knownIds) === r.setId);
                // Fallback: if the wallet-wide feed looks sparse for this set (esp. rebalances), fetch per-set
                if (!evForSet || evForSet.length === 0) {
                  try { const alt = await fetchRecentEventsBySetId(r.setId, 500); if (Array.isArray(alt) && alt.length) evForSet = alt as any[]; } catch {}
                }

                // Webhooks SELL-only stats: trades/wins/losses/win rate
                if (r.type === 'webhooks') {
                  const haveTrades = isNum(r.totalTrades) && Number(r.totalTrades) > 0;
                  const haveWR = isNum(r.successRate);
                  if (!haveTrades || !haveWR || !isNum(r.wins) || !isNum(r.losses)) {
                    let sells = 0, wins = 0, losses = 0;
                    for (const e of evForSet) {
                      const dir = eventDir(e);
                      const pnl = toNum((e as any)?.pnlUsd ?? (e as any)?.pnl);
                      if (dir === 'SELL' && isNum(pnl)) {
                        sells++;
                        if (Number(pnl) > 0) wins++; else losses++;
                      }
                    }
                    if (!isNum(r.totalTrades)) r.totalTrades = sells || undefined;
                    if (!isNum(r.wins)) r.wins = wins || undefined;
                    if (!isNum(r.losses)) r.losses = losses || undefined;
                    if (!isNum(r.successRate)) r.successRate = sells > 0 ? (wins / sells) * 100 : undefined;
                  }
                }

                // Rebalance cadence + total rebalances
                if (r.type === 'rebalance') {
                  if (!isNum(r.aggCadenceHours) || (r.aggCadenceHours as number) <= 0) {
                    const rawCad = (rebalById[r.setId] as any)?.cadence ?? (rebalById[r.setId] as any)?.cadenceHours;
                    const hours = parseCadenceHours(rawCad);
                    if (isNum(hours)) r.aggCadenceHours = hours;
                  }
                  if (!isNum(r.aggTotalRebalances) || (r.aggTotalRebalances as number) === 0) {
                    const count = countAggregatedRebalances(evForSet as any[]);
                    if (isNum(count)) r.aggTotalRebalances = count;
                  }
                }

                // PnL fallback from SELL events if missing
if (!isNum(r.aggPnlUsd)) {
  // Prefer startingTotalUsd from set doc for rebalance before SELL aggregation
  if (r.type === 'rebalance' && isNum(r.aggTotalUsd)) {
    const baseFromSetDoc = deepPickNumber(rebalById[r.setId] || {}, ['startingTotalUsd','startTotalUsd','totalUsdSnapshot','baselineUsd']);
    if (isNum(baseFromSetDoc)) {
      r.aggPnlUsd = (r.aggTotalUsd as number) - (baseFromSetDoc as number);
    }
  }
let aggPnl = 0, sells = 0;
                  for (const e of evForSet) {
                    const dir = eventDir(e);
                    const pnl = toNum((e as any)?.pnlUsd ?? (e as any)?.pnl);
                    if (dir === 'SELL' && isNum(pnl)) { aggPnl += Number(pnl); sells++; }
                  }
                  if (sells > 0) r.aggPnlUsd = aggPnl;

                  // Rebalance P&L parity: if still missing and we have equity, compute equity - earliest baseline from events
                  if (r.type === 'rebalance' && !isNum(r.aggPnlUsd) && isNum(r.aggTotalUsd)) {
                    const evForBaseline = await fetchRecentEventsBySetId(r.setId, 500);
                    const baseFromEvents = findLatestStartingUsdFromEvents(evForBaseline as any[]);
                    if (isNum(baseFromEvents)) r.aggPnlUsd = (r.aggTotalUsd as number) - (baseFromEvents as number);
                  }
                }

                // Runtime fallback (seconds since first event or createdAt)
                if (!isNum(r.aggRuntimeSec)) {
                  let startedAt: number | null = null;

                  // Prefer FIRST_REBALANCE_EQUITY (baseline) timestamp for REBALANCE bots
                  if (r.type === 'rebalance') {
                    try {
                      const firstTs = findFirstBaselineTimestampSec(evForSet as any[]);
                      if (isNum(firstTs)) {
                        startedAt = (Number(firstTs) * 1000);
                      }
                    } catch {}
                  }


                  // Rebalance: time since last transition to "running"
                  if (r.type === 'rebalance') {
                    const doc: any = (rebalById[r.setId] as any) || {};
                    const st = String(doc?.status || '').toLowerCase();
                    const upd = toNum(doc?.updatedAt);
                    if (st === 'running' && isNum(upd)) startedAt = upd as number;
                  }

                  // Webhooks: read /api/vaults/status (state + updatedAt)
                  if (r.type === 'webhooks') {
                    const row: any = (statusMap && (statusMap as any)[r.setId]) || {};
                    const st = String(row?.status || row?.state || '').toLowerCase();
                    const upd = toNum(row?.updatedAt);
                    if (st === 'running' && isNum(upd)) startedAt = upd as number;
                  }

                  if (isNum(startedAt)) {
                    r.aggRuntimeSec = Math.max(0, Math.floor((Date.now() - (startedAt as number)) / 1000));
                  }
                }
              } catch {}

              // Equity fallback even when no agg
              if (!isNum(r.aggTotalUsd)) {
                const eq = await fetchVaultEquityTotalUsd(r.setId, w);
                if (isNum(eq)) r.aggTotalUsd = eq;
              }

              

              // After equity fallback, if rebalance and baseline exists, compute P&L = equity - startingTotalUsd
              if (r.type === 'rebalance' && isNum(r.aggTotalUsd)) {
                let __baseline =
                  deepPickNumber(rebalById[r.setId] || {}, ['startingTotalUsd','startTotalUsd','totalUsdSnapshot','baselineUsd']);
                if (!isNum(__baseline)) {
                  try {
                    const evForBaseline = await fetchRecentEventsBySetId(r.setId, 500);
                    const baseFromEvents = findLatestStartingUsdFromEvents(evForBaseline as any[]);
                    if (isNum(baseFromEvents)) __baseline = baseFromEvents;
                  } catch {}
                }
                if (isNum(__baseline)) {
                  const __recomp = (r.aggTotalUsd as number) - (__baseline as number);
                  if (!isNum(r.aggPnlUsd) || Math.abs((r.aggPnlUsd as number) - __recomp) > 0.005) {
                    r.aggPnlUsd = __recomp;
                  }
                }
              }
{
              const st: any = (statusMap && (statusMap as any)[r.setId]) || {};
              const running = String(st?.status || st?.state || '').toLowerCase() === 'running';
              const hasAgg = [r.aggTotalUsd, r.aggRuntimeSec, r.aggPnlUsd].some((v: any) => typeof v === 'number' && Number.isFinite(v));
              r.__hasVault = !!(hasEvents.has(r.setId) || running || hasAgg);
            }
            }

            // --- Final parity for rebalance bots: equity - FIRST_REBALANCE_EQUITY baseline ---
            if (r.type === 'rebalance' && isNum(r.aggTotalUsd)) {
              try {
                const { baselineUsd, baselineTsSec } = await deriveRebalanceBaselineAndRuntime(r.setId);

                if (isNum(baselineUsd)) {
                  if (!isNum(r.aggPnlUsd)) { r.aggPnlUsd = (r.aggTotalUsd as number) - (baselineUsd as number);
                 }
}

                if (isNum(baselineTsSec)) {
                  const nowSec = Math.floor(Date.now() / 1000);
                  r.aggRuntimeSec = Math.max(0, nowSec - (baselineTsSec as number));
                }
              } catch {
                // best-effort, don't break the row
              }
            }

            return r;
          })
        );

        const filtered = rowsEnriched.filter((r) => r.__hasVault === true);
        filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        // Include rebalance bot live P&L in the header total.
        // Webhooks bots contribute realized P&L; rebalance bots contribute aggPnlUsd (equity - baseline).
        const totalPnlUsd = filtered.reduce((acc, r) => {
          if (r.type === 'rebalance' && isNum(r.aggPnlUsd)) return acc + (r.aggPnlUsd as number);
          return acc + (r.realizedUsd || 0);
        }, 0);
        if (!off) setTotals((prev) => ({ ...prev, totalRealizedUsd: totalPnlUsd }));

        if (!off) setRows(filtered);
      } finally {
        if (!off) setLoading(false);
      }
    }

    const w = trimStr(wallet);
    if (!w || lastWalletRef.current === w) return;
    lastWalletRef.current = w;
    load(w);

    const id = setInterval(() => {
      if (!shouldPoll) return;
      const cur = trimStr(wallet);
      if (!cur) return;
      load(cur);
    }, withJitterMs(20_000, 0.2));

    return () => { off = true; clearInterval(id); };
  }, [wallet, eventsLimit, shouldPoll]);

  const el = React.createElement;

  const totalsHeader = el(
    'div',
    { className: 'mb-3 flex flex-wrap gap-3' },
    el(
      'div',
      { className: 'flex min-w-[140px] flex-1 flex-col gap-1' },
      el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'Total P&L'),
      el('div', { className: `text-2xl ${totals.totalRealizedUsd >= 0 ? 'text-brandMint' : 'text-brandPink'} truncate` }, fmtUsd(totals.totalRealizedUsd)),
    ),
    el(
      'div',
      { className: 'flex min-w-[140px] flex-1 flex-col gap-1' },
      el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'Total Volume (all-time)'),
      el('div', { className: 'text-2xl text-white/70 truncate' }, fmtUsd(totals.totalVolumeUsd)),
    ),
    el(
      'div',
      { className: 'flex min-w-[140px] flex-1 flex-col gap-1' },
      el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'Top trade'),
      el('div', { className: 'text-2xl text-white/70 break-words' }, totals.topTrade ? `${totals.topTrade.label}` : '—'),
    ),
  );

  const rowsList = el(
    'div',
    { className: 'grid grid-cols-1 gap-3' },
    ...rows.map((r) => {
      const pnlUsd = isNum(r.aggPnlUsd) ? (r.aggPnlUsd as number) : r.realizedUsd;
      const pnlClass = pnlUsd > 0 ? 'text-brandMint' : pnlUsd < 0 ? 'text-brandPink' : 'text-white/70';
      const totalEquity = isNum(r.aggTotalUsd) ? (r.aggTotalUsd as number) : 0;
      const title = r.displayTitle || r.label || `Set ${r.setId.slice(0, 8)}`;
      const displaySmallTitle = title;

      const leftGridChildren: any[] = [
        el('div', { className: 'flex min-w-[140px] flex-1 flex-col gap-0.5' },
          el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'total'),
          el('div', { className: 'text-base text-white break-words' }, fmtUsd(totalEquity)),
        ),
        el('div', { className: 'flex min-w-[140px] flex-1 flex-col gap-0.5' },
          el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'P&L'),
          el('div', { className: `text-base ${pnlClass} break-words` }, fmtUsd(pnlUsd)),
        ),
      ];

      if (r.type === 'rebalance') {
        leftGridChildren.push(
          el('div', { className: 'flex min-w-[140px] flex-1 flex-col gap-0.5' },
            el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'cadence'),
            el('div', { className: 'text-base text-white break-words' }, isNum(r.aggCadenceHours) ? `${r.aggCadenceHours}h` : '—'),
          ),
          el('div', { className: 'flex min-w-[140px] flex-1 flex-col gap-0.5' },
            el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'rebalances'),
            el('div', { className: 'text-base text-white break-words' }, isNum(r.aggTotalRebalances) ? r.aggTotalRebalances : '—'),
          ),
        );
      } else {
        leftGridChildren.push(
          el('div', { className: 'flex min-w-[140px] flex-1 flex-col gap-0.5' },
            el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'trades'),
            el('div', { className: 'text-base text-white break-words' }, isNum(r.totalTrades) ? r.totalTrades : '—'),
          ),
          el('div', { className: 'flex min-w-[140px] flex-1 flex-col gap-0.5' },
            el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'win rate'),
            el('div', { className: 'text-base text-white break-words' }, isNum(r.successRate) ? fmtPct(r.successRate) : '—'),
          ),
        );
      }

      leftGridChildren.push(
        el('div', { className: 'flex min-w-[140px] flex-1 flex-col gap-0.5' },
          el('div', { className: 'text-xs uppercase tracking-wide text-white/60 whitespace-nowrap' }, 'runtime'),
          el('div', { className: 'text-base text-white break-words' }, isNum(r.aggRuntimeSec) ? humanRuntime(r.aggRuntimeSec as number) : '—'),
        ),
      );

      const leftGrid = el(
        'div',
        { className: 'flex min-w-0 flex-wrap gap-3 items-start' },
        ...leftGridChildren
      );

      const shareBtn = proActive
        ? el(
            SharePLCardButton,
            {
              className: 'ml-3 inline-flex items-center gap-1 rounded-md border border-white/15 bg-fuchsia-600/20 px-2 py-1 text-xs text-white/90 hover:bg-fuchsia-600/30 focus:outline-none focus:ring-1 focus:ring-fuchsia-500/40 md:ml-0',
              'aria-label': 'Share P&L card',
              onClick: (e: any) => {
                e.preventDefault?.();
                try {
                  const url = buildPnlCardUrl({
                    setTitle: title,
                    botType: r.type === 'rebalance' ? 'rebalance' : 'webhooks',
                    totalUsd: isNum(r.aggTotalUsd) ? (r.aggTotalUsd as number) : undefined,
                    pnlUsd: isNum(r.aggPnlUsd) ? (r.aggPnlUsd as number) : undefined,
                    pnlPct: isNum(r.aggPnlPct) ? (r.aggPnlPct as number) : undefined,
                    runtimeSec: isNum(r.aggRuntimeSec) ? (r.aggRuntimeSec as number) : undefined,
                    totalTrades: r.type === 'webhooks' ? (isNum(r.totalTrades) ? (r.totalTrades as number) : undefined) : undefined,
                    wins: r.type === 'webhooks' ? (isNum(r.wins) ? (r.wins as number) : undefined) : undefined,
                    losses: r.type === 'webhooks' ? (isNum(r.losses) ? (r.losses as number) : undefined) : undefined,
                    winRatePct: r.type === 'webhooks' ? (isNum(r.successRate) ? (r.successRate as number) : undefined) : undefined,
                    cadenceHours: r.type === 'rebalance' ? (isNum(r.aggCadenceHours) ? (r.aggCadenceHours as number) : undefined) : undefined,
                    totalRebalances: r.type === 'rebalance' ? (isNum(r.aggTotalRebalances) ? (r.aggTotalRebalances as number) : undefined) : undefined,
                  });
                  setShareImageUrl(url);
                  setShareFilename(`mojomaxi-${r.type}-${r.setId.slice(0, 8)}.png`);
                  setShareDebugId(`${r.type}:${r.setId}`);
                  setShareSetId(r.setId);
                  setShareOpen(true);
                } catch (err) {
                  console.error('share build failed', err);
                }
              },
            },
            el('svg', { viewBox: '0 0 24 24', fill: 'currentColor', className: 'h-4 w-4 text-white/80', 'aria-hidden': 'true' },
              el('path', { fillRule: 'evenodd', d: 'M11.47 2.47a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 1 1-1.06 1.06l-2.72-2.715v8.942a.75.75 0 0 1-1.5 0V5.315L8.53 8.03a.75.75 0 0 1-1.06-1.06l4.5-4.5ZM3 15.75A2.25 2.25 0 0 1 5.25 13.5h13.5A2.25 2.25 0 0 1 21 15.75v3A2.25 2.25 0 0 1 18.75 21H5.25A2.25 2.25 0 0 1 3 18.75v-3Z', clipRule: 'evenodd' })
            )
          )
        : null;

      const headerSmall = el(
        'div',
        { className: 'mb-1 flex items-baseline justify-between gap-2' },
        el('div', { className: 'text-[10px] uppercase tracking-wide text-white/40 break-words' }, displaySmallTitle),
      );

      const rowInner = el(
        'div',
        { className: 'flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:justify-between' },
        leftGrid,
      );

      return el(
        'div',
        { key: r.setId, className: 'rounded-lg border border-white/10 bg-white/5 p-3 min-w-0' },
        headerSmall,
        rowInner,
        el(
          'div',
          { className: 'mt-2 flex items-center justify-end gap-3' },
          shareBtn ? shareBtn : null,
          el('div', { className: 'text-[10px] text-white/40 whitespace-nowrap' }, `created: ${fmtCreated(r.createdAt)}`),
        ),
      );
    })
  );

  return el(
    'section',
    { className: 'rounded-xl border border-white/10 bg-white/5 p-4' },
    totalsHeader,
    rowsList,
    el(SharePLCardPreviewModal, {
      open: shareOpen,
      onClose: () => setShareOpen(false),
      imageUrl: shareImageUrl,
      filename: shareFilename,
      debugId: shareDebugId,
      setId: shareSetId,
    })
  );

}
