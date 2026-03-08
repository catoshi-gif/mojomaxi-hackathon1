// filepath: src/app/api/events/append/route.ts
/**
 * Activity append endpoint (surgical; additive only)
 *
 * GOLDEN RULE RESPECTED:
 *  - Preserves all existing behavior, keys, and write locations.
 *  - Adds robust REBALANCE summary enrichment so the Activity Panel
 *    can show proper token symbols per leg (SOL/USDC/etc.), tx links,
 *    and a frozen Total USD snapped at the end of the run.
 *
 * This version fixes root causes:
 *  • Top‑level signature collection reads from the payload (not just swaps).
 *  • We recover legs from BOTH mm:set:{id}:recent and mm:events:{id} when swaps are absent.
 *  • We treat "weak" symbols (e.g., 'So11', 'CB9d' derived from mint) as missing,
 *    then resolve them by calling /api/tokens/meta and tokenMeta(mint).
 *  • We always set txUrls and totalUsd (via /api/vault/equity with price*balance fallback).
 *
 * Keys preserved:
 *  - mm:set:{setId}:recent
 *  - mm:events:{setId}
 *  - mm:events:recent
 *  - mm:wallet:{wallet}:recent
 */

import 'server-only';
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";


type AnyObj = Record<string, any>;

// -------------------- tiny utils --------------------
function errMsg(e: any): string { return (e?.message || e || "").toString(); }
function toNumber(n: any): number | null { const v = Number(n); return Number.isFinite(v) ? v : null; }
function tinyTxLink(sig?: string | null): string | null { return sig ? `https://solscan.io/tx/${sig}` : null; }
function rpcUrl(): string {
  const env = (process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || process.env.SOLANA_RPC_URL || "").trim();
  return env || "https://api.mainnet-beta.solana.com";
}

// Canonical keys in your app (kept intact)
const KEY_SET_RECENT   = (setId: string) => `mm:set:${setId}:recent`;
const KEY_SET_EVENTS   = (setId: string) => `mm:events:${setId}`;
const KEY_GLOBAL       = `mm:events:recent`;
const KEY_WALLET_RECENT= (wallet: string) => `mm:wallet:${wallet}:recent`;
const KEY_REBAL_SET    = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_REBAL_SET_OLD= (setId: string) => `REBAL_SET:${setId}`; // legacy

async function getJSON(key: string): Promise<any | null> {
  try {
    const v = await (redis as any).json?.get?.(key, "$") as any;
    if (Array.isArray(v) && v.length) return v[0];
    if (v && typeof v === "object") return v;
  } catch {}
  try {
    const raw = await (redis as any).get(key);
    if (typeof raw === "string" && raw.trim().startsWith("{")) return JSON.parse(raw);
  } catch {}
  try {
    const h = await (redis as any).hgetall(key);
    if (h && Object.keys(h).length) return h;
  } catch {}
  return null;
}
async function setJSON(key: string, doc: AnyObj): Promise<void> {
  let ok = false;
  try { await (redis as any).json?.set?.(key, "$", doc); ok = true; } catch {}
  if (!ok) { try { await (redis as any).set(key, JSON.stringify(doc)); ok = true; } catch {} }
  if (!ok) { await (redis as any).hset(key, doc as any); }
}

async function lrangeParseJSON(key: string, start = 0, stop = 199): Promise<any[]> {
  try {
    const arr = await (redis as any).lrange(key, start, stop);
    if (!Array.isArray(arr)) return [];
    return arr.map((x: any) => {
      if (!x) return null;
      try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Price helpers (prefer your lite lib; fallback Dexscreener)
async function pricesByMint(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const uniq = Array.from(new Set((mints || []).filter(Boolean)));
  if (!uniq.length) return out;
  try {
    const mod: any = await import("@/lib/price-lite");
    const fn = (mod.pricesByMintNoCache || mod.pricesByMint) as (m: string[]) => Promise<any>;
    const res = await fn(uniq);
    for (const k of uniq) {
      const v: any = res?.[k];
      const n = typeof v === "number" ? v : Number(v?.price ?? v);
      if (Number.isFinite(n)) out[k] = n;
    }
    if (Object.keys(out).length) return out;
  } catch {}
  try {
    await Promise.all(uniq.map(async (m) => {
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(m)}`, { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        const raw = j?.pairs?.[0]?.priceUsd ?? j?.pairs?.[0]?.priceUSD ?? j?.pairs?.[0]?.price;
        const n = Number(raw);
        if (Number.isFinite(n)) out[m] = n;
      } catch {}
    }));
  } catch {}
  return out;
}

// Additional meta helpers
import { tokenMeta } from "@/lib/price-lite";
import { fetchMintDecimals } from "@/lib/solana-mint";

async function fetchMetaViaApi(origin: string, mints: string[]): Promise<Record<string, { symbol?: string }>> {
  const uniq = Array.from(new Set((mints || []).filter(Boolean)));
  const out: Record<string, { symbol?: string }> = {};
  if (!uniq.length) return out;
  try {
    const url = new URL("/api/tokens/meta", origin);
    url.searchParams.set("mints", uniq.join(","));
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    for (const it of items) {
      const mint = String(it?.mint || it?.address || "").trim();
      const sym  = String(it?.symbol || "").trim();
      if (mint) out[mint] = { symbol: sym || undefined };
    }
  } catch {}
  // Always include WSOL -> SOL sanity
  out["So11111111111111111111111111111111111111112"] = { symbol: "SOL" };
  return out;
}

function isWeakSymbol(sym?: string | null, mint?: string | null): boolean {
  if (!sym) return true;
  const s = String(sym).trim();
  if (!s) return true;
  // Genuine symbols are usually all caps and A-Z0-9 (BONK, JUP, USDC).
  // Weak if contains lowercase or looks like a base58 prefix.
  const hasLower = /[a-z]/.test(s);
  const base58ish = /^[1-9A-HJ-NP-Za-km-z]{3,5}$/.test(s);
  const tooShort = s.length <= 4;
  const mintPrefix = (mint || "").slice(0, 4);
  const equalsMintPrefix = mintPrefix && s === mintPrefix;
  // Treat as strong if it's a common, fully uppercased code even if <=4.
  const strongWhitelist = new Set(["SOL","USDC","USDT","JUP","RAY","WIF","BONK","JTO","TNSR","HNT","SAMO","WEN","PYUSD"]);
  if (strongWhitelist.has(s)) return false;
  return hasLower || equalsMintPrefix || (base58ish && tooShort);
}

function coalesceSymbol(mint?: string | null, ...cands: Array<string | undefined | null>): string | null {
  const WSOL = "So11111111111111111111111111111111111111112";
  const m = (mint || "").trim();

  // IMPORTANT: Treat WSOL as SOL regardless of any provided symbol text.
  // This prevents "dirty" symbols from older sets (or stale client state) from
  // being persisted and later displayed as a strong symbol.
  if (m === WSOL) return "SOL";

  for (const c of cands) {
    if (!c) continue;
    const s = String(c).trim();
    if (!isWeakSymbol(s, mint)) return s;
  }
  return null;
}

// Chain reads for rebalance summary
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveVaultAuthorityPda } from "@/lib/vault-sdk";
import { redis } from "@/lib/redis";

// ADDED: best-effort confirmation helper to ensure swaps land before freezing totals
async function waitForConfirmations(conn: any, sigs: string[], { maxMs = 5000, intervalMs = 400 } = {}): Promise<void> {
  try {
    const deadline = Date.now() + Math.max(1000, maxMs);
    const uniq = Array.from(new Set((sigs || []).filter(Boolean)));
    if (!uniq.length) return;
    while (Date.now() < deadline) {
      const st = await conn.getSignatureStatuses(uniq).catch(() => null);
      if (st && Array.isArray(st.value)) {
        const allDone = st.value.every((v: any) => !!(v && (v.confirmations === null || (v.confirmations ?? 0) >= 1)));
        if (allDone) return;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  } catch {}
}


// -------------- helper: freeze total using /api/vault/equity (with optional vault) --------------
async function freezeTotalUsdViaEquity(origin: string, setId: string, vault?: string | null): Promise<number | null> {
  try {
    const qs = new URLSearchParams({ setId });
    if (vault) qs.set("vault", vault);
    const res = await fetch(`${origin}/api/vault/equity?${qs.toString()}`, { cache: 'no-store', headers: (()=>{const h:any={'x-mm-internal':'1'}; const b=(process.env.VERCEL_AUTOMATION_BYPASS_SECRET||'').trim(); if(b) h['x-vercel-protection-bypass']=b; const a=(process.env.CRON_SECRET?`Bearer ${process.env.CRON_SECRET}`:''); if(a) h['authorization']=a; return h;})() });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({} as any));
    const n = Number(j?.equityUsd ?? j?.totalUsd ?? j?.equity);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// ADDED: tiny sleep + robust equity freeze with retries/backoff
function sleep(ms: number) { return new Promise(res => setTimeout(res, Math.max(0, ms|0))); }

async function freezeTotalUsdWithRetry(origin: string, setId: string, vault: string | undefined, fallbackTotal: number): Promise<{ total: number, source: "equity_api" | "sum_price" | "none" }> {
  // Try equity endpoint up to 3 times with backoff; if no luck, fall back to priced sum.
  const tries = [0, 700, 1400];
  for (let i = 0; i < tries.length; i++) {
    const v = await freezeTotalUsdViaEquity(origin, setId, vault);
    if (Number.isFinite(v) && v !== null && (v as any) !== undefined) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        return { total: n, source: "equity_api" };
      }
      // accept zero if fallback is also zero
      if (Number.isFinite(n) && n === 0 && !(fallbackTotal > 0)) {
        return { total: 0, source: "equity_api" };
      }
    }
    if (i < tries.length - 1) await sleep(tries[i+1]);
  }
  // Fallback
  const f = Number(fallbackTotal);
  if (Number.isFinite(f)) return { total: f, source: "sum_price" };
  return { total: 0, source: "none" };
}



type Pair = {
  inMint?: string | null;
  outMint?: string | null;
  inSymbol?: string | null;
  outSymbol?: string | null;
  inputSymbol?: string | null;  // alias for client compatibility
  outputSymbol?: string | null; // alias for client compatibility
  amountInUi?: number | null;
  amountOutUi?: number | null;
  inUsdPrice?: number | null;
  outUsdPrice?: number | null;
  inTotalUsd?: number | null;
  outTotalUsd?: number | null;
  usdIn?: number | null;
  usdOut?: number | null;
  txUrl?: string | null;
};

// Build pairs from provided swaps
async function pairsFromSwaps(swaps: any[], origin: string): Promise<Pair[]> {
  const pairs: Pair[] = [];
  const mintSet: string[] = [];
  for (const s of (Array.isArray(swaps) ? swaps : [])) {
    const inMint  = s.inputMint  ?? s.inMint  ?? s.mintIn  ?? null;
    const outMint = s.outputMint ?? s.outMint ?? s.mintOut ?? null;
    if (inMint) mintSet.push(String(inMint));
    if (outMint) mintSet.push(String(outMint));
  }
  const metaByTokenApi = await fetchMetaViaApi(origin, mintSet);
  const metaByTokenLite: Record<string, { symbol?: string }> = {};
  for (const m of Array.from(new Set(mintSet))) {
    try { metaByTokenLite[m] = { symbol: (await tokenMeta(m))?.symbol }; } catch { metaByTokenLite[m] = {}; }
  }

  for (const s of (Array.isArray(swaps) ? swaps : [])) {
    const inMint  = s.inputMint  ?? s.inMint  ?? s.mintIn  ?? null;
    const outMint = s.outputMint ?? s.outMint ?? s.mintOut ?? null;

    // candidate symbols from payload, API, lite
    const inSymCand  = s.inputSymbol  ?? s.inSymbol  ?? s.baseSymbol  ?? s.base  ?? s.tokenIn?.symbol;
    const outSymCand = s.outputSymbol ?? s.outSymbol ?? s.quoteSymbol ?? s.quote ?? s.tokenOut?.symbol;
    const inSym = coalesceSymbol(inMint, inSymCand, metaByTokenApi[String(inMint||"")]?.symbol, metaByTokenLite[String(inMint||"")]?.symbol);
    const outSym= coalesceSymbol(outMint, outSymCand, metaByTokenApi[String(outMint||"")]?.symbol, metaByTokenLite[String(outMint||"")]?.symbol);

    const amountInUi  = (s.amountInUi  ?? s.inAmountUi  ?? s.uiAmountIn  ?? s.uiIn  ?? s.inUi  ?? null);
    const amountOutUi = (s.amountOutUi ?? s.outAmountUi ?? s.uiAmountOut ?? s.uiOut ?? s.outUi ?? null);

    const usdIn  = [s.usdIn, s.inTotalUsd, s.inputUsd, s.inUsd].map(Number).find(Number.isFinite);
    const usdOut = [s.usdOut, s.outTotalUsd, s.outputUsd, s.outUsd].map(Number).find(Number.isFinite);

    const txSig = (s.signature ?? s.sig ?? s.tx ?? s.txSignature ?? s.transaction ?? null) as any;

    pairs.push({
      inMint, outMint,
      inSymbol: inSym, outSymbol: outSym,
      inputSymbol: inSym, outputSymbol: outSym,
      amountInUi: Number.isFinite(Number(amountInUi)) ? Number(amountInUi) : null,
      amountOutUi: Number.isFinite(Number(amountOutUi)) ? Number(amountOutUi) : null,
      usdIn: Number.isFinite(Number(usdIn)) ? Number(usdIn) : null,
      usdOut: Number.isFinite(Number(usdOut)) ? Number(usdOut) : null,
      txUrl: typeof s.txUrl === "string" ? s.txUrl : tinyTxLink(typeof txSig === "string" ? txSig : null),
    });
  }
  return pairs;
}

// Recover pairs from recent SWAP_REBALANCE rows (by signatures OR time window)
async function pairsFromRecent(setId: string, sigs: string[], tsBase: number, origin: string): Promise<Pair[]> {
  const lists = await Promise.all([
    lrangeParseJSON(KEY_SET_RECENT(setId), 0, 199),
    lrangeParseJSON(KEY_SET_EVENTS(setId), 0, 199),
  ]);
  const merged: any[] = [...lists[0], ...lists[1]];

  const isSwapRow = (row: any) => {
    const tag = String(row?.message || row?.kind || row?.type || "").toUpperCase();
    return tag.includes("SWAP_REBALANCE");
  };

  // Build a map by signature for fast recovery when sigs are provided
  const bySig: Record<string, any> = {};
  for (const r of merged) {
    if (!isSwapRow(r)) continue;
    const s1 = (r?.signature || r?.sig || r?.tx) as string | undefined;
    let sig: string | undefined = s1;
    if (!sig && typeof r?.txUrl === "string" && r.txUrl.includes("/tx/")) {
      sig = r.txUrl.split("/tx/")[1];
    }
    if (sig) bySig[String(sig).trim()] = r;
  }

  const chosen: any[] = [];
  if (Array.isArray(sigs) && sigs.length) {
    for (const s of sigs) {
      const row = bySig[s];
      if (row) chosen.push(row);
    }
  }

  // If nothing matched by signatures, fall back to time window (±120s)
  if (!chosen.length) {
    const WINDOW = 120_000;
    const start = tsBase - WINDOW;
    const end   = tsBase + WINDOW;
    for (const r of merged) {
      if (!isSwapRow(r)) continue;
      const t = Number(r?.ts || 0);
      if (t >= start && t <= end) chosen.push(r);
    }
  }

  // Resolve symbols via tokens meta + tokenMeta if missing or weak
  const mintSet: string[] = [];
  for (const r of chosen) {
    const im = r?.inputMint ?? r?.inMint; const om = r?.outputMint ?? r?.outMint;
    if (im) mintSet.push(String(im)); if (om) mintSet.push(String(om));
  }
  const metaApi = await fetchMetaViaApi(origin, Array.from(new Set(mintSet)));
  const pairs: Pair[] = chosen.map((row) => {
    const inMint  = row?.inputMint  ?? row?.inMint  ?? null;
    const outMint = row?.outputMint ?? row?.outMint ?? null;

    const inCand  = row?.inputSymbol  ?? row?.inSymbol  ?? null;
    const outCand = row?.outputSymbol ?? row?.outSymbol ?? null;

    const inSym = coalesceSymbol(inMint, inCand, metaApi[String(inMint||"")]?.symbol);
    const outSym= coalesceSymbol(outMint, outCand, metaApi[String(outMint||"")]?.symbol);

    const amountInUi  = Number.isFinite(Number(row?.amountInUi))  ? Number(row.amountInUi)  : null;
    const amountOutUi = Number.isFinite(Number(row?.amountOutUi)) ? Number(row.amountOutUi) : null;
    const usdIn  = Number.isFinite(Number(row?.inTotalUsd))  ? Number(row.inTotalUsd)  :
                   Number.isFinite(Number(row?.usdIn))       ? Number(row.usdIn)       : null;
    const usdOut = Number.isFinite(Number(row?.outTotalUsd)) ? Number(row.outTotalUsd) :
                   Number.isFinite(Number(row?.usdOut))      ? Number(row.usdOut)      : null;

    const sig = (row?.signature || row?.sig || row?.tx) as string | undefined;
    const txUrl = row?.txUrl || tinyTxLink(sig || (typeof row?.txUrl === "string" && row.txUrl.includes("/tx/") ? row.txUrl.split("/tx/")[1] : null));

    return {
      inMint, outMint,
      inSymbol: inSym, outSymbol: outSym,
      inputSymbol: inSym, outputSymbol: outSym,
      amountInUi, amountOutUi,
      usdIn, usdOut,
      txUrl: typeof txUrl === "string" ? txUrl : null,
    };
  });

  return pairs;
}

// -------------- existing simple events (DEPOSIT/WITHDRAW) --------------
async function appendSimpleEvent(params: {
  setId: string;
  wallet?: string | null;
  kindRaw: string;
  mint?: string | null;
  symbolIn?: string | null;
  decimals?: number | null;
  amountUi?: number | null;
  tx?: string | null;
  txUrlsNorm?: string[] | null;
  headlineCompact?: string | null;
}) {
  const { setId, wallet, kindRaw, mint, symbolIn, decimals, amountUi, tx, txUrlsNorm, headlineCompact } = params;
  const kind = (kindRaw || "").toUpperCase();

  // Normalize txUrls for multi-tx events (optional; preserves legacy behavior)
  const txUrlsNormSafe: string[] | null = Array.isArray(txUrlsNorm) ? txUrlsNorm.filter(Boolean).map((u) => String(u)) : null;


  // Resolve symbol if not provided (surgical; non-breaking)
  let inputSymbol: string | null = symbolIn ?? null;
  if (!inputSymbol && mint) {
    try {
      const meta = await tokenMeta(mint);
      inputSymbol = meta?.symbol || null;
      if (isWeakSymbol(inputSymbol, mint)) inputSymbol = null;
    } catch {}
  // If still missing, fall back to a short mint so DEPOSIT/WITHDRAW rows don’t get filtered out.
  if (!inputSymbol && mint) {
    const mm = String(mint);
    inputSymbol = mm.length > 8 ? `${mm.slice(0, 4)}…${mm.slice(-4)}` : mm;
  }

  }

  // Freeze USD unit + total
  let inUsdPrice: number | null = null;
  try {
    if (mint) {
      const map = await pricesByMint([mint]);
      if (Number.isFinite(map[mint])) inUsdPrice = Number(map[mint]);
    }
  } catch {}
  const inTotalUsd = (inUsdPrice != null && amountUi != null && Number.isFinite(amountUi)) ? (inUsdPrice * amountUi!) : null;

  const now = Date.now();
  const row: AnyObj = {ts: now,
    setId,
    kind,
    direction: undefined,
    source: "mojomaxi",
    ok: true,
    tx: tx || null,
    txUrl: tx ? `https://solscan.io/tx/${tx}` : null,
    txUrls: txUrlsNormSafe && txUrlsNormSafe.length ? txUrlsNormSafe : null,
    headlineCompact: (typeof headlineCompact === "string" && headlineCompact.trim()) ? headlineCompact.trim() : undefined,

    inputMint: mint ?? null,
    outputMint: mint ?? null,
    inputSymbol: inputSymbol ?? null,
    outputSymbol: inputSymbol ?? null,
    inSymbol: inputSymbol ?? null,
    outSymbol: inputSymbol ?? null,

    inputDecimals: typeof decimals === "number" ? decimals : undefined,
    outputDecimals: typeof decimals === "number" ? decimals : undefined,

    amountInUi: amountUi ?? null,
    amountOutUi: amountUi ?? null,

    inUsdPrice: inUsdPrice ?? undefined,
    outUsdPrice: inUsdPrice ?? undefined,
    inTotalUsd: inTotalUsd ?? undefined,
    outTotalUsd: inTotalUsd ?? undefined,
  };

  // Writes (identical to golden)
  const rowJson = JSON.stringify(row);
  const pipe0: any = (redis as any).pipeline?.();
  if (pipe0 && typeof pipe0.exec === "function") {
    pipe0.lpush(KEY_SET_RECENT(setId), rowJson);
    pipe0.ltrim(KEY_SET_RECENT(setId), 0, 199);
    pipe0.lpush(KEY_SET_EVENTS(setId), rowJson);
    pipe0.ltrim(KEY_SET_EVENTS(setId), 0, 199);
    pipe0.lpush(KEY_GLOBAL, rowJson);
    pipe0.ltrim(KEY_GLOBAL, 0, 499);
    await pipe0.exec();
  } else {
    await (redis as any).lpush(KEY_SET_RECENT(setId), rowJson);
    await (redis as any).ltrim(KEY_SET_RECENT(setId), 0, 199);
    await (redis as any).lpush(KEY_SET_EVENTS(setId), rowJson);
    await (redis as any).ltrim(KEY_SET_EVENTS(setId), 0, 199);
    await (redis as any).lpush(KEY_GLOBAL, rowJson);
    await (redis as any).ltrim(KEY_GLOBAL, 0, 499);
  }

  
  // ADDED (mirror writes for broader reader compatibility)
  try {
    const pipe1: any = (redis as any).pipeline?.();
    if (pipe1 && typeof pipe1.exec === "function") {
      pipe1.lpush(`mm:set:${setId}:events`, rowJson);
      pipe1.ltrim(`mm:set:${setId}:events`, 0, 199);
      pipe1.lpush(`mm:set:set_${setId}:events`, rowJson);
      pipe1.ltrim(`mm:set:set_${setId}:events`, 0, 199);
      pipe1.lpush(`mm:set:set-${setId}:events`, rowJson);
      pipe1.ltrim(`mm:set:set-${setId}:events`, 0, 199);
      await pipe1.exec();
    } else {
      await (redis as any).lpush(`mm:set:${setId}:events`, rowJson);
      await (redis as any).ltrim(`mm:set:${setId}:events`, 0, 199);
      await (redis as any).lpush(`mm:set:set_${setId}:events`, rowJson);
      await (redis as any).ltrim(`mm:set:set_${setId}:events`, 0, 199);
      await (redis as any).lpush(`mm:set:set-${setId}:events`, rowJson);
      await (redis as any).ltrim(`mm:set:set-${setId}:events`, 0, 199);
    }
  } catch {}
if (wallet) {
    try { await (redis as any).sadd(`mm:wallet:${wallet}:sets`, setId); } catch {}
    try {
      const listKey = `mm:wh:sets:${wallet}:list`;
      const cur: any[] = await (redis as any).lrange(listKey, 0, -1).catch(() => []);
      if (!Array.isArray(cur) || !cur.includes(setId)) await (redis as any).lpush(listKey, setId);
    } catch {}
  }
}

// -------------- NEW: rebalance summary appender --------------
async function appendRebalanceSummaryUnsafe(params: {
  setId: string;
  wallet?: string | null;
  swaps: AnyObj[] | null | undefined;
  reqOrigin: string;
  tsBase: number;
  payload: AnyObj;
}) {
  const { setId, wallet, swaps, reqOrigin, tsBase, payload } = params;

  // Load set
  const setDoc = await getJSON(KEY_REBAL_SET(setId)) || await getJSON(KEY_REBAL_SET_OLD(setId));
  if (!setDoc) throw new Error("rebalance_set_not_found");
  const ownerWallet: string | undefined = String(setDoc.wallet || wallet || "").trim() || undefined;
  // ADD: per-run nonce propagated from planner
  const runId: string | undefined = (typeof (payload as any)?.runId === 'string' && (payload as any).runId.trim()) || undefined;
  const expectedLegs: number | undefined = Number.isFinite(Number((payload as any)?.expectedLegs)) ? Number((payload as any).expectedLegs) : undefined;
  // Ensure correct wallet index segregation for REBALANCE sets:
  // - Add to mm:rebal:wallet:{wallet}:sets
  // - Remove from webhook indices (mm:wallet:{wallet}:sets and mm:wh:sets:{wallet}:list)
  try {
    const who = ownerWallet || (wallet ? String(wallet).trim() : '');
    if (who) {
      try { await (redis as any).sadd(`mm:rebal:wallet:${who}:sets`, setId); } catch {}
      try { await (redis as any).srem(`mm:wallet:${who}:sets`, setId); } catch {}
      try { await (redis as any).lrem(`mm:wh:sets:${who}:list`, 0, setId); } catch {}
    }
  } catch {}

  const vault: string | undefined = String(setDoc.vault || (payload?.vault ?? '')).trim() || undefined;
  const mints: string[] = Array.isArray(setDoc.mints) ? setDoc.mints.filter((m: any) => String(m || "").trim()).map((m: any) => String(m)) : [];
  if (!vault || !mints.length) throw new Error("rebalance_set_incomplete");

  // Derive authority
  const programIdStr = (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID || "").trim();
  if (!programIdStr) throw new Error("missing_program_id");
  const programId = new PublicKey(programIdStr);
  const [authorityPda] = deriveVaultAuthorityPda(programId, new PublicKey(vault));

  // Ensure ATAs (best-effort)
  try { await (await import("@/lib/vault-atas.server")).ensureVaultAtasForMints({ wallet: ownerWallet || "unknown", vault, mints }); } catch {}

  // RPC & balances
  const conn = new Connection(rpcUrl(), { commitment: "processed" });
  // UI balances
  const uiByMint: Record<string, number> = {};
  for (const m of mints) {
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(m), authorityPda, true);
      const bal = await conn.getTokenAccountBalance(ata).catch(() => null as any);
      const uiStr = (bal?.value?.uiAmountString ?? "").toString();
      const uiNum = uiStr ? Number(uiStr) : Number(bal?.value?.uiAmount ?? 0);
      uiByMint[m] = Number.isFinite(uiNum) ? uiNum : 0;
    } catch { uiByMint[m] = 0; }
  }

  // Prices + fallback USD totals
  const px = await pricesByMint(mints);
  const usdByMint: Record<string, number> = {};
  let totalUsdFallback = 0;
  for (const m of mints) {
    const p = Number(px[m] ?? 0);
    const ui = Number(uiByMint[m] ?? 0);
    const usd = Number.isFinite(p) && Number.isFinite(ui) ? p * ui : 0;
    usdByMint[m] = usd;
    totalUsdFallback += usd;
  }

  
  // Try preferred equity endpoint for the frozen total, else fall back (with retries)
  const freezeRes = await freezeTotalUsdWithRetry(reqOrigin, setId, vault, totalUsdFallback);
  const totalUsd = freezeRes.total;
  const equitySource = freezeRes.source;


  // P&L since first + since last
  const nowIso = new Date().toISOString();
  const startingTotalUsd =
    Number.isFinite(Number(setDoc?.startingTotalUsd)) && Number(setDoc.startingTotalUsd) > 0
      ? Number(setDoc.startingTotalUsd)
      : totalUsd;
  const prevTotalUsd =
    Number.isFinite(Number(setDoc?.lastTotalUsd)) ? Number(setDoc.lastTotalUsd) : startingTotalUsd;

  const pnlUsd = totalUsd - startingTotalUsd;
  const pnlPct = startingTotalUsd > 0 ? (pnlUsd / startingTotalUsd) : 0;        // FRACTION (not %)
  const pnlLastUsd = totalUsd - prevTotalUsd;
  const pnlLastPct = prevTotalUsd > 0 ? (pnlLastUsd / prevTotalUsd) : 0;        // FRACTION (not %)

  // Signatures & tiny links (from swaps and/or top-level fields on the payload)
  const sigs: string[] = [];
  // 1) From swaps (per leg)
  if (Array.isArray(swaps)) {
    for (const s of swaps) {
      const v = String(s?.signature || s?.sig || s?.tx || s?.txSignature || "").trim();
      if (v) sigs.push(v);
    }
  }
  // 2) From payload top-level
  for (const f of ["signatures", "sigs", "txs", "txSignatures"]) {
    const arr: any[] = Array.isArray((payload as any)?.[f]) ? (payload as any)[f] : [];
    for (const s of arr) {
      const v = String(s || "").trim();
      if (v) sigs.push(v);
    }
  }
  // Ensure uniqueness
  const sigsUniq = Array.from(new Set(sigs));

  
  // ADDED: wait briefly for confirmations so equity reflects post-swap balances
  try {
    const { Connection } = await import('@solana/web3.js');
    const conn = new Connection(rpcUrl(), { commitment: 'confirmed' });
    await waitForConfirmations(conn, sigsUniq, { maxMs: 6000, intervalMs: 400 });
  } catch {}
// Pairs (prefer provided swaps; else recover from recent)
  let rebalancePairs: Pair[] | undefined = undefined;
  try {
    if (Array.isArray(swaps) && swaps.length) {
      rebalancePairs = await pairsFromSwaps(swaps, reqOrigin);
    }
    if ((!rebalancePairs || rebalancePairs.length === 0)) {
      rebalancePairs = await pairsFromRecent(setId, sigsUniq, tsBase, reqOrigin);
    }
  } catch {}

  // Top-level txUrls (from provided signatures or from pairs)
  let txUrls: string[] = sigsUniq.map(tinyTxLink).filter(Boolean) as string[];
  if ((!txUrls || txUrls.length === 0) && Array.isArray(rebalancePairs)) {
    const urls = (rebalancePairs.map(p => p.txUrl).filter(Boolean) as string[]);
    txUrls = Array.from(new Set(urls));
  }

  const row: AnyObj = {
    ts: tsBase,
    ...(Array.isArray((payload as any)?.swapNonces) && (payload as any).swapNonces.length ? { rebalanceNonce: String((payload as any).swapNonces[0]) } : (typeof (payload as any)?.rebalanceNonce !== 'undefined' ? { rebalanceNonce: String((payload as any).rebalanceNonce) } : {})),
    setId,
    kind: "REBALANCE",
    aggregated: true,
    ...(runId ? { runId } : {}),
    wallet: ownerWallet || null,
    source: "rebalance",
    ok: Array.isArray(swaps) ? swaps.every((s: any) => !!s?.ok) : true,
    txUrl: txUrls?.[0] || null,
    txUrls: txUrls || [],

    totalsUiByMint: uiByMint,
    totalsUsdByMint: usdByMint,
    totalUsd,
    // ADDED: include baseline and P&L vs first rebalance
    startingTotalUsd,
    pnlUsd,
    pnlPct,

    
    // Diagnostics
    equitySource: (typeof equitySource !== "undefined" ? equitySource : undefined),
    equityFrozenAtTs: Date.now(),



    // Delta since last
    pnlLastUsd,
    pnlLastPct,

    // Per-swap details (optional)
    rebalancePairs,
  };

  // Persist set doc
  const nextSet = {
    ...(runId ? { lastRunId: runId } : {}),
    ...setDoc,
    lastRebalanceAt: Date.now(),
    lastTotalsUiByMint: uiByMint,
    lastTotalsUsdByMint: usdByMint,
    lastTotalUsd: totalUsd,
    startingTotalUsd,
    pnlUsd,
    pnlPct,
    lastSigList: sigsUniq,
    updatedAt: nowIso,
    prevTotalUsd, // for reference
  };
  await setJSON(KEY_REBAL_SET(setId), nextSet);
  // ADDED (mirror writes for broader reader compatibility)
  try { await (redis as any).lpush(`mm:set:${setId}:events`, JSON.stringify(row)); await (redis as any).ltrim(`mm:set:${setId}:events`, 0, 199); } catch {}
  try { await (redis as any).lpush(`mm:set:set_${setId}:events`, JSON.stringify(row)); await (redis as any).ltrim(`mm:set:set_${setId}:events`, 0, 199); } catch {}
  try { await (redis as any).lpush(`mm:set:set-${setId}:events`, JSON.stringify(row)); await (redis as any).ltrim(`mm:set:set-${setId}:events`, 0, 199); } catch {}


  // Append to streams (unchanged keys)
  await (redis as any).lpush(KEY_SET_RECENT(setId), JSON.stringify(row));
  await (redis as any).ltrim(KEY_SET_RECENT(setId), 0, 199);
  await (redis as any).lpush(KEY_SET_EVENTS(setId), JSON.stringify(row));
  await (redis as any).ltrim(KEY_SET_EVENTS(setId), 0, 199);
  await (redis as any).lpush(KEY_GLOBAL, JSON.stringify(row));
  await (redis as any).ltrim(KEY_GLOBAL, 0, 499);
  // ADDED: mirror minimal marker into wallet recent to help wallet-scoped views discover rebalance summary
  if (ownerWallet) {
    try { await (redis as any).lpush(KEY_WALLET_RECENT(ownerWallet), JSON.stringify({ ts: tsBase, setId, kind: "REBALANCE" })); } catch {}
    try { await (redis as any).ltrim(KEY_WALLET_RECENT(ownerWallet), 0, 199); } catch {}
  }


  if (ownerWallet) {
    // For REBALANCE sets, index under the *rebalance* wallet index and clean up any webhook indices
    try { await (redis as any).sadd(`mm:rebal:wallet:${ownerWallet}:sets`, setId); } catch {}

    // Ensure we do NOT pollute the webhook index (this caused duplicate "webhook" bots to appear)
    try { await (redis as any).srem(`mm:wallet:${ownerWallet}:sets`, setId); } catch {}
    try {
      const listKey = `mm:wh:sets:${ownerWallet}:list`;
      // remove all occurrences if present
      try { await (redis as any).lrem(listKey, 0, setId); } catch {}
    } catch {}
  }
}

// Thin wrapper to preserve call sites that expect `appendRebalanceSummary`
// (no behavior change; delegates to the unsafe implementation)
async function appendRebalanceSummary(params: {
  setId: string;
  wallet?: string | null;
  swaps: AnyObj[] | null | undefined;
  reqOrigin: string;
  tsBase: number;
  payload: AnyObj;
}) {
  return appendRebalanceSummaryUnsafe(params);
}


// -------------- HTTP handler --------------
// wrapper added below
export async function POST(req: NextRequest) {
  try {
    const j = await req.json().catch(() => ({} as any));
    const setId   = String(j?.setId || "").trim();
    const kindRaw = String(j?.kind || j?.type || "").trim();
    if (!setId) return NextResponse.json({ ok: false, error: "missing setId" }, { status: 400 });

    // Fast-path: rebalance summary (additive)
    if (/^rebalance(_execute)?$/i.test(kindRaw) || (Array.isArray(j?.swaps) && j?.swaps?.length > 0) || Array.isArray(j?.signatures) || Array.isArray(j?.sigs)) {
      const origin = new URL(req.url).origin;
      const tsBase = Number(j?.ts) && Number.isFinite(Number(j.ts)) ? Number(j.ts) : Date.now();
      await appendRebalanceSummary({
        setId,
        wallet: typeof j?.wallet === "string" ? j.wallet : undefined,
        swaps: Array.isArray(j?.swaps) ? j.swaps : [],
        reqOrigin: origin,
        tsBase,
        payload: j,
      });
      return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } });
    }

    // Simple legacy events (DEPOSIT/WITHDRAW)
    const mint      = String(j?.mint || j?.tokenMint || j?.inputMint || "").trim() || null;
    const symbolIn  = (j?.symbol ?? j?.inputSymbol ?? j?.inSymbol ?? null) as string | null;
    const decimalsR = j?.decimals ?? j?.inputDecimals ?? null;
    let decimals: number | null = (decimalsR != null && Number.isFinite(Number(decimalsR))) ? Number(decimalsR) : null;
    const amountUi  = toNumber(j?.amountUi ?? j?.amountInUi ?? j?.inAmountUi ?? j?.amount ?? j?.uiAmount ?? null);
    let tx        = (j?.tx || j?.txSignature || null) as string | null;
    const txUrlsIn  = Array.isArray((j as any)?.txUrls) ? ((j as any).txUrls as any[]) : null;
    const txUrls = txUrlsIn
      ? (Array.from(new Set(txUrlsIn.map((v) => String(v || "").trim()).filter(Boolean))).slice(0, 12))
      : null;

    // If caller sent urls but not tx, derive a representative tx for legacy UI fields.
    if (!tx && txUrls && txUrls.length) {
      const first = String(txUrls[0] || "");
      const m = first.match(/solscan\.io\/tx\/([A-Za-z0-9]{20,})/i);
      if (m && m[1]) tx = m[1];
      else if (/^[A-Za-z0-9]{20,}$/.test(first)) tx = first;
    }

    const txUrlsNorm = txUrls
      ? txUrls
          .map((v) => {
            const s = String(v || "").trim();
            if (!s) return null;
            if (/^https?:\/\//i.test(s)) return s;
            if (/^[A-Za-z0-9]{20,}$/.test(s)) return `https://solscan.io/tx/${s}`;
            return null;
          })
          .filter(Boolean)
      : null;
    const wallet    = (typeof j?.wallet === "string") ? j.wallet.trim() : undefined;

    if (wallet) {
      try { await (redis as any).lpush(KEY_WALLET_RECENT(wallet), JSON.stringify({ ts: Date.now(), setId, kind: kindRaw })); } catch {}
      try { await (redis as any).ltrim(KEY_WALLET_RECENT(wallet), 0, 199); } catch {}
    }

    if (decimals == null && mint) {
      try {
        const d = await fetchMintDecimals(mint);
        if (d != null) decimals = d;
      } catch {}
    }

    await appendSimpleEvent({ setId, wallet, kindRaw, mint, symbolIn, decimals, amountUi, tx, txUrlsNorm, headlineCompact: (typeof (j as any)?.headlineCompact === "string" ? String((j as any).headlineCompact) : null) });
    return NextResponse.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "append_failed", detail: errMsg(e) }, { status: 500 });
  }
}
