// FULL FILE REPLACEMENT for: src/app/rebalance/_components/RebalanceInlinePanel.tsx
'use client';

// filepath: src/app/rebalance/_components/RebalanceInlinePanel.tsx
// FULL FILE REPLACEMENT for: src/app/rebalance/_components/RebalanceInlinePanel.tsx
// Fix: remove extra closing brace in <img onError> and <img onLoad> handlers to resolve Next.js build error.
// Retains all existing UI and functionality exactly as before.
import { registerVisibleMints } from '@/app/_lib/tokenRegistry';

// Panels can receive gentle "retry" nudges from the app header to re-fetch missing USD prices.
// This is intentionally NO-RPC (uses /api/prices) and is throttled.
type _MM_EquityRefreshEvent = CustomEvent<{ setIds?: string[] }>;

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

const USD_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtUsd(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "$–";
  return USD_FMT.format(n);
}

function _mmUsdNode(n: number | undefined, ready: boolean, showLoadingPlaceholders: boolean): React.ReactNode {
  if (showLoadingPlaceholders && !ready) {
    return (
      <span
        className="inline-flex items-center justify-end w-full text-brandPurple/80"
        title="Loading…"
        aria-label="Loading…"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-90"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </span>
    );
  }
  return fmtUsd(n);
}

function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const hh = Math.floor(total / 3600).toString().padStart(2, "0");
  const mm = Math.floor((total % 3600) / 60).toString().padStart(2, "0");
  const ss = Math.floor(total % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// --- Jupiter desktop compatibility helper: sendTransaction -> signTransaction fallback ---
async function _mmSendWithJupiterFallback(
  sendFn: ((tx: any, conn: any, opts?: any) => Promise<string>) | undefined,
  signFn: ((tx: any) => Promise<any>) | undefined,
  tx: any,
  conn: any,
  opts?: any
): Promise<string> {
  if (typeof sendFn === "function") {
    try {
      return await sendFn(tx, conn, opts);
    } catch (e: any) {
      const msg = (e && (e.message || String(e))) || "";
      if (typeof signFn === "function" && typeof msg === "string" && msg.toUpperCase().includes("NOT IMPLEMENTED YET")) {
        const signed = await signFn(tx);
        return await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      }
      throw e;
    }
  }
  if (typeof signFn === "function") {
    const signed = await signFn(tx);
    return await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  }
  throw new Error("Wallet adapter missing sendTransaction/signTransaction.");
}


function cadenceToMs(cadence?: string | null): number { 
  return hoursToMs(cadenceToHours(cadence)); 
}

/** Balance helpers (no UI changes) */
function uiFromTokenBal(bal: any): number {
  try {
    if (typeof bal === "number") return Number.isFinite(bal) ? bal : 0;
    if (bal && typeof bal === "object") {
      const v: any = (bal as any).value ?? bal;
      if (typeof v?.uiAmount === "number") return v.uiAmount;
      const dec = Number(v?.decimals ?? NaN);
      const amtStr = (v as any)?.amount;
      if (typeof amtStr === "string" && Number.isFinite(dec) && dec >= 0) {
        const amt = Number(amtStr);
        if (Number.isFinite(amt)) return amt / Math.pow(10, dec);
      }
    }
  } catch {}
  return 0;
}

// --- balance helpers ---
// Many call sites historically treated cachedGetTokenAccountBalance() as returning a number.
// In reality, web3.js returns a TokenAmount-shaped object ({ value: { uiAmount, amount, decimals } }).
// To preserve existing behavior and fix 0 balances, coerce either shape into a UI number.

/**
 * RebalanceInlinePanel.tsx — wallet panel restored + single-run Start + in-flight banner
 *
 * SACRED RULES RESPECTED:
 * - Existing UI is preserved. This only restores the Wallet panel that used to sit next to the Vault panel,
 *   adds the previously requested "please wait, rebalancing… Ns" banner, and keeps the Start button
 *   hidden while a rebalance is running to prevent double-clicks.
 * - Functionality is retained; no breaking changes. Deposits/withdraws and Start/Stop work as before.
 */

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  getAssociatedTokenAddressSync,
  getMint,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { cachedGetBalance, cachedGetTokenAccountBalance, cachedGetAccountInfoOwner, cachedGetMint, purgeRpcCache } from "@/lib/rpc-cache";
import { deriveVaultAuthorityPda, ensureConnection, depositToVault, depositToVaultWithSend } from "@/lib/vault-sdk";
import { useStartRebalance } from "@/app/rebalance/_components/hooks/useStartRebalance";
import { usePollingGate, withJitterMs } from "@/lib/useActivityGate";
import { createVaultForSet } from "@/lib/mm-vault-create";

// --- global client cache (shared across multiple panels on the page) ---
// ---- constants ----


// Soft-confirm with a strict time budget so mobile UIs never "hang" waiting for RPC.
// Returns true only if confirmation completes within the budget; otherwise false.
// Never throws.
async function _mmSoftConfirm(conn: any, sig: string, timeoutMs: number = 8000): Promise<boolean> {
  try {
    const t = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(0, timeoutMs)));
    const c = (async () => {
      try {
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
        await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        return true;
      } catch {
        return false;
      }
    })();
    return await Promise.race([t, c]);
  } catch {
    return false;
  }
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
// Minimal mint label map used only for UI fallbacks (no behavior change)
const DEX_CACHE_TTL_MS = 60_000;

// NEW (iOS): detect iOS to tune concurrency/batch sizes
const _IS_IOS_R =
  typeof navigator !== "undefined" &&
  (
    /iP(hone|ad|od)/i.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1)
  );
const _DEX_CHUNK_R = _IS_IOS_R ? 15 : 30;  // smaller batches for iOS
const _META_CONC_R = _IS_IOS_R ? 2  : 4;   // lower per-mint concurrency on iOS

type Cadence = "1h" | "2h" | "6h" | "12h" | "24h";

type BalanceRow = {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  decimals: number;
  userUi: number;   // user's wallet balance (UI tokens)
  vaultUi: number;  // vault authority balance (UI tokens)
  usd?: number;     // price per 1.0 UI token (USD)
};

type Props = {
  /** Optional: parent can observe status + vault totals to decide UI (e.g., hide delete). */
  onState?: (info: { setId: string; status?: 'running'|'paused'|'stopped'; vaultUiSum?: number; vaultUsdTotal?: number; equityReady?: boolean; balancesReady?: boolean; hasVault?: boolean; timestamp: number }) => void;
  setId: string;
  /** Owner wallet base58 (legacy). Prefer walletShim for in-app browsers to avoid adapter flicker. */
  wallet?: string;               // owner wallet (case sensitive; never lowercase)
  /** Wallet-adapter like shim from parent (preferred). */
  walletShim?: { publicKey?: any; sendTransaction?: any; signTransaction?: any; signAllTransactions?: any } | null;
  vaultAddress?: string | null; // PDA (string) if already known
  mints: string[];              // 2–6 token mint addresses (parent controls SOL vs. no-SOL based on tier)
  cadence?: Cadence | string | null;
  createdAt?: number | null;
  onResolvedSymbols?: (map: Record<string, string>) => void;
  /** When true (e.g., dashboard Total Equity is still 'Loading…'), hide transient $0.00 values and show a tiny clock placeholder instead. */
  showLoadingPlaceholders?: boolean;
  deferHeavy?: boolean;
};

// ---- helpers ----
// Lightweight token meta + price helpers (mirrors VaultInlinePanel behavior)
// We keep a tiny in-memory cache with ~55s TTL and refresh every 60s.
type _MM_TokenMeta_R = { address: string; name?: string; symbol?: string; decimals?: number };
const _mmMeta_R = new Map<string, { v: _MM_TokenMeta_R; t: number }>();
const _mmPrice_R = new Map<string, { v: number; t: number }>();
const _MM_TTL_R = 55_000;

// ---- in-flight dedupe (prevents duplicate /api/prices + /api/tokens/meta bursts across many panels) ----
const _mmInFlightJson_R = new Map<string, Promise<{ ok: boolean; json: any | null }>>();

async function _mmFetchJsonMaybeDedup_R(
  key: string,
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; json: any | null }> {
  const existing = _mmInFlightJson_R.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const r = await fetch(url, init as any);
      if (!r.ok) return { ok: false, json: null };
      try {
        const j = await r.json();
        return { ok: true, json: j };
      } catch {
        return { ok: false, json: null };
      }
    } catch {
      return { ok: false, json: null };
    }
  })();

  _mmInFlightJson_R.set(key, p);
  try {
    return await p;
  } finally {
    if (_mmInFlightJson_R.get(key) === p) _mmInFlightJson_R.delete(key);
  }
}


// ---- localStorage mmPickerLogos cache (avoid repeated JSON.parse across many panels/mounts) ----
let _mmPickerLogosCache_R: { raw: string; obj: any } | null = null;

function _mmReadPickerLogos_R(): any {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem("mmPickerLogos") || "{}";
    if (_mmPickerLogosCache_R && _mmPickerLogosCache_R.raw === raw) return _mmPickerLogosCache_R.obj;
    const obj = (() => { try { return JSON.parse(raw || "{}") || {}; } catch { return {}; } })();
    _mmPickerLogosCache_R = { raw, obj };
    return obj;
  } catch {
    return {};
  }
}

function _mmWritePickerLogos_R(obj: any) {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.stringify(obj || {});
    localStorage.setItem("mmPickerLogos", raw);
    _mmPickerLogosCache_R = { raw, obj: obj || {} };
  } catch {}
}

let _mmBootTokensCache_R: { raw: string | null; arr: any[] } | null = null;

function _mmReadBootTokens_R(): any[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("mm_boot_tokens_v1");
    if (_mmBootTokensCache_R && _mmBootTokensCache_R.raw === raw) return _mmBootTokensCache_R.arr;
    if (!raw) {
      _mmBootTokensCache_R = { raw: null, arr: [] };
      return [];
    }
    const arr = (() => { try { return JSON.parse(raw); } catch { return []; } })();
    const out = Array.isArray(arr) ? arr : [];
    _mmBootTokensCache_R = { raw, arr: out };
    return out;
  } catch {
    return [];
  }
}


// ---- cache pruning (prevents long-session memory creep) ----
const _MM_PRUNE_EVERY_R = 30_000;
let _mmLastPruneAt_R = 0;

function _mmMaybePruneCaches_R(now: number) {
  try {
    if (now - _mmLastPruneAt_R < _MM_PRUNE_EVERY_R) return;
    _mmLastPruneAt_R = now;

    // Meta + price caches (value has {t})
    for (const [k, v] of _mmMeta_R) { if (now - v.t > _MM_TTL_R) _mmMeta_R.delete(k); }
    for (const [k, v] of _mmPrice_R) { if (now - v.t > _MM_TTL_R) _mmPrice_R.delete(k); }

    // Dex cache (value has {at})
    for (const [k, v] of _dexCache) { if (now - v.at > DEX_CACHE_TTL_MS) _dexCache.delete(k); }

    // Logo cache + fallback throttle
    for (const [k, v] of _logoCache_R) { if (now - v.t > _LOGO_TTL_R) _logoCache_R.delete(k); }
    for (const [k, v] of _logoFallbackLast_R) { if (now - v > 5 * 60_000) _logoFallbackLast_R.delete(k); }

    // Soft size caps (drop oldest by timestamp if huge)
    const cap = 1200;
    if (_mmMeta_R.size > cap) {
      const arr = Array.from(_mmMeta_R.entries()).sort((a, b) => a[1].t - b[1].t);
      for (let i = 0; i < arr.length - cap; i++) _mmMeta_R.delete(arr[i][0]);
    }
    if (_mmPrice_R.size > cap) {
      const arr = Array.from(_mmPrice_R.entries()).sort((a, b) => a[1].t - b[1].t);
      for (let i = 0; i < arr.length - cap; i++) _mmPrice_R.delete(arr[i][0]);
    }
    if (_dexCache.size > cap) {
      const arr = Array.from(_dexCache.entries()).sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < arr.length - cap; i++) _dexCache.delete(arr[i][0]);
    }
    if (_logoCache_R.size > cap) {
      const arr = Array.from(_logoCache_R.entries()).sort((a, b) => a[1].t - b[1].t);
      for (let i = 0; i < arr.length - cap; i++) _logoCache_R.delete(arr[i][0]);
    }
  } catch {}
}

// Known stablecoin mints (force $1.00 when price source is missing/wrong)
const _MM_STABLES_R: Record<string, string> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
};

// Non-sticky stable fallback: only show $1 while prices are actively loading.
// Once pricesStatus is "ready", we trust only real quotes (so depegs show).
function effectiveUsdPrice(
  mint: string,
  quoted: number | undefined,
  pricesStatus: "idle" | "loading" | "ready"
): number | undefined {
  if (Number.isFinite(quoted as any)) return Number(quoted);
  if (pricesStatus === "loading" && _MM_STABLES_R[mint]) return 1.0;
  return undefined;
}


// DexScreener helper just for names/symbols when Jupiter Lite has no entry
async function _mmDexName_R(mint: string): Promise<{ symbol?: string; name?: string } | null> {
  if (!mint) return null;
  const now = Date.now();
  _mmMaybePruneCaches_R(now);
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
    const res = await _mmFetchJsonMaybeDedup_R(`dex:${mint}`, url, { cache: "no-store" } as any);
    if (!res.ok) return null;
    const j = res.json ?? {};
    const pairs: any[] = j?.pairs || [];
    let best = 0;
    let out: { symbol?: string; name?: string } | null = null;
    for (const p of pairs) {
      const liq = Number(p?.liquidity?.usd || 0);
      const base = p?.baseToken || {};
      const s = typeof base?.symbol === "string" ? base.symbol : undefined;
      const n = typeof base?.name === "string" ? base.name : undefined;
      if (!s && !n) continue;
      if (liq > best) { best = liq; out = { symbol: s, name: n }; }
    }
    return out;
  } catch { return null; }
}

// Token meta (name/symbol) via /api/tokens/meta, falling back to Jupiter Lite, then DexScreener
async function _mmTokenMeta_R(mint: string): Promise<_MM_TokenMeta_R | null> {
  if (!mint) return null;
  const now = Date.now();
  _mmMaybePruneCaches_R(now);
  const cached = _mmMeta_R.get(mint);
  if (cached && now - cached.t < _MM_TTL_R) return cached.v;

  // 1) DB-backed meta first (Upstash via /api/tokens/meta)
  try {
    const u = new URL('/api/tokens/meta', typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
    u.searchParams.set('mints', mint);
    const key = `metaDb:${mint}`;
    const res = await _mmFetchJsonMaybeDedup_R(key, u.toString(), { cache: 'no-store' } as any);
    if (res.ok) {
      const j: any = res.json ?? {};
      const items = Array.isArray(j?.items) ? j.items : [];
      const v = items.find((it: any) => (it?.mint || it?.address) === mint);
      if (v) {
        const shaped: _MM_TokenMeta_R = { address: v?.address || v?.mint, name: v?.name, symbol: v?.symbol, decimals: v?.decimals };
        _mmMeta_R.set(mint, { v: shaped, t: now });
        return shaped;
      }
    }
  } catch {}

  // 2) Jupiter Lite per-token (fallback)
  try {
    const key = `meta1:${mint}`;
    const res = await _mmFetchJsonMaybeDedup_R(key, `/api/tokens/meta?mints=${encodeURIComponent(mint)}`, { cache: 'no-store' } as any);
    if (res.ok) {
      const j = res.json;
      const v: _MM_TokenMeta_R | null = j?.data || null;
      if (v) {
        _mmMeta_R.set(mint, { v, t: now });
        return v;
      }
    }
  } catch {}

  // 3) DexScreener names (last resort for symbol only)
  try {
    const v = await _mmDexName_R(mint);
    if (v) {
      const shaped: _MM_TokenMeta_R = { address: mint, name: v?.name, symbol: v?.symbol };
      _mmMeta_R.set(mint, { v: shaped, t: now });
      return shaped;
    }
  } catch {}

  return null;
}

// Prices by mint via /api/prices; cached with a short TTL
async function _mmPricesByMint_R(mints: string[]): Promise<Record<string, number>> {
  const now = Date.now();
  _mmMaybePruneCaches_R(now);
  const uniq = Array.from(new Set(mints.filter(Boolean)));

  const need = uniq.filter((m) => {
    const c = _mmPrice_R.get(m);
    return !(c && now - c.t < _MM_TTL_R);
  });

  async function fetchBatch(ids: string[]) {
    const out: Record<string, number> = {};
    if (!ids.length) return out;
    try {
      const keyIds = [...ids].sort();
      const key = `prices:${keyIds.join(",")}`;
      const res = await _mmFetchJsonMaybeDedup_R(
        key,
        `/api/prices?mints=${encodeURIComponent(ids.join(","))}`,
        { cache: "no-store" } as any
      );
      if (!res.ok) return out;
      const j: any = res.json ?? {};
      const map = (j?.data || j?.prices || {}) as Record<string, number>;
      for (const [k, v] of Object.entries(map)) {
        const n = Number(v);
        if (Number.isFinite(n)) {
          out[k] = n;
          _mmPrice_R.set(k, { v: n, t: now });
        }
      }
    } catch {}
    return out;
  }

  return (async () => {
    if (need.length) await fetchBatch(need);
    const out: Record<string, number> = {};
    for (const m of uniq) {
      const c = _mmPrice_R.get(m);
      out[m] = c ? c.v : Number.NaN;
    }
    return out;
  })();
}

function hoursToMs(h: number) { 
  return Math.floor(Number(h || 0) * 60 * 60 * 1000); 
}

function cadenceToHours(cadence?: string | null): number {
  switch (String(cadence || "").toLowerCase()) {
    case "1h": return 1;
    case "2h": return 2;
    case "6h": return 6;
    case "12h": return 12;
    case "24h": return 24;
    default: return 6;
  }
}

type DexPair = {
  priceUsd?: number;
  priceNative?: number;
  price?: number;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  chainId?: string;
  url?: string;
  pairId?: string;
};

type DexMeta = { priceUsd: number; symbol: string; name?: string; pairId?: string; liquidityUsd?: number };
const _dexCache = new Map<string, { at: number; value: DexMeta }>();

function isStableSymbol(sym?: string | null): boolean {
  if (!sym) return false;
  const u = sym.toUpperCase();
  return u === "USDC" || u === "USDT" || u === "USD";
}

// NEW (iOS): use smaller chunks on iOS
async function _fetchDexForMints(mints: string[]): Promise<Record<string, DexPair[]>> {
  const out: Record<string, DexPair[]> = {};
  const CHUNK = _DEX_CHUNK_R; // was 30
  for (let i = 0; i < mints.length; i += CHUNK) {
    const chunk = mints.slice(i, i + CHUNK);
    const joined = chunk.join(",");
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(joined)}`;
    const keyJoined = [...chunk].sort().join(",");
    const key = `dexBatch:${keyJoined}`;
    const res = await _mmFetchJsonMaybeDedup_R(key, url, { cache: "no-store" } as any);
    if (!res.ok) continue;
    const data = (res.json ?? {}) as any;
    const pairs: DexPair[] = Array.isArray(data?.pairs) ? data.pairs : [];
    for (const p of pairs) {
      if (p?.chainId !== "solana") continue;
      const base = p?.baseToken?.address;
      const quote = p?.quoteToken?.address;
      if (base) (out[base] ||= []).push(p);
      if (quote) (out[quote] ||= []).push(p);
    }
  }
  return out;
}

function _chooseBestForMint(mint: string, pairs: DexPair[]): DexMeta | null {
  if (!pairs || !pairs.length) return null;

  type Scored = {
    liq: number;
    stableQuoted: number;
    priceUsd?: number;
    symbol?: string;
    baseMatched: boolean;
    pairId?: string;
  };

  const scored: Scored[] = [];

  for (const p of pairs) {
    const liq = Number(p?.liquidity?.usd ?? 0) || 0;
    const baseAddr  = p?.baseToken?.address;
    const baseSym   = p?.baseToken?.symbol;
    const quoteAddr = p?.quoteToken?.address;
    const quoteSym  = p?.quoteToken?.symbol;
    const priceUsdBase = Number(p?.priceUsd ?? 0) || undefined; // USD per BASE
    const priceNative  = Number(p?.priceNative ?? 0) || undefined; // BASE per NATIVE (SOL)
    const pricePair    = Number((p as any)?.price ?? 0) || undefined; // QUOTE per BASE

    const stableQuoted =
      (isStableSymbol(quoteSym) ||
        quoteAddr === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ||
        quoteAddr === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")
        ? 1 : 0;

    if (baseAddr === mint && priceUsdBase && isFinite(priceUsdBase)) {
      scored.push({
        liq,
        stableQuoted,
        priceUsd: priceUsdBase, // USD per our BASE mint
        symbol: baseSym,
        baseMatched: true,
        pairId: (p as any)?.pairId || (p as any)?.url,
      });
    } else if (quoteAddr === mint) {
      let usdForQuote: number | undefined;
      if (priceUsdBase && isFinite(priceUsdBase) && pricePair && isFinite(pricePair) && pricePair > 0) {
        usdForQuote = priceUsdBase / pricePair; // price = QUOTE per BASE -> USD per QUOTE
      } else if (priceUsdBase && isFinite(priceUsdBase) && priceNative && isFinite(priceNative) && priceNative > 0) {
        usdForQuote = priceUsdBase / priceNative; // fallback for SOL-quoted pairs
      }
      if (usdForQuote && isFinite(usdForQuote)) {
        scored.push({
          liq,
          stableQuoted,
          priceUsd: usdForQuote,
          symbol: quoteSym,
          baseMatched: false,
          pairId: (p as any)?.pairId || (p as any)?.url,
        });
      } else {
        scored.push({ liq, stableQuoted, symbol: quoteSym, baseMatched: false, pairId: (p as any)?.pairId || (p as any)?.url });
      }
    } else {
      // Allow symbol hydration even if price cannot be derived for this pair
      if (baseAddr === mint) {
        scored.push({ liq, stableQuoted, symbol: baseSym, baseMatched: true, pairId: (p as any)?.pairId || (p as any)?.url });
      } else if (quoteAddr === mint) {
        scored.push({ liq, stableQuoted, symbol: quoteSym, baseMatched: false, pairId: (p as any)?.pairId || (p as any)?.url });
      }
    }
  }

  if (!scored.length) return null;

  // Prefer stable quote, then highest liquidity
  scored.sort((a, b) => {
    if ((b.stableQuoted || 0) !== (a.stableQuoted || 0)) return (b.stableQuoted || 0) - (a.stableQuoted || 0);
    return (b.liq || 0) - (a.liq || 0);
  });

  const best = scored[0];
  return {
    priceUsd: Number.isFinite(best.priceUsd as any) ? (best.priceUsd as number) : 0,
    symbol: (best.symbol || "").toString(),
    pairId: best.pairId,
    liquidityUsd: best.liq,
  };
}

async function _dexMetaByMint(allMints: string[]): Promise<Record<string, DexMeta>> {
  const now = Date.now();
  const uniqMints = uniq(allMints);
  const toFetch: string[] = [];

  const preliminary: Record<string, DexMeta> = {};
  for (const m of uniqMints) {
    const c = _dexCache.get(m);
    if (c && now - c.at < DEX_CACHE_TTL_MS) {
      preliminary[m] = c.value;
    } else {
      toFetch.push(m);
    }
  }

  if (toFetch.length) {
    const bucketed = await _fetchDexForMints(toFetch);
    for (const m of toFetch) {
      const picked = _chooseBestForMint(m, bucketed[m] || []);
      const meta: DexMeta = picked || { priceUsd: 0, symbol: "", pairId: undefined, liquidityUsd: 0 };
      _dexCache.set(m, { at: now, value: meta });
      preliminary[m] = meta;
    }
  }

  return preliminary;
}

// Server-based fallback (no DexScreener): fetch symbols from /api/tokens/meta and prices from /api/prices
async function _serverMetaForMints(mints: string[]): Promise<Record<string, { priceUsd?: number; symbol?: string }>> {
  const out: Record<string, { priceUsd?: number; symbol?: string }> = {};
  const ids = Array.from(new Set(mints.filter(Boolean)));
  if (!ids.length) return out;
  const keyIds = [...ids].sort();
  try {
    const key1 = `prices1:${keyIds.join(",")}`;
    const res1 = await _mmFetchJsonMaybeDedup_R(
      key1,
      `/api/prices?mints=${encodeURIComponent(ids.join(","))}`,
      { cache: "no-store" } as any
    );
    const j1: any = res1.ok ? (res1.json ?? {}) : {};
    const pmap: Record<string, number> = (j1 && (j1.data || j1.prices || {})) || {};
    for (const [k, v] of Object.entries<any>(pmap)) {
      const n = Number(v);
      if (Number.isFinite(n)) { (out[k] ||= {}).priceUsd = n; }
    }
  } catch {}
  try {
    const key2 = `metaBatch:${keyIds.join(",")}`;
    const res2 = await _mmFetchJsonMaybeDedup_R(
      key2,
      `/api/tokens/meta?mints=${encodeURIComponent(ids.join(","))}`,
      { cache: "no-store" } as any
    );
    const j2: any = res2.ok ? (res2.json ?? {}) : {};
    const items: any[] = Array.isArray(j2?.items) ? j2.items : [];
    for (const it of items) {
      const m = String(it?.address || it?.mint || "");
      const sym = String(it?.symbol || it?.name || "");
      if (m) { (out[m] ||= {}).symbol = sym; }
    }
  } catch {}
  return out;
}

// NEW (iOS): same-origin last-resort symbol lookup via /api/tokens/search
async function _lookupSymbolsViaSearch_R(mints: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ids = uniq(mints);
  if (!ids.length) return out;

  const CONC = _META_CONC_R; // keep tiny on iOS
  for (let i = 0; i < ids.length; i += CONC) {
    const chunk = ids.slice(i, i + CONC);
    const res = await Promise.all(chunk.map(async (mint) => {
      try {
        const key = `search:${mint}`;
        const res = await _mmFetchJsonMaybeDedup_R(
          key,
          `/api/tokens/search?q=${encodeURIComponent(mint)}`,
          { cache: "no-store" } as any
        );
        const j: any = res.ok ? (res.json ?? {}) : ({} as any);
        const arr: any[] = Array.isArray(j?.tokens) ? j.tokens : Array.isArray(j?.items) ? j.items : [];
        const mm = mint.trim();
        const exact = arr.find((t: any) => String(t?.address || t?.mint || "").trim() === mm) || arr[0];
        const sym = String(exact?.symbol || exact?.name || "").trim();
        return [mint, sym] as [string, string];
      } catch { return [mint, ""] as [string, string]; }
    }));
    for (const [m, s] of res) { if (s) out[m] = s; }
  }
  return out;
}

// Helper: read authority's WSOL ATA balance (UI tokens). Returns 0 if ATA missing.
async function getAuthorityWsolUi(conn: any, authPk: PublicKey): Promise<number> {
  try {
    const mintPk = new PublicKey(SOL_MINT);
    const authAta = getAssociatedTokenAddressSync(mintPk, authPk, true);
    const r = await cachedGetTokenAccountBalance(conn, authAta, "processed");
    const ui = uiFromTokenBal(r);
    return Number.isFinite(ui) ? ui : 0;
  } catch {
    return 0;
  }
}


function shallowEqualMap(a: Record<string, any>, b: Record<string, any>): boolean {
  const ak = Object.keys(a || {}), bk = Object.keys(b || {});
  if (ak.length !== bk.length) return false;
  for (const k of ak) { if (a[k] !== b[k]) return false; }
  return true;
}

// Uint8Array/Buffer compatible base64 decoder for browser
function base64ToBytes(b64: string): Uint8Array {
  if (typeof window !== "undefined" && typeof (window as any).atob === "function") {
    const bin = (window as any).atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // @ts-ignore - Buffer exists on server/edge
  return Buffer.from(b64, "base64");
}

// Local server-first withdraw for a single mint (explicit amount) — includes x-wallet header
async function withdrawViaVaultServerFirst(
  walletLike: any,
  conn: any,
  args: { setId: string; vault: string; mint: string; amountUi: string | number; decimals?: number; admin: string }
) {
  const resp = await fetch("/api/vaults/withdraw", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wallet": args.admin,
    },
    body: JSON.stringify({
      setId: args.setId,
      mint: args.mint,
      amountUi: String(args.amountUi),
      decimals: typeof args.decimals === "number" ? args.decimals : undefined,
      admin: args.admin,
      vault: args.vault,
    }),
  });
  const j = await resp.json().catch(() => ({} as any));
  if (!resp.ok || j?.ok === false || !j?.tx64) {
    throw new Error(String(j?.error || `withdraw builder failed (status ${resp.status})`));
  }
  const raw = base64ToBytes(String(j.tx64));
  const tx = VersionedTransaction.deserialize(raw);
  const sig = await _mmSendWithJupiterFallback((walletLike as any)?.sendTransaction, (walletLike as any)?.signTransaction, tx, conn, { skipPreflight: false });
  void conn.confirmTransaction(sig as any, "confirmed").catch(() => {});
  return { sig, meta: j?.meta };
}

// --- compact mobile badge + number helpers ---

function _emitLogo_R(mint: string, url: string | null | undefined) {
  try {
    if (!mint || !url) return;
    if (typeof window === "undefined") return;
    const g = window as any;
    const next = String(url);
    const bag = (g.mmTokenLogos ||= {});
    if (bag && bag[mint] === next) return;
    bag[mint] = next;
    try { window.dispatchEvent(new CustomEvent("mm:tokenlogo", { detail: { mint, url: next } })); } catch {}
  } catch {}
}

function _mmSetGlobalTokenLogo_R(mint: string, url: string) {
  try {
    _emitLogo_R(mint, url);
  } catch {}
}


const _logoCache_R: Map<string, { url: string; t: number }> = new Map();
const _LOGO_TTL_R = 55_000;

// NEW: throttle guard to stop infinite /api/tokens/search loops
const _logoFallbackLast_R: Map<string, number> = new Map();
const _LOGO_SEARCH_TTL_R = 60_000; // minimum 60s between search calls per mint

// Safety: only accept logo URLs that are strongly bound to the mint to prevent cache poisoning.
// TokenPicker effectively uses Jupiter-backed logos; we align panels to that behavior.
function _urlContainsMint_R(url: string, mint: string): boolean {
  try {
    const u = new URL(url);
    const path = (u.pathname || "").toLowerCase();
    const q = (u.search || "").toLowerCase();
    const m = String(mint || "").toLowerCase();
    return path.includes(m) || q.includes(m);
  } catch {
    return String(url || "").toLowerCase().includes(String(mint || "").toLowerCase());
  }
}
function _isTrustedLogoUrl_R(mint: string, url: string): boolean {
  try {
    const u = String(url || "").trim();
    if (!u || !/^https?:\/\//i.test(u)) return false;
    const host = (() => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } })();
    // Jupiter icon CDN is considered authoritative for any mint.
    if (host.endsWith("jup.ag")) return true;
    // For all other hosts, require the mint to be present in the URL to avoid mismatches.
    return _urlContainsMint_R(u, mint);
  } catch {
    return false;
  }
}

async function _getTokenLogo_R(mint: string, pref?: string | null): Promise<string | null> {
  if (!mint) return pref || null;
  try {
    const now = Date.now();
    const prox = `/api/token-logos/${encodeURIComponent(mint)}`;

    const cached = _logoCache_R.get(mint);
    if (cached && now - cached.t < _LOGO_TTL_R) return cached.url;

    
    // 0) If we can resolve a strict logo for this mint (registry / cache), prefer it.
    // This prevents a stale/incorrect prefLogo (e.g. from a race) from poisoning global caches.
    try {
      const strict0 = await _resolveLogoStrict_R(mint);
      if (strict0 && /^https?:\/\//i.test(strict0)) {
        _logoCache_R.set(mint, { url: strict0, t: now });
        try { _mmSetGlobalTokenLogo_R(mint, strict0); } catch {}
return strict0;
      }
    } catch {}

    // Prefer provided URL only if it looks safe for this mint.
    // If the URL does not appear mint-specific, it can briefly show the wrong icon during soft navigations/tab restores.
    const _looksMintSpecific = (u: string) => {
      try {
        return _isTrustedLogoUrl_R(mint, String(u || ""));
      } catch {
        return false;
      }
    };

    if (pref && /^https?:\/\//i.test(pref) && _looksMintSpecific(pref)) {
      _logoCache_R.set(mint, { url: pref, t: now });
        try { _mmSetGlobalTokenLogo_R(mint, pref); } catch {}
try { fetch(prox, { method: 'HEAD', cache: 'no-store' } as any).catch(() => {}); } catch {}
      return pref;
    }

    // Global mint→logo registry (Jupiter Lite-only backfill)
    try {
      const key = `logoReg:${mint}`;
      const res = await _mmFetchJsonMaybeDedup_R(
        key,
        `/api/token-logos/registry/${encodeURIComponent(mint)}`,
        { cache: "no-store" } as any
      );
      const j: any = res.ok ? (res.json ?? {}) : {};
      const u = String(j?.url || "").trim();
      if (u && _isTrustedLogoUrl_R(mint, u)) {
        _logoCache_R.set(mint, { url: u, t: now });
        try { _mmSetGlobalTokenLogo_R(mint, u); } catch {}
        return u;
      }
    } catch {}

    // Display-only fallback: use the proxied resolver with a minute bucket cache buster.
    // Do NOT write this placeholder into window.mmTokenLogos to avoid cross-component pollution.
    const mmv = Math.floor(now / 60000);
    const proxWithBust = `${prox}?mmv=${mmv}`;
    _logoCache_R.set(mint, { url: proxWithBust, t: now });
    return proxWithBust;
  } catch {
    return pref || null;
  }
}


const _logoFixInFlight_R: Set<string> = new Set();

async function _resolveLogoStrict_R(mint: string): Promise<string | null> {
  if (!mint) return null;
  const needle = String(mint).trim();


  // 1) global mint→logo registry (Jupiter Lite-only backfill)
  try {
    const key = `logoReg:${mint}`;
    const res = await _mmFetchJsonMaybeDedup_R(
      key,
      `/api/token-logos/registry/${encodeURIComponent(mint)}`,
      { cache: "no-store" } as any
    );
    const j: any = res.ok ? (res.json ?? {}) : {};
    const u = String(j?.url || "").trim();
    if (u && /^https?:\/\//i.test(u)) return u;
  } catch {}

  // 2) exact meta from same-origin DB
  try {
    const key = `meta2:${mint}`;
    const res = await _mmFetchJsonMaybeDedup_R(key, `/api/tokens/meta?mints=${encodeURIComponent(mint)}`, { cache: "no-store" } as any);
    const j: any = res.ok ? (res.json ?? {}) : {};
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    const exact = items.find((it: any) => String(it?.address || it?.mint || "").trim() === needle);
    const u = String(exact?.logoURI || exact?.logoUri || exact?.icon || "").trim();
    if (u && /^https?:\/\//i.test(u)) return u;
  } catch {}

  // 3) Jupiter Lite per-mint
  try {
    const key = `meta3:${mint}`;
    const res = await _mmFetchJsonMaybeDedup_R(key, `/api/tokens/meta?mints=${encodeURIComponent(mint)}`, { cache: "no-store" } as any);
    if (res.ok) {
      const j = res.json;
      const data: any = j?.data || null;
      const u = String(data?.logoURI || data?.logoUri || data?.icon || "").trim();
      if (u && /^https?:\/\//i.test(u)) return u;
    }
  } catch {}

  // 4) search fallback
  try {
    const key = `search:${mint}`;
    const res = await _mmFetchJsonMaybeDedup_R(
      key,
      `/api/tokens/search?q=${encodeURIComponent(mint)}`,
      { cache: "no-store" } as any
    );
    const j: any = res.ok ? (res.json ?? {}) : ({} as any);
    const arr: any[] = Array.isArray(j?.tokens) ? j.tokens : Array.isArray(j?.items) ? j.items : [];
    const exact = arr.find((t: any) => String(t?.address || t?.mint || "").trim() === needle);
    const u = String(exact?.logoURI || exact?.logoUri || exact?.icon || "").trim();
    if (u && /^https?:\/\//i.test(u)) return u;
  } catch {}


  // 5) last resort: window cache, but only if it is trusted for this mint.
  try {
    if (typeof window !== "undefined") {
      const u = (window as any)?.mmTokenLogos?.[mint];
      if (u && _isTrustedLogoUrl_R(mint, String(u))) return String(u);
    }
  } catch {}

  return null;
}


async function _rememberLogoInDb_R(mint: string, url: string): Promise<void> {
  try {
    await fetch(`/api/token-logos/${encodeURIComponent(mint)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, source: "ui-fallback" }),
    });
  } catch {}
}

async function _tryTokenPickerFallback_R(mint: string): Promise<string | null> {
  if (!mint) return null;
  const mm = String(mint).trim();

  // Per-mint throttle: avoid hammering /api/tokens/search
  try {
    const now = Date.now();
    const last = _logoFallbackLast_R.get(mm) || 0;
    if (now - last < _LOGO_SEARCH_TTL_R) {
      const fromCache = _logoCache_R.get(mint)?.url;
      if (fromCache) return fromCache;
      try {
        if (typeof window !== "undefined") {
          const w = (window as any);
          const u = w?.mmTokenLogos?.[mint];
          if (u) return String(u);
        }
      } catch {}
      return null;
    }
  } catch {}

  if (_logoFixInFlight_R.has(mint)) {
    try {
      if (typeof window !== "undefined") {
        const awaited: string | null = await new Promise((resolve) => {
          let done = false;
          const onEvt = (e: any) => {
            try {
              const d = e?.detail || {};
              if (String(d?.mint || "").trim() === mm && d?.url) {
                done = true;
                window.removeEventListener("mm:tokenlogo" as any, onEvt as any);
                resolve(String(d.url));
              }
            } catch {}
          };
          window.addEventListener("mm:tokenlogo" as any, onEvt as any);
          setTimeout(() => {
            if (!done) {
              try { window.removeEventListener("mm:tokenlogo" as any, onEvt as any); } catch {}
              const cached = ((window as any).mmTokenLogos || {})[mint] || null;
              resolve(cached || null);
            }
          }, 1500);
        });
        if (awaited && /^https?:\/\//i.test(awaited)) {
          _logoCache_R.set(mint, { url: awaited, t: Date.now() });
          return awaited;
        }
      }
    } catch {}
    return null;
  }

  _logoFixInFlight_R.add(mint);
  try {
    _logoFallbackLast_R.set(mm, Date.now());
    const key = `search:${mint}`;
    const res = await _mmFetchJsonMaybeDedup_R(
      key,
      `/api/tokens/search?q=${encodeURIComponent(mint)}`,
      { cache: "no-store" } as any
    );
    const j: any = res.ok ? (res.json ?? {}) : ({} as any);
    const arr: any[] = Array.isArray(j?.tokens) ? j.tokens : Array.isArray(j?.items) ? j.items : [];
    const exact = arr.find((t: any) => String(t?.address || t?.mint || "").trim() === mm) || null;
    const cand: any = exact || (arr.length ? arr[0] : null);
    const u = String(cand?.logoURI || cand?.logoUri || cand?.icon || "").trim();
    if (u && _isTrustedLogoUrl_R(mint, u)) {
      _logoCache_R.set(mint, { url: u, t: Date.now() });
      try {
        if (typeof window !== "undefined") {
                    try { _mmSetGlobalTokenLogo_R(mint, u); } catch {}
          try { await _rememberLogoInDb_R(mint, u); } catch {}
        }
      } catch {}
      return u;
    }
  } catch {}
  finally { _logoFixInFlight_R.delete(mint); }
  return null;
}

function BalanceNumberR(props: { value: number; decimalsHint?: number; title?: string }) {
  const { value, decimalsHint = 6 } = props;
  const [intPart, decPart] = React.useMemo(() => {
    if (!Number.isFinite(value as any)) return ["0", ""];
    const s = Number(value).toLocaleString("en-US", {
      useGrouping: false,
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.max(0, Math.min(8, Number(decimalsHint) || 6)),
    });
    const [i, d = ""] = s.split(".");
    return [i, d];
  }, [value, decimalsHint]);
  const title = React.useMemo(() => {
    const s = Number(value).toLocaleString("en-US", {
      useGrouping: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.max(0, Math.min(9, Number(decimalsHint) || 6)),
    });
    return s;
  }, [value, decimalsHint]);
  return (
    <span className="inline-flex items-baseline gap-0.5 tabular-nums text-[13px] sm:text-sm leading-5 whitespace-nowrap" title={props.title || title}>
      <span className="shrink-0">{intPart}</span>
      {decPart ? (
        <span className="text-muted-foreground ml-[1px] inline-block max-w-[64px] sm:max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap align-baseline">.{decPart}</span>
      ) : null}
    </span>
  );
}

function TokenBadgeR(props: { mint: string; label: string; prefLogo?: string | null }) {
  const { mint, label, prefLogo } = props;
  const [logoState, setLogoState] = React.useState<{ mint: string; url: string | null }>({ mint: "", url: null });
  const logo = logoState.mint === mint ? logoState.url : null;
  const triedFallbackRef = React.useRef(false);
  const logoRef = React.useRef<string | null>(null);
  React.useEffect(() => { logoRef.current = logo; }, [logo]);
  const hasLogo = !!logo;

  React.useEffect(() => {
    let alive = true;
    (async () => {
      const u = await _getTokenLogo_R(mint, prefLogo);
      if (!alive) return;
      setLogoState({ mint, url: u });
      triedFallbackRef.current = false;
    })();
    return () => { alive = false; };
  }, [mint, prefLogo]);

  React.useEffect(() => {
    try {
      const mm = String(mint || "").trim();
      if (!mm) return;
      if (hasLogo) return; // already resolved; avoid listener fanout
      if (typeof window === "undefined") return;
      const handler = (e: any) => {
        try {
          const d = e?.detail || {};
          if (String(d?.mint || '').trim() === mm && d?.url) {
            const u = String(d.url);
            if (u && u !== logoRef.current) setLogoState({ mint, url: u });
          }
        } catch {}
      };
      window.addEventListener('mm:tokenlogo' as any, handler as any);
      return () => { try { window.removeEventListener('mm:tokenlogo' as any, handler as any); } catch {} };
    } catch {}
  }, [mint, hasLogo]);

  return (
    <span className="inline-flex items-center shrink-0">
      {logo ? (
        <img
                    src={logo}
          alt=""
          className="h-4 w-4 sm:h-5 sm:w-5 rounded-full ring-1 ring-white/10"
          loading="lazy"
          onError={async () => {
            try {
              const strict = await _resolveLogoStrict_R(mint);
              if (strict) {
                setLogoState({ mint, url: strict });
                try { _mmSetGlobalTokenLogo_R(mint, strict); } catch {}
                try { await _rememberLogoInDb_R(mint, strict); } catch {}
                return;
              }
              setLogoState({ mint, url: `/api/token-logos/${encodeURIComponent(mint)}` });
            } catch {}
          }}
          onLoad={(e) => {
            try {
              const el = e.currentTarget as HTMLImageElement;
              const w = el?.naturalWidth || 0;
              const h = el?.naturalHeight || 0;
              if (!triedFallbackRef.current && typeof logo === 'string' && logo.startsWith('/api/token-logos/') && (w <= 1 || h <= 1)) {
                triedFallbackRef.current = true;
                (async () => {
                  const strict = await _resolveLogoStrict_R(mint);
                  if (strict) {
                    setLogoState({ mint, url: strict });
                    try { _mmSetGlobalTokenLogo_R(mint, strict); } catch {}
                    try { await _rememberLogoInDb_R(mint, strict); } catch {}
                  }
                })();
              }
            } catch {}
          }}
        />
      ) : (
        <span className="h-4 w-4 sm:h-5 sm:w-5 rounded-full bg-white/10 ring-1 ring-white/10" />
      )}
      <span className="ml-1 text-xs sm:text-sm font-medium">{label}</span>
    </span>
  );
}

export default function RebalanceInlinePanel(props: Props): React.ReactElement {
  const { setId, wallet: ownerWallet, walletShim: walletShimProp, vaultAddress: initialVault, mints: mintsRaw, onResolvedSymbols, onState } = props;
  const showLoadingPlaceholders = Boolean((props as any)?.showLoadingPlaceholders);
  
  // Viewport/low-end gating (no UI changes)
  const { deferHeavy } = props;
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [activated, setActivated] = React.useState(false);
  React.useEffect(() => {
    if (activated) return;
    const shouldDefer = Boolean(deferHeavy) || (typeof window !== 'undefined' && Boolean((window as any).__mmLowEnd));
    if (!shouldDefer) { setActivated(true);
  return; }
    let done = false;
    const el = rootRef.current;
    const timer = setTimeout(() => { if (!done) setActivated(true)  // placeholder
      ; }, 1200);
    if (typeof IntersectionObserver !== 'undefined' && el) {
      const io = new IntersectionObserver((entries) => {
        const ent = entries && entries[0];
        if (ent && (ent as any).isIntersecting) {
          done = true;
          setActivated(true)  // placeholder
          ;
          try { io.disconnect(); } catch {}
          clearTimeout(timer);
        }
      }, { root: null, rootMargin: '0px', threshold: 0.1 });
      try { io.observe(el); } catch {}
      return () => { try { io.disconnect(); } catch {} clearTimeout(timer); };
    }
    return () => { clearTimeout(timer); };
  }, [deferHeavy, activated]);
const onResolvedSymbolsRef = React.useRef<typeof onResolvedSymbols>(onResolvedSymbols);
  useEffect(() => { onResolvedSymbolsRef.current = onResolvedSymbols; }, [onResolvedSymbols]);

  const { connection } = useConnection();
  const walletFromHook = useWallet();
  // Prefer parent-provided walletShim (stable across tx approval in Jupiter mobile WebView)
  const walletCandidate: any = (walletShimProp && (walletShimProp as any).publicKey) ? walletShimProp : walletFromHook;
  // Keep a last-known-good wallet to avoid transient publicKey flicker causing layout/disabled-state thrash.
  const walletStableRef = useRef<any>(null);
  const walletKey = (() => {
    try { return (walletCandidate as any)?.publicKey?.toBase58?.() || String((walletCandidate as any)?.publicKey || ''); } catch { return ''; }
  })();
  useEffect(() => {
    try { if ((walletCandidate as any)?.publicKey) walletStableRef.current = walletCandidate; } catch {}
  }, [walletKey, walletCandidate]);
  const wallet: any = walletStableRef.current || walletCandidate;
  // Stable owner base58: Android in-app wallet adapters can briefly flicker publicKey during tx approval.
  // Use last-known owner so refresh + UI don't stall or flash.
  const ownerBase58Ref = useRef<string>(String(ownerWallet || "").trim());
  useEffect(() => {
    const pick = (): string => {
      const prop = String(ownerWallet || "").trim();
      if (prop) return prop;
      try {
        const b58 = (wallet as any)?.publicKey?.toBase58?.() || (wallet as any)?.publicKey?.toString?.();
        if (typeof b58 === "string" && b58.length > 0) return b58;
      } catch {}
      try {
        const g: any = globalThis as any;
        const providers = [g?.solana, g?.phantom?.solana, g?.backpack?.solana, g?.solflare, g?.solflare?.solana].filter(Boolean);
        for (const p of providers) {
          const pk = p?.publicKey?.toBase58?.() || p?.publicKey?.toString?.();
          if (typeof pk === "string" && pk.length > 0) return pk;
        }
      } catch {}
      return ownerBase58Ref.current || "";
    };
    try {
      const next = pick();
      if (next && next !== ownerBase58Ref.current) ownerBase58Ref.current = next;
    } catch {}
  }, [ownerWallet, (wallet as any)?.publicKey]);

  const { shouldPoll } = usePollingGate({ idleMs: 60_000 });

  const [status, setStatus] = useState<"running" | "paused" | "stopped">("paused");
  const [statusInitialized, setStatusInitialized] = useState(false);
  const [cadenceMs, setCadenceMs] = useState<number>(cadenceToMs(props?.cadence || "6h"));
  const [nextRebalanceAt, setNextRebalanceAt] = useState<number | null>(null);
  const [countdownText, setCountdownText] = useState<string>("");
  const [vaultAddress, setVaultAddress] = useState<string | null | undefined>(initialVault || null);
  const [authority, setAuthority] = useState<PublicKey | null>(null);

  const [busy, setBusy] = useState(false);

  // Stop bot (confirm 3x) — prevents accidental stops while scrolling on mobile.
  const [__mmStopClicks, set__mmStopClicks] = useState(0);
  const __mmStopLastClickRef = useRef<number>(0);
  const __mmStopResetTimerRef = useRef<any>(null);

  const __mmResetStopClicks = useCallback(() => {
    set__mmStopClicks(0);
    __mmStopLastClickRef.current = 0;
    if (__mmStopResetTimerRef.current) {
      try { clearTimeout(__mmStopResetTimerRef.current); } catch {}
      __mmStopResetTimerRef.current = null;
    }
  }, []);

  const { start: startRebalanceNow, stop: stopRebalanceNow, inFlight: rebalanceInFlight } = useStartRebalance({ setId, onUpdate: (_u) => {} });

  // Normalize mints
  const mintsKey = useMemo(() => {
    const base = Array.from(new Set([...(mintsRaw || [])])).map((s) => String(s || "").trim()).filter(Boolean);
    return JSON.stringify(base);
  }, [mintsRaw]);

  // IMPORTANT (Android/WebView): guard against any invalid mint strings.
  // If a single mint is invalid, older builds would throw inside refreshBalances and the panel could
  // "flash" and then get stuck showing stale 0s until a full page refresh.
  const mints = useMemo(() => {
    let raw: string[] = [];
    try { raw = JSON.parse(mintsKey) as string[]; } catch { raw = []; }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of raw || []) {
      const t = String(s || "").trim();
      if (!t || seen.has(t)) continue;
      // Validate base58 pubkey without throwing the whole render.
      try { void new PublicKey(t); } catch { continue; }
      seen.add(t);
      out.push(t);
    }
    return out;
  }, [mintsKey]);

  const mintsKeyRef = useRef(mintsKey);
  useEffect(() => {
    mintsKeyRef.current = mintsKey;
  }, [mintsKey]);

  // Sticky token logos — hydrate per-set logo map on mount/refresh
  React.useEffect(() => {
    (async () => {
      try {
        const setId = String(props?.setId || "").trim();
        if (!setId || typeof window === "undefined") return;
        /* prime from localStorage first to reduce flicker */
        try {
          const ls: any = _mmReadPickerLogos_R();
          const listLS: string[] = mints;
          for (const m of listLS) {
            const u0 = String(ls?.[m] || "").trim();
            if (!u0) continue;
            if (!_isTrustedLogoUrl_R(m, u0)) continue;
            try { _mmSetGlobalTokenLogo_R(m, u0); } catch {}
          }
        } catch {}

        const r = await fetch(`/api/sets/${encodeURIComponent(setId)}/logos`, { cache: "no-store", next: { revalidate: 0 } as any });
        const j: any = await r.json().catch(() => ({}));
        const logos = (j && typeof j === "object" && j.logos && typeof j.logos === "object") ? j.logos as Record<string,string> : {};
        const list: string[] = mints;
        for (const m of list) {
          const u = String((logos as any)[m] || "").trim();
          if (u && _isTrustedLogoUrl_R(m, u)) {
            try { _mmSetGlobalTokenLogo_R(m, u); } catch {}
          }
        }
// Canonical refresh: align panel logos to TokenPicker (Jupiter-backed) without DB writes.
        // Single batched call; cached server-side (Redis) so this is cheap and prevents poisoned local caches.
        try {
          const _mintsKeyAtStart = mintsKeyRef.current;
          const list2: string[] = mints;
          if (list2 && list2.length) {
            const qs = list2.map((m) => encodeURIComponent(String(m))).join(",");
            const keyIds = [...list2].sort();
            const key = `metaqs:${keyIds.join(",")}`;
            const res = await _mmFetchJsonMaybeDedup_R(
              key,
              `/api/tokens/meta?mints=${qs}`,
              { cache: "no-store", next: { revalidate: 0 } as any } as any
            );
            const jj: any = res.ok ? (res.json ?? {}) : {};
            const items: any[] = Array.isArray(jj?.items) ? jj.items : [];
            if (mintsKeyRef.current === _mintsKeyAtStart && items.length) {
              // Update localStorage mmPickerLogos only with trusted/canonical URLs to avoid further poisoning.
              let baseLs: any = {};
              try { baseLs = _mmReadPickerLogos_R() || {}; } catch { baseLs = {}; }
              let lsObj: any = baseLs;
              let changed = false;
              for (const it of items) {
                const m = String(it?.mint || it?.address || "").trim();
                const u = String(it?.logoURI || it?.icon || it?.logoUri || "").trim();
                if (!m || !u) continue;
                if (!_isTrustedLogoUrl_R(m, u)) continue;
                try { _mmSetGlobalTokenLogo_R(m, u); } catch {}
                if (String(lsObj?.[m] || "") !== u) {
                  if (!changed) { try { lsObj = { ...baseLs }; } catch {} }
                  lsObj[m] = u;
                  changed = true;
                }
              }
              if (changed) {
                try { _mmWritePickerLogos_R(lsObj); } catch {}
              }
            }
          }
        } catch {}
      } catch {}
    })();
  }, [props?.setId, mintsKey]);



  // Announce visible mints
  const __mmRegId = React.useRef<string>((() => { try { return 'rebalance:' + Math.random().toString(36).slice(2); } catch { return 'rebalance:' + Date.now(); } })());
  React.useEffect(() => {
    const id: string = __mmRegId.current;
    return registerVisibleMints(id, mints);
  }, [mintsKey]);


  // Fast repair: small backoff attempts to fill any missing symbols/prices for current mints
  useEffect(() => {
    if (!activated) return;
    if (!shouldPoll) return;
    let killed = false;
    setPricesStatus((s) => (s === "loading" ? s : "loading"));
    const delays = [150, 400, 900, 2000, 4000, 8000, 15000, 25000, 40000];
    (async () => {
      for (const ms of delays) {
        if (killed) return;
        await new Promise(r => setTimeout(r, ms));
        const ids = mints;
        if (!ids || !ids.length) continue;
        try {
          const missingSyms = ids.filter(m => !symbolMapRef.current?.[m]);
          const wantPrices  = ids.filter(m => !Number.isFinite(priceMapRef.current?.[m] as any));
          if (missingSyms.length) {
            const keyIds = [...missingSyms].sort();
            const key = `metamiss:${keyIds.join(",")}`;
            const res = await _mmFetchJsonMaybeDedup_R(
              key,
              `/api/tokens/meta?mints=${encodeURIComponent(missingSyms.join(","))}`,
              { cache: "no-store" } as any
            );
            const j: any = res.ok ? (res.json ?? ({} as any)) : ({} as any);
            const items: any[] = Array.isArray(j?.items) ? j.items : [];
            const next: Record<string, string> = {};
            for (const it of items) {
              const m = String(it?.address || it?.mint || "").trim();
              const sym  = String((it as any)?.symbol || (it as any)?.name || "").trim();
              if (m && sym) next[m] = sym.toUpperCase();
            }
            if (Object.keys(next).length) setSymbolMap((cur) => {
              const mergedMap = { ...cur, ...next };
              return shallowEqualMap(cur, mergedMap) ? cur : mergedMap;
            });
          }
          if (wantPrices.length) {
            const px = await _mmPricesByMint_R(wantPrices);
            const delta: Record<string, number> = {};
            for (const [k, v] of Object.entries(px || {})) {
              const n = Number(v as any);
              if (Number.isFinite(n)) delta[k] = n;
            }
            if (Object.keys(delta).length) {
              setPriceMap((cur) => {
                let changed = false;
                const next = { ...cur };
                for (const [k, n] of Object.entries(delta)) {
                  if (next[k] !== n) {
                    next[k] = n;
                    changed = true;
                  }
                }
                return changed ? next : cur;
              });
            }
          }
        } catch {}
        if (ids.every(m => symbolMapRef.current?.[m]) && ids.every(m => Number.isFinite(priceMapRef.current?.[m] as any))) break;
      }
      if (!killed) setPricesStatus("ready");
    })();
    return () => { killed = true; setPricesStatus("idle"); };
  }, [mintsKey, shouldPoll, activated]);

  // prices/symbols state
  const [priceMap, setPriceMap] = useState<Record<string, number>>({});
  const [symbolMap, setSymbolMap] = useState<Record<string, string>>({});
  const [pricesStatus, setPricesStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [logoPrefMap, setLogoPrefMap] = useState<Record<string, string>>({});
  const priceMapRef = useRef(priceMap);
  const symbolMapRef = useRef(symbolMap);
  useEffect(() => { priceMapRef.current = priceMap; }, [priceMap]);
  useEffect(() => { symbolMapRef.current = symbolMap; }, [symbolMap]);

  // bubble up symbols
  const _lastSentSymbolsRef = React.useRef<Record<string, string>>({});
  useEffect(() => {
    if (!props.onResolvedSymbols) return;
    const delta: Record<string, string> = {};
    for (const [mint, sym] of Object.entries(symbolMap || {})) {
      if (!sym) continue;
      if (_lastSentSymbolsRef.current[mint] !== sym) delta[mint] = sym;
    }
    if (Object.keys(delta).length) {
      _lastSentSymbolsRef.current = { ..._lastSentSymbolsRef.current, ...delta };
      try { onResolvedSymbolsRef.current?.(delta); } catch {}
    }
  }, [symbolMap]);

  // Preferred logos from token meta (BUGFIX: guard)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ids = mints;
        // NEW: fix guard that previously short-circuited the effect on all truthy arrays
        if (!ids || ids.length === 0) return; // <-- fixed
        const key = `metabatch2:${ids.join(",")}`;
        const res = await _mmFetchJsonMaybeDedup_R(
          key,
          `/api/tokens/meta?mints=${encodeURIComponent(ids.join(","))}`,
          { cache: "no-store" } as any
        );
        const j: any = res.ok ? (res.json ?? ({} as any)) : ({} as any);
        const items: any[] = Array.isArray(j?.items) ? j.items : [];
        const next: Record<string, string> = {};
        for (const it of items) {
          const m = String(it?.address || it?.mint || "").trim();
          const u = String(it?.logoURI || it?.icon || it?.logoUri || "").trim();
          if (m && /^https?:\/\//i.test(u)) next[m] = u;
        }
        if (alive && Object.keys(next).length) {
          setLogoPrefMap((cur) => {
            const merged = { ...cur, ...next };
            return shallowEqualMap(cur, merged) ? cur : merged;
          });
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [mintsKey]);
  // seed known labels
  useEffect(() => {
    const seed: Record<string, string> = {};
    for (const m of mints) {
      if (m === SOL_MINT) {
        seed[m] = 'SOL';
      } else if (typeof _MM_STABLES_R[m] === 'string') {
        seed[m] = _MM_STABLES_R[m].toUpperCase();
      }
    }
    if (Object.keys(seed).length) {
      setSymbolMap((cur) => (shallowEqualMap(cur, { ...seed, ...cur }) ? cur : { ...seed, ...cur }));
    }
  }, [mintsKey]);
  // seed from bootstrap/meta arrays on window/localStorage
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      const ids: string[] = mints;
      const win: any = window as any;
      const itemsWin: any[] =
        Array.isArray(win.mmTokenMetaSeed) ? win.mmTokenMetaSeed :
        Array.isArray(win.__mmBootTokens) ? win.__mmBootTokens :
        (win.__mmBootstrap && Array.isArray(win.__mmBootstrap?.tokens?.items)
          ? win.__mmBootstrap.tokens.items : []);
      const itemsLS: any[] = _mmReadBootTokens_R();
      const items: any[] = [...(Array.isArray(itemsWin) ? itemsWin : []), ...(Array.isArray(itemsLS) ? itemsLS : [])];

      if (!items || !items.length) return;
      const seed: Record<string, string> = {};
      for (const it of items) {
        const mint = String((it as any)?.mint || (it as any)?.address || "").trim();
        const sym  = String((it as any)?.symbol || (it as any)?.name || "").trim();
        if (mint && sym && ids.includes(mint)) seed[mint] = sym.toUpperCase();
      }
      if (Object.keys(seed).length) {
        setSymbolMap((cur) => {
          const merged = { ...cur, ...seed };
          return shallowEqualMap(cur, merged) ? cur : merged;
        });
        try {
          const w: any = window as any;
          const _c: any = (w as any).mmSymbolCache;
          const _m: Record<string, string> = (_c && typeof _c === "object") ? _c : {};
          for (const [k, v] of Object.entries(seed)) { try { const kk = String(k||"").trim(); const vv = String(v||"").trim(); if (kk && vv) _m[kk] = vv; } catch {} }
          (w as any).mmSymbolCache = _m;
        } catch {}
      }
    } catch {}
  }, [mintsKey]);
  // seed from window caches
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      const ids: string[] = mints;
      const symCache = ((window as any).mmSymbolCache || {}) as Record<string, string>;
      const pxCache = ((window as any).mmPriceCache || {}) as Record<string, number>;
      const symSeed: Record<string, string> = {};
      const pxSeed: Record<string, number> = {};
      for (const id of ids) {
        const s = (symCache[id] || "").toString().trim();
        if (s) symSeed[id] = s;
        const p = Number(pxCache[id]);
        if (Number.isFinite(p) && p > 0) pxSeed[id] = p;
      }
      if (Object.keys(symSeed).length) {
        setSymbolMap((cur) => {
          const merged = { ...cur, ...symSeed };
          return shallowEqualMap(cur, merged) ? cur : merged;
        });
      }
      if (Object.keys(pxSeed).length) {
        setPriceMap((cur) => {
          const merged = { ...cur, ...pxSeed };
          return shallowEqualMap(cur, merged) ? cur : merged;
        });
      }
    } catch {}
  }, [mintsKey]);
  // gens + flags
  const genRef = useRef({ prices: 0, set: 0, balances: 0 });
  const dexInFlightRef = useRef<boolean>(false);
  const abortRef = useRef<{ prices?: AbortController }>({});
  const retryRef = useRef<{ tries: number }>({ tries: 0 });

  const reloadDex = useCallback(async () => {
    if (dexInFlightRef.current) return;
    dexInFlightRef.current = true;

    const myGen = ++genRef.current.prices;
    try {
      const ids = Array.from(new Set([...mints, SOL_MINT]));

      // seed from window cache first
      try {
        if (typeof window !== 'undefined') {
          const w: any = window as any;
          const wSym = (w.mmSymbolCache || {}) as Record<string, string>;
          const preSym: Record<string, string> = {};
          for (const id of ids) {
            const s = (wSym[id] || '').toString().trim();
            if (s) preSym[id] = s;
          }
          if (Object.keys(preSym).length) {
            setSymbolMap((cur) => {
              const merged = { ...cur, ...preSym };
              return shallowEqualMap(cur, merged) ? cur : merged;
            });
          }
        }
      } catch {}

      if (!ids.length) {
        if (myGen === genRef.current.prices) setPriceMap({});
        dexInFlightRef.current = false;
        return;
      }

      // PRESEED: /api/tokens (batched)
      try {
        const uTok = new URL('/api/tokens', typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
        uTok.searchParams.set('mints', ids.join(','));
        const rTok = await fetch(uTok.toString(), { cache: 'no-store' } as any);
        if (rTok.ok) {
          const jt: any = await rTok.json().catch(() => ({}));
          const map = jt?.map || jt?.data || {};
          const seedSymbols: Record<string, string> = {};
          for (const id of ids) {
            const sym = (map?.[id]?.symbol || '').toString().trim();
            if (sym) seedSymbols[id] = sym;
          }
          if (Object.keys(seedSymbols).length) {
            setSymbolMap((cur) => {
              const merged = { ...cur, ...seedSymbols };
              return shallowEqualMap(cur, merged) ? cur : merged;
            });
          }
        }
      } catch {}

      // PRIMARY prices: /api/prices (batched)
      const batchPrices: Record<string, number> = {};
      try {
        const u = new URL('/api/prices', typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
        u.searchParams.set('mints', ids.join(','));
        const keyIds = [...ids].sort();
        const key = `pricesBatch:${keyIds.join(",")}`;
        const res = await _mmFetchJsonMaybeDedup_R(key, u.toString(), { cache: 'no-store' } as any);
        if (res.ok) {
      const j: any = res.json ?? {};
          const data = j?.data || {};
          for (const id of ids) {
            const v = Number(data[id]);
            if (Number.isFinite(v) && v > 0) batchPrices[id] = v;
          }
        }
      } catch {}

      // Batched enrichment (symbols + price fallbacks) via server meta
      const needPerMint = ids.filter((mint) => {
        const alreadyPrice = Number.isFinite(priceMapRef.current?.[mint] as any);
        const alreadySymbol = !!symbolMapRef.current?.[mint];
        const hasPrice = alreadyPrice || Number.isFinite(batchPrices[mint] as any);
        const hasSymbol = alreadySymbol;
        return !hasPrice || !hasSymbol;
      });
      let perMint: Array<{ mint: string; price?: number; symbol?: string }> = needPerMint.map((m) => ({ mint: m }));

      if (needPerMint.length > 0) {
        const srv = await _serverMetaForMints(needPerMint);
        perMint = needPerMint.map((m) => ({
          mint: m,
          price: (srv[m] && Number.isFinite((srv[m] as any).priceUsd)) ? Number((srv[m] as any).priceUsd) : undefined,
          symbol: (srv[m] && (srv[m] as any).symbol) ? String((srv[m] as any).symbol) : undefined,
        }));
      }

      const nextPrices: Record<string, number> = { ...batchPrices };
      const nextSymbols: Record<string, string> = {};
      for (const e of perMint) {
        if (Number.isFinite(e.price as any)) nextPrices[e.mint] = Number(e.price);
        if (e.symbol) nextSymbols[e.mint] = String(e.symbol);
      }

      // FINAL ENRICHMENT 1: per-mint meta (only for truly stubborn cases)
      try {
        const missingSym = ids.filter((m) => !nextSymbols[m]);
        if (missingSym.length) {
          // NEW (iOS): run with smaller concurrency to be iOS-friendly
          const CONC = _META_CONC_R;
          for (let i = 0; i < missingSym.length; i += CONC) {
            const chunk = missingSym.slice(i, i + CONC);
            const metas = await Promise.all(chunk.map((m) => _mmTokenMeta_R(m)));
            for (let j = 0; j < chunk.length; j++) {
              const m = chunk[j];
              const meta = metas[j];
              const label = (_MM_STABLES_R[m] || meta?.symbol || meta?.name || "").toString();
              if (label) nextSymbols[m] = label;
            }
          }
        }
      } catch {}

      // FINAL ENRICHMENT 2: fill any missing prices from /api/prices helper
      try {
        const filled = await _mmPricesByMint_R(ids);
        for (const [k, v] of Object.entries(filled)) {
          if (!Number.isFinite(nextPrices[k] as any) && Number.isFinite(v)) {
            nextPrices[k] = Number(v);
          }
        }
        // NOTE: Do NOT write a $1.00 stable fallback into nextPrices; that would be sticky and could hide depegs.
        // We apply a temporary display-only fallback while prices are loading (see effectiveUsdPrice).
      } catch {}

      // FINAL ENRICHMENT 3: DexScreener — use for both prices **and symbols**
      try {
        const needDex = ids.filter((k) => !Number.isFinite(nextPrices[k] as any) || !nextSymbols[k]);
        if (needDex.length) {
          const dex = await _dexMetaByMint(needDex);
          for (const k of needDex) {
            const meta = dex[k];
            if (!meta) continue;
            if (!Number.isFinite(nextPrices[k] as any) && Number.isFinite(meta.priceUsd as any) && meta.priceUsd > 0) {
              nextPrices[k] = Number(meta.priceUsd);
            }
            if (!nextSymbols[k] && (meta.symbol || meta.name)) {
              nextSymbols[k] = String(meta.symbol || meta.name);
            }
          }
        }
      } catch {}

      // NEW (iOS): FINAL ENRICHMENT 4 — same-origin /api/tokens/search for any stubborn symbols
      try {
        const stillMissing = ids.filter((k) => !nextSymbols[k]);
        if (stillMissing.length) {
          const viaSearch = await _lookupSymbolsViaSearch_R(stillMissing);
          for (const [mint, sym] of Object.entries(viaSearch)) {
            if (sym && !nextSymbols[mint]) nextSymbols[mint] = sym;
          }
        }
      } catch {}

      // Normalize symbol casing
      for (const k of Object.keys(nextSymbols)) {
        const v = nextSymbols[k];
        if (typeof v === 'string' && v) nextSymbols[k] = v.toUpperCase();
      }

      setPriceMap((cur) => {
        const merged = { ...cur, ...nextPrices };
        return shallowEqualMap(cur, merged) ? cur : merged;
      });
      setSymbolMap((cur) => {
        const merged = { ...cur, ...nextSymbols };
        return shallowEqualMap(cur, merged) ? cur : merged;
      });

      // Persist globally + broadcast
      try {
        if (typeof window !== 'undefined') {
          const w: any = window as any;
          const mergedSyms = { ...(w.mmSymbolCache || {}), ...(symbolMapRef.current || {}), ...nextSymbols };
          const mergedPx   = { ...(w.mmPriceCache  || {}), ...(priceMapRef.current  || {}), ...nextPrices };
          w.mmSymbolCache = mergedSyms;
          w.mmPriceCache  = mergedPx;
          window.dispatchEvent(new CustomEvent('mm:rebalance:prices', { detail: mergedPx }));
        }
      } catch {}

      // Seed bootstrap token meta on window/localStorage
      try {
        if (typeof window !== 'undefined') {
          const w: any = window as any;
          const idsArr: string[] = Array.isArray(ids) ? ids : [];
          const mergedSyms = { ...(w.mmSymbolCache || {}), ...(symbolMapRef.current || {}), ...nextSymbols };
          const boot = (w.__mmBootstrap = w.__mmBootstrap || {});
          const tokens = (boot.tokens = boot.tokens || {});
          const curItems: any[] = Array.isArray(tokens.items) ? tokens.items.slice() : [];
          const byMint: Record<string, any> = {};
          for (const it of curItems) {
            const m = String((it?.mint || it?.address || '')).trim();
            if (m) byMint[m] = { ...it, address: m, mint: m };
          }
          const toSeed: any[] = [];
          for (const id of idsArr) {
            const sym = (mergedSyms[id] || '').toString().trim();
            if (!sym) continue;
            const prev = byMint[id] || {};
            const decimals = Number((prev?.decimals ?? 9));
            const name = (prev?.name || sym).toString();
            const logo = (logoPrefMap?.[id] || prev?.logoURI || prev?.icon || prev?.logoUri || '').toString();
            const item: any = { address: id, mint: id, symbol: sym, name, decimals };
            if (logo && /^https?:\/\//i.test(logo)) item.logoURI = logo;
            byMint[id] = item;
            toSeed.push(item);
          }
          const merged = Object.values(byMint);
          tokens.items = merged;
          (w as any).mmTokenMetaSeed = merged;
          (w as any).__mmBootTokens = merged;
          try {
            const w2: any = window as any;
            // Debounce + cap to avoid stringify stalls (notably on Android WebView after tx flows).
            const MAX_BOOT = 800;
            if (w2.__mmBootTokensSaveTimer) clearTimeout(w2.__mmBootTokensSaveTimer);
            w2.__mmBootTokensSaveTimer = setTimeout(() => {
              try {
                const vals = Array.isArray(merged) ? merged : [];
                const trimmed = vals.length > MAX_BOOT ? vals.slice(0, MAX_BOOT) : vals;
                window.localStorage.setItem("mm_boot_tokens_v1", JSON.stringify(trimmed as any));
                window.localStorage.setItem("mm_boot_tokens_ts", String(Date.now()));
              } catch {}
            }, 750);
          } catch {}
          if (toSeed.length) {
            window.dispatchEvent(new CustomEvent('mm:seedTokens', { detail: toSeed }));
          }
        }
      } catch {}

      // Gentle retry if anything still missing
      try {
        const missing = ids.filter((k) => !symbolMapRef.current?.[k] || !Number.isFinite((nextPrices as any)[k]));
        if (retryRef.current.tries < 3 && missing.length > 0) {
          retryRef.current.tries += 1;
          setTimeout(() => { if (!dexInFlightRef.current) { void reloadDex(); } }, 4000);
        }
      } catch {}

      // bubble up
      const symbolPayload = { ...nextSymbols };
      try { onResolvedSymbolsRef.current?.(symbolPayload); } catch {}
      try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('mm:rebalance:symbols', { detail: symbolPayload })); } catch {}
    } catch {
      // swallow
    } finally {
      dexInFlightRef.current = false;
    }
  }, [mintsKey]);
  // kick initial load
  useEffect(() => { if (!activated) return; try { void reloadDex(); } catch {} }, [reloadDex, activated]);

  // load set status & vault address
  const refreshSet = useCallback(async () => {
    const myGen = ++genRef.current.set;
    try {
      const r = await fetch(`/api/rebalance/set/${encodeURIComponent(setId)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (myGen !== genRef.current.set) return;
      if (j?.ok && j?.set) {
        const s = j.set;
        let v =
          s?.vaultId || s?.vaultAddress || s?.vault ||
          (Array.isArray(s?.accounts) && s.accounts.find((a: any) => a?.role === "vault")?.address) ||
          null;

        // canonical vault mapping override
        try {
          const rv = await fetch(`/api/sets/${encodeURIComponent(setId)}/vaultid`, { cache: "no-store" });
          const jv = await rv.json().catch(() => ({}));
          const mapV = (jv && jv.ok && jv.vault) ? String(jv.vault) : null;
          if (mapV) v = mapV;
        } catch {}

        if (v) setVaultAddress(String(v));
        const st = String(s?.status || "").toLowerCase();
        if (st === "running" || st === "paused" || st === "stopped") setStatus(st as any);

        const cd = (s?.cadence || props?.cadence || "6h") as any;
        setCadenceMs(cadenceToMs(cd));
        if ((cd && String(st) === "running") && !nextRebalanceAt) {
          setNextRebalanceAt(Date.now() + cadenceToMs(cd));
        }
        try {
          const nr = Number(s?.nextRebalanceAt || s?.next_run_at || 0);
          if (Number.isFinite(nr) && nr > 0) {
            setNextRebalanceAt(nr);
          }
        } catch {}
      }
    } catch {}
    finally {
      setStatusInitialized(true);
    }
  }, [setId]);

  // balances
  const [rows, setRows] = useState<BalanceRow[]>([]);
  // True once we've completed at least one balance refresh (even if balances are 0).
  const [balancesReady, setBalancesReady] = useState(false);
  const lastRefreshRef = useRef<number>(0);
  const inFlightRef = useRef<boolean>(false);
  const pendingRefreshRef = useRef<boolean>(false);
  const prevRowsRef = useRef<BalanceRow[]>([]);
  // Cache per-mint token program + decimals to avoid re-fetching mint metadata on every refresh (huge on mobile).
  const mintMetaRef = useRef<Record<string, { tokenProgramId: PublicKey; decimals: number }>>({});


  const priceResyncAttemptsRef = useRef<number>(0);


  const lastEquityNudgeAtRef = useRef<number>(0);
  const refreshMissingPricesLight = useCallback(async () => {
    try {
      // Throttle: header may nudge multiple panels at once.
      const now = Date.now();
      if (now - lastEquityNudgeAtRef.current < 2_000) return;
      lastEquityNudgeAtRef.current = now;

      // Only retry missing prices needed for funded vault positions.
      const want: string[] = [];
      for (const r of rows || []) {
        const v = Number((r as any)?.vaultUi ?? 0);
        if (!Number.isFinite(v) || v <= 0) continue;
        const mint = String((r as any)?.mint || '').trim();
        if (!mint) continue;
        // Prefer the latest map value (rows can lag until next render).
        const px = Number((priceMapRef.current as any)?.[mint] ?? (r as any)?.usd);
        if (!Number.isFinite(px) || px <= 0) want.push(mint);
      }
      const ids = Array.from(new Set(want)).filter(Boolean);
      if (ids.length === 0) return;

      const pxMap = await _mmPricesByMint_R(ids);
      if (!pxMap) return;
      setPriceMap((cur) => {
        const merged = { ...(cur || {}) };
        for (const [mint, v] of Object.entries(pxMap)) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            // Only fill missing; never overwrite an existing finite price.
            const existing = Number((merged as any)[mint]);
            if (!Number.isFinite(existing) || existing <= 0) (merged as any)[mint] = n;
          }
        }
        return merged;
      });
    } catch {}
  }, [rows]);

  useEffect(() => {
    if (!activated) return;
    const onNudge = (e: Event) => {
      try {
        const ev = e as _MM_EquityRefreshEvent;
        const setIds = (ev as any)?.detail?.setIds || [];
        if (Array.isArray(setIds) && setIds.length > 0 && !setIds.includes(setId)) return;
      } catch {}
      void refreshMissingPricesLight();
    };
    window.addEventListener('mm:equityRefresh', onNudge as any);
    return () => window.removeEventListener('mm:equityRefresh', onNudge as any);
  }, [activated, setId, refreshMissingPricesLight]);

  // Self-heal: if some USD quotes are still missing shortly after first load,
  // run a lightweight retry even if the header doesn't nudge (e.g. user lands mid-page).
  useEffect(() => {
    if (!activated) return;
    const hasMissing = () => {
      try {
        const cur = prevRowsRef.current || rows || [];
        for (const r of cur) {
          const v = Number((r as any)?.vaultUi ?? 0);
          if (!Number.isFinite(v) || v <= 0) continue;
          const mint = String((r as any)?.mint || '').trim();
          if (!mint) continue;
          const px = Number((priceMapRef.current as any)?.[mint] ?? (r as any)?.usd);
          if (!Number.isFinite(px) || px <= 0) return true;
        }
      } catch {}
      return false;
    };
    const t7 = window.setTimeout(() => { try { if (hasMissing()) void refreshMissingPricesLight(); } catch {} }, 7_000);
    const t12 = window.setTimeout(() => { try { if (hasMissing()) void refreshMissingPricesLight(); } catch {} }, withJitterMs(12_000, 0.2));
    return () => { try { window.clearTimeout(t7); window.clearTimeout(t12); } catch {} };
  }, [activated, rows, refreshMissingPricesLight]);


  // Keep rendered rows in sync when prices/symbols arrive after balances.
  // Root cause of "$–" totals: balances refresh can run before priceMap is populated; rows kept the old `usd` until the next balance refresh.
  // This effect updates row.usd + row.symbol as soon as the maps fill, without changing UI.
  useEffect(() => {
    try {
      const cur = prevRowsRef.current || [];
      if (!cur.length) return;
      let changed = false;
      const next = cur.map((r) => {
        const mint = r.mint;
        const latestSymbol = symbolMapRef.current?.[mint];
        const latestUsd = priceMapRef.current?.[mint];
        const sym = latestSymbol ? latestSymbol.toUpperCase() : (r.symbol || (mint ? mint.slice(0, 6) : ""));
        const usd = Number.isFinite(latestUsd as any) ? (latestUsd as number) : r.usd;
        if (usd !== r.usd || sym !== r.symbol) {
          changed = true;
          return { ...r, usd, symbol: sym, name: sym };
        }
        return r;
      });
      if (changed) {
        prevRowsRef.current = next as any;
        setRows(next as any);
      }
    } catch { /* ignore */ }
  }, [priceMap, symbolMap]);

  // Final safety net: if we ever render rows with real balances but missing prices (showing "$–"),
  // attempt a small number of extra price fetches for just those mints. This is cheap and avoids
  // users needing a full page reload when a single price call was flaky.
  useEffect(() => {
    if (!activated) return;
    if (pricesStatus !== "ready") return;
    if (!rows.length) return;

    // Only consider mints where the user actually has balance in wallet or vault.
    const lacking = rows.filter((r) => {
      const mint = r.mint;
      if (!mint) return false;
      const hasBalance = (r.userUi || 0) > 0 || (r.vaultUi || 0) > 0;
      const px = priceMapRef.current?.[mint];
      return hasBalance && !Number.isFinite(px as any);
    });

    if (!lacking.length) return;
    if (priceResyncAttemptsRef.current >= 2) return;
    priceResyncAttemptsRef.current += 1;

    let killed = false;
    (async () => {
      try {
        const ids = Array.from(new Set(lacking.map((r) => r.mint).filter(Boolean)));
        if (!ids.length) return;
        const px = await _mmPricesByMint_R(ids);
        if (killed) return;
        const merged: Record<string, number> = { ...priceMapRef.current };
        for (const [k, v] of Object.entries(px || {})) {
          if (Number.isFinite(v)) merged[k] = Number(v);
        }
        setPriceMap((cur) => {
              const mergedMap = { ...cur, ...merged };
              return shallowEqualMap(cur, mergedMap) ? cur : mergedMap;
            });
      } catch {
        // swallow – this is a best‑effort repair path
      }
    })();

    return () => {
      killed = true;
    };
  }, [activated, pricesStatus, rows]);


  const upsertRows = useCallback((next: BalanceRow[]) => {
    setRows((cur) => {
      const map = new Map<string, BalanceRow>();
      for (const r of cur || []) map.set(r.mint, r);

      const out: BalanceRow[] = [];
      let changed = false;

      for (const n0 of next) {
        const prev = map.get(n0.mint);

        // Never clobber a previously-known USD price/symbol with "unknown" (undefined/NaN) during churny refreshes.
        // This is the key fix for the occasional "$–" that appears after balances update.
        let n = n0;
        if (prev) {
          const nUsd = (n as any).usd;
          const pUsd = (prev as any).usd;
          if (!Number.isFinite(nUsd as any) && Number.isFinite(pUsd as any)) {
            n = { ...(n as any), usd: pUsd };
          }
          const nSym = (n as any).symbol;
          const pSym = (prev as any).symbol;
          if ((!nSym || !String(nSym).trim()) && pSym && String(pSym).trim()) {
            n = { ...(n as any), symbol: pSym, name: (prev as any).name || pSym };
          }
        }

        if (
          !prev ||
          prev.userUi !== n.userUi ||
          prev.vaultUi !== n.vaultUi ||
          prev.usd !== n.usd ||
          prev.symbol !== n.symbol ||
          prev.decimals !== n.decimals
        ) {
          changed = true;
          out.push(n);
        } else {
          out.push(prev);
        }
        map.delete(n.mint);
      }

      if (map.size > 0) changed = true;
      return changed ? out : cur;
    });
  }, []);


  const refreshBalances = useCallback(async (opts?: { force?: boolean }) => {
    const ownerBase58 = String(ownerBase58Ref.current || '').trim();
    if (!ownerBase58) return;

    // If a refresh is already running, schedule a follow-up refresh.
    if (inFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }

    const now = Date.now();
    const force = Boolean(opts?.force);
    if (!force && now - (lastRefreshRef.current || 0) < 1000) return; // debounce
    lastRefreshRef.current = now;

    inFlightRef.current = true;
    const myGen = ++genRef.current.balances;

    try {
      const ownerPk = new PublicKey(ownerBase58);
      let vaultPk: PublicKey | null = null;

      const programIdStr = (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID as string) || (process.env.VAULT_PROGRAM_ID as string);
      if (!programIdStr) throw new Error("Missing VAULT_PROGRAM_ID");
      const programId = new PublicKey(programIdStr);

      let vAddr = vaultAddress || null;
      if (!vAddr) {
        try {
          const r = await fetch(`/api/rebalance/set/${encodeURIComponent(setId)}`, { cache: "no-store" });
          const j = await r.json().catch(() => ({}));
          if (j?.ok && j?.set) {
            const s = j.set;
            vAddr =
              s?.vaultId || s?.vaultAddress || s?.vault ||
              (Array.isArray(s?.accounts) && s.accounts.find((a: any) => a?.role === "vault")?.address) ||
              null;
          }
        } catch {}
      }
      if (!vAddr) return;
      try { vaultPk = new PublicKey(vAddr); } catch { return; }

      const [authPk] = deriveVaultAuthorityPda(programId, vaultPk);
      // Avoid pointless rerenders from re-setting the same authority.
      setAuthority((prev) => (prev && prev.equals(authPk) ? prev : authPk));

      const conn = connection || ensureConnection();

      // Preload native SOL balances (user + vault authority PDA)
      let userSolUi = 0;
      let vaultSolUi = 0;
      try { const lamports = await cachedGetBalance(conn, ownerPk, "processed"); userSolUi = lamports / LAMPORTS_PER_SOL; } catch {}
      try { const lamports = await cachedGetBalance(conn, authPk, "processed"); vaultSolUi = lamports / LAMPORTS_PER_SOL; } catch {}

      // Resolve mint metadata in parallel (token program + decimals).
      const metaCache = mintMetaRef.current || {};
      const needMeta = (mints || []).filter((m) => m && !metaCache[m]);
      if (needMeta.length > 0) {
        await Promise.all(
          needMeta.map(async (mint) => {
            try {
              const mintPk = new PublicKey(mint);
              let tokenProgramId = TOKEN_PROGRAM_ID;
              try {
                const ai = await cachedGetAccountInfoOwner(conn, mintPk, "processed");
                if (ai?.exists && ai.owner?.equals(TOKEN_2022_PROGRAM_ID)) tokenProgramId = TOKEN_2022_PROGRAM_ID;
              } catch {}
              let decimals = 9;
              try {
                const mi = await cachedGetMint(conn, mintPk, "processed", tokenProgramId);
                decimals = Number(mi.decimals ?? 9);
              } catch {}
              metaCache[mint] = { tokenProgramId, decimals };
            } catch {}
          })
        );
        mintMetaRef.current = metaCache;
      }

      const prevMap = new Map<string, BalanceRow>();
      try {
        for (const r of (prevRowsRef.current || [])) prevMap.set(r.mint, r);
      } catch {}

      const fetchRow = async (mint: string): Promise<BalanceRow | null> => {
        let mintPk: PublicKey;
        try { mintPk = new PublicKey(mint); } catch { return null; }

        const meta = (mintMetaRef.current || {})[mint];
        const tokenProgramId = meta?.tokenProgramId || TOKEN_PROGRAM_ID;
        const decimals = Number(meta?.decimals ?? 9);

        let userUi: number | undefined;
        let vaultUi: number | undefined;

        if (mint === SOL_MINT) {
          userUi = (userSolUi || 0);
          vaultUi = (vaultSolUi || 0);

          // Also include any wSOL ATAs (some users hold wrapped SOL).
          try {
            const userAta = getAssociatedTokenAddressSync(mintPk, ownerPk, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
            const r = await cachedGetTokenAccountBalance(conn, userAta, "processed");
            const ui = uiFromTokenBal(r);
            if (Number.isFinite(ui)) userUi = (userUi || 0) + ui;
          } catch {}
          try {
            const vaultAta = getAssociatedTokenAddressSync(mintPk, authPk, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
            const r = await cachedGetTokenAccountBalance(conn, vaultAta, "processed");
            const ui = uiFromTokenBal(r);
            if (Number.isFinite(ui)) vaultUi = (vaultUi || 0) + ui;
          } catch {}
        } else {
          try {
            const userAta = getAssociatedTokenAddressSync(mintPk, ownerPk, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
            const vaultAta = getAssociatedTokenAddressSync(mintPk, authPk, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
            const [u, v] = await Promise.all([
              cachedGetTokenAccountBalance(conn, userAta, "processed").catch(() => null),
              cachedGetTokenAccountBalance(conn, vaultAta, "processed").catch(() => null),
            ]);
            userUi = uiFromTokenBal(u);
            vaultUi = uiFromTokenBal(v);
          } catch {}
        }

        const prev = prevMap.get(mint);
        const safeUser = Number.isFinite(userUi as any) ? Number(userUi) : (prev?.userUi ?? 0);
        const safeVault = Number.isFinite(vaultUi as any) ? Number(vaultUi) : (prev?.vaultUi ?? 0);

        const latestSymbol = (symbolMapRef.current as any)?.[mint];
        const latestUsd = (priceMapRef.current as any)?.[mint];
        const label = latestSymbol ? String(latestSymbol).toUpperCase() : (prev?.symbol ?? (mint ? mint.slice(0, 6) : ""));

        let usd: number | undefined = prev?.usd;
        if (Number.isFinite(latestUsd as any) && Number(latestUsd) > 0) {
          usd = Number(latestUsd);
        } else {
          try {
            if (typeof window !== "undefined") {
              const p = Number((window as any)?.mmPriceCache?.[mint]);
              if (Number.isFinite(p) && p > 0) usd = p;
            }
          } catch {}
        }

        return { mint, symbol: label, decimals, userUi: safeUser, vaultUi: safeVault, usd } as any;
      };

      // Concurrency-limited parallel balance fetch (mobile friendly).
      const maxWorkers = (() => {
        try {
          const lowEnd = Boolean((window as any).__mmLowEnd);
          return lowEnd ? 3 : 6;
        } catch { return 4; }
      })();
      const n = (mints || []).length || 0;
      const workersN = Math.max(1, Math.min(maxWorkers, n));
      let cursor = 0;
      const out: BalanceRow[] = [];
      const workers = Array.from({ length: workersN }).map(async () => {
        while (cursor < n) {
          const i = cursor++;
          const mint = (mints || [])[i];
          if (!mint) continue;
          const row = await fetchRow(mint);
          if (row) out.push(row);
        }
      });
      await Promise.all(workers);

      if (genRef.current.balances !== myGen) return;

      const order = new Map<string, number>();
      (mints || []).forEach((m, i) => order.set(m, i));
      out.sort((a, b) => (order.get(a.mint) ?? 0) - (order.get(b.mint) ?? 0));

      upsertRows(out);
      prevRowsRef.current = out;
      setBalancesReady(true);

      void refreshMissingPricesLight();
    } catch {
      // best-effort; don't toast on background refresh failures
    } finally {
      inFlightRef.current = false;
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        try { lastRefreshRef.current = 0; } catch {}
        void refreshBalances({ force: true });
      }
    }
  }, [connection, mints, setId, vaultAddress, upsertRows, ownerWallet, refreshMissingPricesLight]);

  
  const _refreshLeadTimerRef = useRef<any>(null);
  const _refreshTrailTimerRef = useRef<any>(null);
  const _refreshTrailAtRef = useRef<number>(0);

  // Coalesced refresh scheduler (Android WebView-safe):
  // - Schedules an immediate (leading) refresh at most once per tick.
  // - Allows ONE trailing refresh at a later time (e.g., after confirmations) without canceling the leading refresh.
  // This keeps the UI snappy without creating refresh storms.
  const queueRefreshBalances = useCallback((delayMs: number = 0) => {
    const d = Math.max(0, Number(delayMs || 0));
    const now = Date.now();

    // Leading (immediate) refresh — do not cancel on subsequent calls.
    if (d === 0) {
      if (_refreshLeadTimerRef.current) return;
      _refreshLeadTimerRef.current = setTimeout(() => {
        _refreshLeadTimerRef.current = null;
        try { void refreshBalances(); } catch {}
      }, 0);
      return;
    }

    // Trailing refresh — keep the *latest* requested time (helps slow finality without spam).
    const targetAt = now + d;
    if (_refreshTrailAtRef.current >= targetAt) return;

    _refreshTrailAtRef.current = targetAt;
    try {
      if (_refreshTrailTimerRef.current) {
        clearTimeout(_refreshTrailTimerRef.current);
        _refreshTrailTimerRef.current = null;
      }
    } catch {}

    _refreshTrailTimerRef.current = setTimeout(() => {
      _refreshTrailTimerRef.current = null;
      _refreshTrailAtRef.current = 0;
      try { void refreshBalances(); } catch {}
    }, Math.max(0, targetAt - Date.now()));
  }, [refreshBalances]);

  // Cleanup any queued refresh timers on unmount (prevents leaks in long-lived mobile sessions).
  useEffect(() => {
    return () => {
      try { if (_refreshLeadTimerRef.current) clearTimeout(_refreshLeadTimerRef.current); } catch {}
      try { if (_refreshTrailTimerRef.current) clearTimeout(_refreshTrailTimerRef.current); } catch {}
      try { _refreshLeadTimerRef.current = null; } catch {}
      try { _refreshTrailTimerRef.current = null; } catch {}
      try { _refreshTrailAtRef.current = 0; } catch {}
    };
  }, []);

  
  // Invalidate cached balances for owner+vault ATAs (and native SOL) so follow-up refreshes pick up the new values.
// IMPORTANT (Android): keep this *very* lightweight. The previous implementation did an O(keys×atas) scan and could
// stall low-end WebViews (causing the "flash" + stale UI right after wallet approval).
const invalidateTokenBalanceCache = useCallback((affectedMints?: string[]) => {
  try {
    const ownerPk = wallet?.publicKey || null;
    const authPk = authority || null;
    if (!ownerPk || !authPk) return;

    const ids0: string[] = Array.isArray(affectedMints) && affectedMints.length ? affectedMints : mints;
    const ids = Array.from(new Set(ids0.filter(Boolean)));

    // Build the small set of ATA addresses we care about (owner + vault authority).
    const ataSet = new Set<string>();
    for (const m of ids) {
      try {
        const mintPk = new PublicKey(m);
        try { ataSet.add(getAssociatedTokenAddressSync(mintPk, ownerPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()); } catch {}
        try { ataSet.add(getAssociatedTokenAddressSync(mintPk, ownerPk, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()); } catch {}
        try { ataSet.add(getAssociatedTokenAddressSync(mintPk, authPk,  true,  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()); } catch {}
        try { ataSet.add(getAssociatedTokenAddressSync(mintPk, authPk,  true,  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()); } catch {}
      } catch {}
    }

    const owner58 = ownerPk.toBase58();
    const auth58 = authPk.toBase58();

    // O(keys) scan with O(1) predicate: extract the final pubkey segment from our cache key format:
    // endpoint|commitment|method|<pubkey>
    purgeRpcCache((k: string) => {
      try {
        // Fast path: only methods that can affect balances.
        const isTok =
          k.includes("|getTokenAccountBalance|") ||
          k.includes("|getAccountInfoOwner|") ||
          k.includes("|getAccountInfo|");
        const isBal = k.includes("|getBalance|");
        if (!isTok && !isBal) return false;

        const lastBar = k.lastIndexOf("|");
        if (lastBar <= 0 || lastBar >= k.length - 2) return false;
        const tail = k.slice(lastBar + 1);

        if (isBal) {
          // Native SOL balance cache.
          return tail === owner58 || tail === auth58;
        }

        // Token ATA cache.
        return ataSet.has(tail);
      } catch {
        return false;
      }
    });
  } catch {}
}, [wallet?.publicKey, authority, mintsKey]);

// re-hydrate rows when USD/symbols update
  useEffect(() => {
    const ids = mints;
    if (!ids.length) return;

    if (rows.length === 0) {
      const seeded: BalanceRow[] = ids.map((mint) => {
        const label =
          (symbolMap[mint]?.toUpperCase?.() || undefined) ||
          (mint ? mint.slice(0, 6) : "");
        const px = priceMap[mint];
        return {
          mint, decimals: 9, userUi: 0, vaultUi: 0, symbol: label, name: label, usd: px,
        };
      });
      upsertRows(seeded);
      return;
    }

    const next = rows.map((r) => {
      const label =
        (symbolMap[r.mint]?.toUpperCase?.() || undefined) ||
        (r.mint ? r.mint.slice(0, 6) : "");
      const px = priceMap[r.mint];
      const usd = Number.isFinite(px as any) ? px : r.usd;
      return { ...r, symbol: label, name: label, usd };
    });
    upsertRows(next);
  }, [priceMap, symbolMap, mintsKey]);

  // initial + periodic refresh
  const timersRef = useRef<{ status?: any; dex?: any; balances?: any }>({});
  useEffect(() => { if (!activated) return; void refreshSet(); }, [refreshSet, activated]);

  // countdown updater
  useEffect(() => {
    let t: any;
    if (status === "running" && cadenceMs && (nextRebalanceAt || 0) > 0) {
      const tick = () => {
        const next = fmtCountdown((nextRebalanceAt || 0) - Date.now());
        setCountdownText((prev) => (prev === next ? prev : next));
      };
      tick();
      t = shouldPoll ? setInterval(tick, 1000) : (t as any);
    } else {
      setCountdownText((prev) => (prev === "" ? prev : ""));
    }
    return () => { if (t) clearInterval(t); };
  }, [status, cadenceMs, nextRebalanceAt, shouldPoll]);

  // staged gentle refreshes after first paint
  useEffect(() => {
    if (!activated) return;
    const t1 = setTimeout(() => { if (!dexInFlightRef.current) { void reloadDex(); } }, 1000);
    const stageCheck = (delayMs: number) => setTimeout(() => {
      try {
        const ids = mints;
        let missing = ids.filter((k) => !symbolMapRef.current?.[k] || !Number.isFinite(priceMapRef.current?.[k] as any));
        if (missing.length) {
          try {
            const w: any = typeof window !== 'undefined' ? (window as any) : {};
            const symCache = (w.mmSymbolCache || {}) as Record<string, string>;
            const pxCache  = (w.mmPriceCache  || {}) as Record<string, number>;
            const itemsWin: any[] =
              Array.isArray(w.mmTokenMetaSeed) ? w.mmTokenMetaSeed :
              Array.isArray(w.__mmBootTokens) ? w.__mmBootTokens :
              (w.__mmBootstrap && Array.isArray(w.__mmBootstrap?.tokens?.items) ? w.__mmBootstrap.tokens.items : []);
            const itemsLS: any[] = [];
            try {
              const raw = typeof window !== 'undefined' ? window.localStorage.getItem("mm_boot_tokens_v1") : null;
              if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) itemsLS.push(...arr);
              }
            } catch {}

            const symSeed: Record<string, string> = {};
            const pxSeed: Record<string, number> = {};
            for (const id of ids) {
              const s = (symCache[id] || "").toString().trim();
              if (s) symSeed[id] = s;
              const p = Number(pxCache[id]);
              if (Number.isFinite(p) && p > 0) pxSeed[id] = p;
            }
            for (const it of [...(Array.isArray(itemsWin) ? itemsWin : []), ...(Array.isArray(itemsLS) ? itemsLS : [])]) {
              const mint = String((it as any)?.mint || (it as any)?.address || "").trim();
              const sym  = String((it as any)?.symbol || (it as any)?.name || "").trim();
              if (mint && sym && ids.includes(mint)) symSeed[mint] = sym.toUpperCase();
            }

            if (Object.keys(symSeed).length) {
              setSymbolMap((cur) => {
                const merged = { ...cur, ...symSeed };
                return shallowEqualMap(cur, merged) ? cur : merged;
              });
              try {
      if (typeof window !== 'undefined') {
        const w: any = window as any;
        const cur: any = w.mmSymbolCache;
        const m: Record<string, string> = (cur && typeof cur === "object") ? cur : {};
        for (const [k, v] of Object.entries(symSeed)) { try { const kk = String(k||"").trim(); const vv = String(v||"").trim(); if (kk && vv) m[kk] = vv; } catch {} }
        w.mmSymbolCache = m;
      }
    } catch {}
            }
            if (Object.keys(pxSeed).length) {
              setPriceMap((cur) => {
                const merged = { ...cur, ...pxSeed };
                return shallowEqualMap(cur, merged) ? cur : merged;
              });
              try {
      if (typeof window !== 'undefined') {
        const w: any = window as any;
        const cur: any = w.mmPriceCache;
        const m: Record<string, number> = (cur && typeof cur === "object") ? cur : {};
        for (const [k, v] of Object.entries(pxSeed)) { try { const kk = String(k||"").trim(); const nn = Number(v as any); if (kk && Number.isFinite(nn)) m[kk] = nn; } catch {} }
        w.mmPriceCache = m;
      }
    } catch {}
            }
          } catch {}
          missing = ids.filter((k) => !symbolMapRef.current?.[k] || !Number.isFinite(priceMapRef.current?.[k] as any));
          if (missing.length > 0 && !dexInFlightRef.current) { void reloadDex(); }
        }
      } catch {}
    }, delayMs);

    const t2 = stageCheck(2200);
    const t3 = stageCheck(5000);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [mintsKey, reloadDex]);

  useEffect(() => { retryRef.current.tries = 0; }, [mintsKey]);
  useEffect(() => { if (!activated) return; queueRefreshBalances(0); }, [activated]);
  useEffect(() => { if (!activated || !wallet?.publicKey) return; try { invalidateTokenBalanceCache(); } catch {}
      try { lastRefreshRef.current = 0; } catch {}
      try { void refreshBalances(); } catch {}
      try { queueRefreshBalances(0); } catch {} }, [wallet?.publicKey, mintsKey, setId, activated]);

  useEffect(() => {
    if (!activated) return;
    if (timersRef.current.status) { clearInterval(timersRef.current.status); }
    if (timersRef.current.dex) { clearInterval(timersRef.current.dex); }
    if (timersRef.current.balances) { clearInterval(timersRef.current.balances); }
    timersRef.current.status = (shouldPoll ? setInterval : null as any)(() => void refreshSet(), withJitterMs(60_000, 0.2));
    timersRef.current.dex = (shouldPoll ? setInterval : null as any)(() => void reloadDex(), withJitterMs(60_000, 0.2));
    timersRef.current.balances = (shouldPoll ? setInterval : null as any)(() => void refreshBalances(), withJitterMs(60_000, 0.2));

    return () => {
      if (timersRef.current.status) clearInterval(timersRef.current.status);
      if (timersRef.current.dex) clearInterval(timersRef.current.dex);
      if (timersRef.current.balances) clearInterval(timersRef.current.balances);
      timersRef.current = {};
      abortRef.current.prices?.abort();
    };
  }, [refreshSet, reloadDex, shouldPoll, activated]);

  // Aggregates
  const vaultUsdTotal = useMemo(() => {
    try {
      let sum = 0;
      for (const r of rows) {
        const px = effectiveUsdPrice(r.mint, r.usd, pricesStatus);
        if (px !== undefined) sum += r.vaultUi * px;
      }
      return sum;
    } catch { return undefined; }
  }, [rows, pricesStatus]);

  const equityReady = useMemo(() => {
    try {
      // Equity is "ready" once every non-zero vault token has a known USD price (using the same effectiveUsdPrice as the panel total).
      for (const r of rows) {
        const v = Number(r?.vaultUi ?? 0);
        if (!Number.isFinite(v) || v <= 0) continue;
        const px = effectiveUsdPrice(r.mint, r.usd, pricesStatus);
        if (px === undefined || !Number.isFinite(Number(px))) return false;
      }
      return true;
    } catch { return false; }
  }, [rows, pricesStatus]);

  const vaultUiSum = useMemo(() => {
    try {
      let sum = 0;
      for (const r of rows) {
        const v = Number(r?.vaultUi ?? 0);
        if (Number.isFinite(v)) sum += v;
      }
      return sum;
    } catch { return 0; }
  }, [rows, pricesStatus]);

  const walletUsdTotal = useMemo(() => {
    try {
      let sum = 0;
      for (const r of rows) {
        const px = effectiveUsdPrice(r.mint, r.usd, pricesStatus);
        if (px !== undefined) sum += r.userUi * px;
      }
      return sum;
    } catch { return undefined; }
  }, [rows, pricesStatus]);

  
  // Keep last-known vault totals so transient refresh churn doesn't momentarily report 0s to the parent (prevents Android flash/reorder).
  const lastAggRef = useRef<{ vaultUsdTotal: number; vaultUiSum: number } | null>(null);
// Notify parent
  useEffect(() => {
    if (!onState) return;

    let nextVaultUiSum = 0;
    let nextVaultUsdTotal = 0;
    try { nextVaultUiSum = Number(vaultUiSum); if (!Number.isFinite(nextVaultUiSum)) nextVaultUiSum = 0; } catch {}
    try { nextVaultUsdTotal = Number(vaultUsdTotal); if (!Number.isFinite(nextVaultUsdTotal)) nextVaultUsdTotal = 0; } catch {}

    // If balances are mid-refresh (not ready) and we would otherwise report 0,
    // keep the last-known totals to prevent the hub from thinking the vault emptied.
    try {
      const prev = lastAggRef.current;
      if (!balancesReady && prev && nextVaultUiSum === 0 && nextVaultUsdTotal === 0) {
        nextVaultUiSum = prev.vaultUiSum;
        nextVaultUsdTotal = prev.vaultUsdTotal;
      }
      if (balancesReady) {
        // Once we have a "real" snapshot, accept it as the new baseline.
        lastAggRef.current = { vaultUiSum: nextVaultUiSum, vaultUsdTotal: nextVaultUsdTotal };
      }
    } catch {}

    const info = {
      setId, status,
      vaultUiSum: nextVaultUiSum,
      vaultUsdTotal: nextVaultUsdTotal,
      equityReady: Boolean(equityReady),
      balancesReady: Boolean(balancesReady),
      hasVault: Boolean(vaultAddress),
      timestamp: Date.now(),
    } as const;
    const id = typeof window !== 'undefined' && 'requestAnimationFrame' in window
      ? window.requestAnimationFrame(() => { try { onState(info); } catch {} })
      : null;
    if (id === null) { try { onState(info); } catch {} }
    return () => { if (id && typeof window !== 'undefined') try { window.cancelAnimationFrame(id); } catch {} };
  }, [onState, setId, status, vaultUiSum, vaultUsdTotal, equityReady, balancesReady, vaultAddress]);

  // Banner timer while in-flight
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    let id: any;
    if (rebalanceInFlight) {
      const started = Date.now();
      setElapsedSec(0);
      id = shouldPoll ? setInterval(() => { setElapsedSec(Math.floor((Date.now() - started) / 1000)); }, 1000) : null;
    }
    return () => { if (id) clearInterval(id as any); };
  }, [rebalanceInFlight, shouldPoll]);

  // Actions (start/stop/withdraw)
  const onStart = useCallback(async () => {
    if (!(wallet as any)?.publicKey) return;
    setBusy(true);
    try {
      const totalUsd = Number(vaultUsdTotal || 0);
      if (!Number.isFinite(totalUsd) || totalUsd < 100) {
        setBusy(false);
        alert(`Deposit at least $100 total into the vault before starting. Currently: ${fmtUsd(totalUsd || 0)}.`);
        return;
      }


      // Ensure the vault PDA is actually initialized before starting.
      // If a vault exists but wasn't initialized due to a rare RPC hiccup, this will prompt a separate wallet tx
      // to initialize it. NO-OP if already initialized.
      try {
        const adapter: any = {
          publicKey: wallet?.publicKey || null,
          sendTransaction: (wallet as any)?.sendTransaction,
          signTransaction: (wallet as any)?.signTransaction,
        };
        const vres = await createVaultForSet(adapter, setId, undefined, undefined, []);
        if (vres?.vault) {
          try {
            await fetch("/api/vaults/record", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ setId, vault: vres.vault, admin: ownerWallet || wallet.publicKey.toBase58() }),
            });
          } catch {}
        }
      } catch {}
      const res = await fetch("/api/rebalance/start", {
        method: "POST",
        headers: { "content-type": "application/json", "x-wallet": ownerWallet || wallet.publicKey.toBase58() },
        body: JSON.stringify({ setId }),
      });
      const j = await res.json().catch(() => ({}));
      const unwrapNative = j?.unwrapNative === true;
      if (!res.ok || !j?.ok) throw new Error(j?.error || "start_failed");

      setStatus("running");
      setNextRebalanceAt(Number(j?.nextRebalanceAt || j?.next_rebalance_at || 0) || (Date.now() + cadenceMs));

      try { await startRebalanceNow(setId); } catch {}
      setTimeout(() => void refreshSet(), 250);
      queueRefreshBalances(500);
      queueRefreshBalances(2000);
    } catch (e: any) {
      alert((e?.message || e).toString());
    } finally {
      setBusy(false);
    }
  }, [wallet?.publicKey, ownerWallet, setId, refreshSet, refreshBalances, rows, priceMap, cadenceMs, startRebalanceNow]);

  const onStopNow = useCallback(async () => {
    if (!(wallet as any)?.publicKey) return;
    setBusy(true);
    try {
      try { stopRebalanceNow(); } catch {}
      const res = await fetch("/api/rebalance/stop", {
        method: "POST",
        headers: { "content-type": "application/json", "x-wallet": ownerWallet || wallet.publicKey.toBase58() },
        body: JSON.stringify({ setId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) throw new Error(j?.error || "stop_failed");
      setStatus("paused");
      setTimeout(() => void refreshSet(), 250);
      queueRefreshBalances(500);
    } catch (e: any) {
      alert((e?.message || e).toString());
    } finally {
      setBusy(false);
    }
  }, [wallet?.publicKey, ownerWallet, setId, refreshSet, refreshBalances, stopRebalanceNow]);

  const onWithdrawAll = useCallback(async () => {
    if (!(wallet as any)?.publicKey) return;
    if (!rows || !rows.length) return;
    if (!vaultAddress) return;
    setBusy(true);

    try {
      const conn = connection || ensureConnection();
      const owner = wallet.publicKey.toBase58();
      const withdrawAllSigs: string[] = [];
      const withdrawables: Array<{ mint: string; decimals: number; symbol?: string | null; amountUi: number }> = [];
      for (const r of rows) {
        let amt = Number(r?.vaultUi || 0);
        if (r.mint === SOL_MINT) {
          if (!authority) continue;
          const wsolUi = await getAuthorityWsolUi(conn, authority);
          amt = Number(wsolUi || 0);
        }
        if (amt > 0.000001) withdrawables.push({ mint: r.mint, decimals: r.decimals, symbol: r.symbol, amountUi: amt });
      }

      
      let sentCount = 0;
      let hadError = false;

      // --- Prefer single approval: ask server to build one batched transaction (with WSOL auto-unwrap) ---
      // Prepare maps for the server (amountsByMint, decimalsByMint)
      const amountsByMint: Record<string, number> = {};
      const decimalsByMint: Record<string, number> = {};
      for (const r of rows) {
        let amt = Number(r?.vaultUi || 0);
        if (r.mint === SOL_MINT) {
          if (!authority) continue;
          const wsolUi = await getAuthorityWsolUi(conn, authority);
          amt = Number(wsolUi || 0);
        }
        if (amt > 0.000001) {
          amountsByMint[r.mint] = amt;
          decimalsByMint[r.mint] = r.decimals;
        }
      }

      try {
        let res = await fetch("/api/rebalance/withdraw-all", {
          method: "POST",
          headers: { "content-type": "application/json", "x-wallet": owner },
          body: JSON.stringify({ setId, vault: vaultAddress, amountsByMint, decimalsByMint, unwrapNative: true }),
        });

        let j = await res.json().catch(() => ({} as any));

        const sendFn = (wallet as any)?.sendTransaction ? (wallet as any).sendTransaction.bind(wallet as any) : undefined;
        const signFn = (wallet as any)?.signTransaction ? (wallet as any).signTransaction.bind(wallet as any) : undefined;
        const signAllFn = (wallet as any)?.signAllTransactions ? (wallet as any).signAllTransactions.bind(wallet as any) : undefined;

        // If the vault PDA was never initialized on-chain (common when RPC flakes during create),
        // the program will throw Anchor AccountNotInitialized (3012) and withdrawals cannot proceed.
        // In that case, the API returns a ready-to-sign initTx64. We sign/send it, then retry once.
        try {
          if ((!res.ok || !j?.ok) && j?.error === "vault_not_initialized" && j?.initTx64) {
            const rawInit = base64ToBytes(String(j.initTx64 || ""));
            const initTx = VersionedTransaction.deserialize(rawInit);

            // Use the same send path we use everywhere else (wallet signatures, Jupiter fallback transport).
            const sigInit = await _mmSendWithJupiterFallback(sendFn, signFn, initTx, conn, { skipPreflight: false });
            try { await _mmSoftConfirm(conn, sigInit as any, 8000); } catch {}

            // Retry withdraw-all once after init succeeds.
            res = await fetch("/api/rebalance/withdraw-all", {
              method: "POST",
              headers: { "content-type": "application/json", "x-wallet": owner },
              body: JSON.stringify({ setId, vault: vaultAddress, amountsByMint, decimalsByMint, unwrapNative: true }),
            });
            j = await res.json().catch(() => ({} as any));
          }
        } catch {}

        if (res.ok && j?.ok && j?.tx64) {
          // Single batched tx (best UX): one signature prompt, withdraws many mints.
          try {
            const raw = base64ToBytes(String(j.tx64 || ""));
            const tx = VersionedTransaction.deserialize(raw);

            const sig = await _mmSendWithJupiterFallback(sendFn, signFn, tx, conn, { skipPreflight: false });
            try { await _mmSoftConfirm(conn, sig as any, 8000); } catch {}
            withdrawAllSigs.push(sig);

            sentCount++;
          } catch (e) {
            console.warn("[RebalanceInlinePanel] withdraw-all single-tx send failed:", e);
          }
        } else if (res.ok && j?.ok && Array.isArray(j?.txs) && j.txs.length) {
          // Multi-tx batch: we still try to keep it to a single *approval* via signAllTransactions if the wallet supports it.
          const txObjs: { tx: VersionedTransaction; mints: string[] }[] = [];
          for (const t of j.txs) {
            try {
              const raw = base64ToBytes(String(t?.tx64 || ""));
              const tx = VersionedTransaction.deserialize(raw);
              const mintsInTx: string[] = Array.isArray(t?.mints) ? t.mints : [];
              txObjs.push({ tx, mints: mintsInTx });
            } catch {}
          }

          try {
            if (typeof signAllFn === "function") {
              const signed = await signAllFn(txObjs.map((o) => o.tx));
              for (let i = 0; i < signed.length; i++) {
                const stx = signed[i];
                const sig = await conn.sendRawTransaction(stx.serialize(), { skipPreflight: false });
                void _mmSoftConfirm(conn, sig, 6000);
                withdrawAllSigs.push(sig);
                sentCount++;
              }
            } else {
              for (const o of txObjs) {
                const sig = await _mmSendWithJupiterFallback(sendFn, signFn, o.tx, conn, { skipPreflight: false });
                void _mmSoftConfirm(conn, sig, 6000);
                withdrawAllSigs.push(sig);
                sentCount++;
              }
            }
          } catch (e) {
            hadError = true;
            console.warn("[RebalanceInlinePanel] withdraw-all multi-tx send failed:", e, j?.diag || null);
          }
        } else {
          // server didn't return usable txs
          console.warn("[RebalanceInlinePanel] withdraw-all orchestrator unexpected response:", { status: res.status, j });
        }
      } catch (e) {
        console.warn("[RebalanceInlinePanel] withdraw-all orchestrator request failed:", e);
      }
      // --- Fallback: per-mint explicit withdrawals if the batched path could not send anything ---
      if (sentCount === 0) {
        for (const w of withdrawables) {
          try {
            const { sig } = await withdrawViaVaultServerFirst(wallet, conn, {
              setId, vault: vaultAddress, mint: w.mint, amountUi: w.amountUi, decimals: w.decimals, admin: owner,
            });
            sentCount++;
            withdrawAllSigs.push(sig);
          } catch (e) {
            console.warn("[RebalanceInlinePanel] withdraw explicit failed for", w?.mint, e);
          }
        }
      }

      // Aggregate withdraw-all into a single Activity event (multi-tx friendly)
      try {
        const uniqSigs = Array.from(new Set(withdrawAllSigs.filter((s) => typeof s === "string" && s)));
        if (uniqSigs.length) {
          // If the user withdrew everything, the bot should not remain "running".
          // Persist the stop server-side so refreshes can't resurrect a running status with $0 balances.
          try {
            await fetch("/api/rebalance/stop", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ setId }),
              keepalive: true,
            }).catch(() => {});
            setStatus("stopped");
          } catch {}
          await fetch("/api/events/append", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              setId,
              kind: "WITHDRAW_ALL",
              wallet: owner,
              // Withdraw-all is aggregated across multiple mints, so we intentionally avoid
              // showing a misleading "0 SYMBOL" amount. ActivityPanel will render headlineCompact.
              headlineCompact: "Withdraw all",
              tx: uniqSigs[0] || null,
              txUrls: uniqSigs.map((s) => `https://solscan.io/tx/${s}`),
            }),
            keepalive: true,
          }).catch(() => {});
        }
      } catch {}
      // Optimistic UI update (snappy mobile): reflect withdraws immediately after a successful send.
      // Follow-up refreshes still reconcile truth (finality + unwrap can lag).
      try {
        const moved = amountsByMint || {};
        setRows((cur) => {
          const out = (cur || []).map((r) => ({ ...r }));
          for (const r of out) {
            const amtUi = Number((moved as any)[r.mint] || 0);
            if (Number.isFinite(amtUi) && amtUi > 0) {
              r.vaultUi = Math.max(0, Number(r.vaultUi || 0) - amtUi);
              r.userUi = Math.max(0, Number(r.userUi || 0) + amtUi);
            }
          }
          return out;
        });
      } catch {}

      // WSOL unwrap is now handled on-chain during withdraw-all when safe.
      try { invalidateTokenBalanceCache(); } catch {}
      try { lastRefreshRef.current = 0; } catch {}
      try { void refreshBalances(); } catch {}
      try { queueRefreshBalances(0); } catch {}
      setTimeout(() => { try { queueRefreshBalances(0); } catch {} }, 400);
      setTimeout(() => { try { queueRefreshBalances(0); } catch {} }, 1200);
      setTimeout(() => { try { queueRefreshBalances(0); } catch {} }, 2000);
          setTimeout(() => { try { queueRefreshBalances(0); } catch {} }, 5000);
      setTimeout(() => { try { queueRefreshBalances(0); } catch {} }, 10000);
} catch (e: any) {
      alert((e?.message || e).toString());
    } finally {
      setBusy(false);
    }
  }, [wallet?.publicKey, rows, setId, vaultAddress, connection, refreshBalances, authority]);

  const [depositSolUi, setDepositSolUi] = useState<string>("");
  const depositMint: string = useMemo(() => { try { return (mints && mints.length ? mints[0] : SOL_MINT); } catch { return SOL_MINT; } }, [mintsKey]);  const depositIsSol = depositMint === SOL_MINT;

  const onMax = useCallback(() => {
    try {
      const row = rows.find((r) => r.mint === depositMint);
      if (!row) { setDepositSolUi(""); return; }
      const amt = Number(row.userUi || 0);
      if (!Number.isFinite(amt) || amt <= 0) { setDepositSolUi(""); return; }
      const dec = Math.max(0, Math.min(9, Number(row.decimals || 6)));
      const s = amt.toFixed(dec).replace(/\.?0+$/, "");
      setDepositSolUi(s);
    } catch {
      setDepositSolUi("");
    }
  }, [rows, depositMint]);

  const onDeposit = useCallback(async () => {
    if (!wallet?.publicKey || !authority) return;
    const amt = Number(depositSolUi);
    if (!Number.isFinite(amt) || amt <= 0) return alert(`Enter a valid ${depositIsSol ? "SOL" : (symbolMap?.[depositMint] || "token")} amount`);
    setBusy(true);
    try {
      const conn = connection || ensureConnection();
      let sig: string | null = null;
      if (depositIsSol) {
        const payer = wallet.publicKey;
        const lamports = Math.round(amt * LAMPORTS_PER_SOL);
        if (lamports <= 0) throw new Error("invalid_lamports");
        const mintPk = new PublicKey(SOL_MINT);
        const auth = authority;
        const authAta = getAssociatedTokenAddressSync(mintPk, auth, true);
        const tx = new Transaction();
        tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, authAta, auth, mintPk));
        tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: authAta, lamports }));
        tx.add(createSyncNativeInstruction(authAta));
        sig = await _mmSendWithJupiterFallback((wallet as any)?.sendTransaction, (wallet as any)?.signTransaction, tx, conn, { skipPreflight: false });
        void _mmSoftConfirm(conn, sig, 6000);
      } else {
        const mintPk = new PublicKey(depositMint);
        const adapterFromUseWallet = (wallet?.publicKey && (wallet as any)?.sendTransaction)
          ? { publicKey: wallet.publicKey, sendTransaction: (wallet as any).sendTransaction }
          : null;
        const wa: any = (typeof window !== "undefined" ? ((window as any)?.phantom?.solana || (window as any)?.solana) : null);
        if (adapterFromUseWallet) {
          try {
          sig = await depositToVaultWithSend(adapterFromUseWallet as any, setId, mintPk, amt);
        } catch (e: any) {
          const msg = (e && (e.message || String(e))) || "";
          if (typeof (wallet as any)?.signTransaction === "function" && typeof msg === "string" && msg.toUpperCase().includes("NOT IMPLEMENTED YET")) {
            const fake2: any = { publicKey: wallet.publicKey, signTransaction: (wallet as any).signTransaction, signAllTransactions: async (txs: any[]) => txs };
            sig = await depositToVault(ensureConnection(), fake2, setId, mintPk, amt);
          } else {
            throw e;
          }
        }
        } else if (wa && typeof wa.sendTransaction === "function" && wa.publicKey) {
          try {
          sig = await depositToVaultWithSend({ publicKey: wa.publicKey, sendTransaction: wa.sendTransaction } as any, setId, mintPk, amt);
        } catch (e: any) {
          const msg = (e && (e.message || String(e))) || "";
          if (wa && typeof wa.signTransaction === "function" && wa.publicKey && typeof msg === "string" && msg.toUpperCase().includes("NOT IMPLEMENTED YET")) {
            const fake: any = { publicKey: wa.publicKey, signTransaction: wa.signTransaction, signAllTransactions: async (txs: any[]) => txs };
            sig = await depositToVault(ensureConnection(), fake, setId, mintPk, amt);
          } else {
            throw e;
          }
        }
        } else if (wa && typeof wa.signTransaction === "function" && wa.publicKey) {
          const fake: any = { publicKey: wa.publicKey, signTransaction: wa.signTransaction, signAllTransactions: async (txs: any[]) => txs };
          sig = await depositToVault(ensureConnection(), fake, setId, mintPk, amt);
        } else if (typeof (wallet as any)?.signTransaction === "function" && wallet?.publicKey) {
          const fake2: any = { publicKey: wallet.publicKey, signTransaction: (wallet as any).signTransaction, signAllTransactions: async (txs: any[]) => txs };
          sig = await depositToVault(ensureConnection(), fake2, setId, mintPk, amt);
        } else {
          setBusy(false);
          return alert("This wallet cannot send transactions here.");
        }
        try { if (sig) void _mmSoftConfirm(conn, sig, 6000); } catch {}
      }
      try {
        const sym = (symbolMap?.[depositMint] || null) as any;
        const dec = (rows.find((r) => r.mint === depositMint)?.decimals ?? null) as any;
        await fetch("/api/events/append", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            setId, kind: "DEPOSIT", mint: depositMint, wallet: ownerWallet || wallet.publicKey.toBase58(),
            symbol: typeof sym === "string" ? sym : null, decimals: typeof dec === "number" ? dec : null,
            amountUi: amt, tx: (typeof sig === "string" ? sig : null),
          }),
          keepalive: true,
        }).catch(() => {});
      } catch {}

      // Optimistic UI update (snappy mobile): reflect the move immediately after a successful send.
      // Follow-up refreshes still reconcile truth.
      try {
        const amtUiN = Number(amt);
        if (Number.isFinite(amtUiN) && amtUiN > 0) {
          setRows((cur) => {
            const out = (cur || []).map((r) => ({ ...r }));
            const i = out.findIndex((r) => r.mint === depositMint);
            if (i >= 0) {
              out[i].userUi = Math.max(0, Number(out[i].userUi || 0) - amtUiN);
              out[i].vaultUi = Math.max(0, Number(out[i].vaultUi || 0) + amtUiN);
            }
            return out;
          });
        }
      } catch {}

      setDepositSolUi("");
      // Purge only affected mint(s) to keep Android WebView snappy.
      try { invalidateTokenBalanceCache([depositMint, SOL_MINT]); } catch {}
      try { lastRefreshRef.current = 0; } catch {}
      // Refresh now + a couple follow-ups to reconcile finality without creating a refresh storm (Android WebView-safe)
      try { queueRefreshBalances(0); } catch {}
      try { queueRefreshBalances(1200); } catch {}
      try { queueRefreshBalances(3500); } catch {}
      try { queueRefreshBalances(8000); } catch {}
} catch (e: any) {
      alert((e?.message || e).toString());
    } finally {
      setBusy(false);
    }
  }, [wallet?.publicKey, authority, depositSolUi, connection, setId, ownerWallet, refreshBalances, depositMint, mintsKey, symbolMap, rows]);

  const vaultExists = Boolean(vaultAddress);
  const isRunning = status === "running" && vaultExists;

  useEffect(() => {
    if (!isRunning) __mmResetStopClicks();
  }, [isRunning, __mmResetStopClicks]);

  function onStopClick() {
    if (busy || rebalanceInFlight) return;
    if (!isRunning) return;

    const now = Date.now();
    const last = __mmStopLastClickRef.current || 0;
    const within = now - last <= 1500;

    const next = within ? (__mmStopClicks + 1) : 1;
    __mmStopLastClickRef.current = now;
    set__mmStopClicks(next);

    if (__mmStopResetTimerRef.current) {
      try { clearTimeout(__mmStopResetTimerRef.current); } catch {}
      __mmStopResetTimerRef.current = null;
    }
    __mmStopResetTimerRef.current = setTimeout(() => {
      try { __mmResetStopClicks(); } catch {}
    }, 1500);

    if (next >= 3) {
      __mmResetStopClicks();
      void onStopNow();
    }
  }

  useEffect(() => { if (!isRunning) setNextRebalanceAt(null); }, [isRunning]);
  const canWithdrawAll = status !== "running" && rows.some((r) => r.vaultUi > 0.000001); // FIX: allow withdraw when paused or stopped

  const depositAmount = Number(depositSolUi);
  const depositPrice = priceMap[depositMint];
  const depositUsd = Number.isFinite(depositAmount) && depositPrice ? depositAmount * depositPrice : undefined;

  const depositTokenLabel = ((): string => {
    try {
      const firstMint = (mints && mints.length ? mints[0] : SOL_MINT);
      const sym = (symbolMap[firstMint] || "");
      if (sym) return String(sym).toUpperCase();
      if (firstMint && typeof firstMint === 'string' && firstMint.length > 8) {
        return `${firstMint.slice(0,4)}…${firstMint.slice(-4)}`;
      }
      return 'TOKEN';
    } catch { return 'TOKEN'; }
  })();

  return (
    <div ref={rootRef} className="rounded-xl border border-white/10 bg-[#1D1D1D] p-4">
      {/* Status */}
      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${isRunning ? "bg-brandMint" : "bg-rose-500"}`} />
          <span className="text-white/80">
            {isRunning ? "Vault Running" : vaultExists ? "Vault Stopped" : "Vault Stopped (Awaiting Funds)"}{" "}
            {status === "running" ? (
              <span className="ml-2 text-white/60">• Next rebalance in {countdownText}</span>
            ) : null}
          </span>
        </div>

        {/* In-flight banner */}
        {rebalanceInFlight ? (
          <div className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            Please wait, rebalancing… <span className="tabular-nums">{elapsedSec}s</span>
          </div>
        ) : null}

        {statusInitialized && (
          <div className="flex items-center gap-2">
            {canWithdrawAll ? (
              <Button variant="dangerSoft" onClick={onWithdrawAll} disabled={busy || rebalanceInFlight || !wallet?.publicKey}>
                Withdraw All
              </Button>
            ) : null}

            {isRunning ? (
              <Button variant="warning" onClick={onStopClick} disabled={busy || rebalanceInFlight || !wallet?.publicKey} className="bg-none bg-[#FD1B77]/20 hover:bg-[#FD1B77]/30 text-[#FD1B77] hover:text-[#FD1B77] shadow-none hover:shadow-none">{__mmStopClicks > 0 ? `Stop (${__mmStopClicks}/3)` : "Stop"}</Button>
            ) : (
              (busy || rebalanceInFlight || !wallet?.publicKey) ? null : (
                <Button variant="success" onClick={onStart}>Start</Button>
              )
            )}
          </div>
        )}
      </div>

      {/* Wallet + Vault */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Wallet */}
        <div className="rounded-lg border bg-black p-2.5 sm:p-3 overflow-hidden">
          <div className="mb-1 text-[10px] sm:text-xs tracking-wide bg-clip-text text-transparent bg-gradient-to-r from-brandPink/90 via-brandPurple/90 to-brandMint/90">Wallet</div>
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground">No tokens selected</div>
          ) : (
            rows.map((r) => {
              const label = (r.symbol || (r.mint ? r.mint.slice(0, 6) : "")).toString();
              const px = effectiveUsdPrice(r.mint, r.usd, pricesStatus);
              const usd = px !== undefined ? r.userUi * px : undefined;
              return (
                <div key={`wallet-${r.mint}`} className="flex items-center gap-1">
                  <TokenBadgeR mint={r.mint} label={label} prefLogo={(logoPrefMap || {})[r.mint]} />
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <BalanceNumberR value={r.userUi} decimalsHint={r.decimals} />
                  </div>
                  <div className="text-[11px] sm:text-xs text-muted-foreground text-right shrink-0 min-w-[72px] sm:min-w-[88px] ml-1">
                    {_mmUsdNode(usd, balancesReady, showLoadingPlaceholders)}
                  </div>
                </div>
              );
            })
          )}
          <div className="mt-1 text-right text-[11px] text-white/60">
            Total ≈ <span className="font-medium">{_mmUsdNode(walletUsdTotal, balancesReady, showLoadingPlaceholders)}</span>
          </div>
        </div>

        {/* Vault */}
        <div className="rounded-lg border bg-black p-2.5 sm:p-3 overflow-hidden">
          <div className="mb-1 text-[10px] sm:text-xs tracking-wide bg-clip-text text-transparent bg-gradient-to-r from-brandPink/90 via-brandPurple/90 to-brandMint/90">Vault</div>
          {rows.length === 0 ? (
            <div className="text-xs text-muted-foreground">No tokens selected</div>
          ) : (
            rows.map((r) => {
              const label = (r.symbol || (r.mint ? r.mint.slice(0, 6) : "")).toString();
              const px = effectiveUsdPrice(r.mint, r.usd, pricesStatus);
              const usd = px !== undefined ? r.vaultUi * px : undefined;
              return (
                <div key={`vault-${r.mint}`} className="flex items-center gap-1">
                  <TokenBadgeR mint={r.mint} label={label} prefLogo={(logoPrefMap || {})[r.mint]} />
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <BalanceNumberR value={r.vaultUi} decimalsHint={r.decimals} />
                  </div>
                  <div className="text-[11px] sm:text-xs text-muted-foreground text-right shrink-0 min-w-[72px] sm:min-w-[88px] ml-1">
                    {_mmUsdNode(usd, balancesReady, showLoadingPlaceholders)}
                  </div>
                </div>
              );
            })
          )}
          <div className="mt-1 text-right text-[11px] text-white/60">
            Total ≈ <span className="font-medium">{_mmUsdNode(vaultUsdTotal, balancesReady, showLoadingPlaceholders)}</span>
          </div>
        </div>
      </div>

      {/* Deposit */}
      {!isRunning && (
        <div className="mt-3 sm:mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <div className="sm:col-start-2">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <div className="flex items-center gap-2 w-full">
<button
                type="button"
                onClick={onMax}
                className="rounded-full border border-brandPurple/20 bg-brandPurple/15 px-2 py-0.5 text-[10px] font-medium hover:border-brandPurple/30 transition-colors"
              >
                Max
              </button>
              <input
                className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
                value={depositSolUi}
                onChange={(e) => setDepositSolUi(e.currentTarget.value)}
                placeholder={`Amount ${depositTokenLabel}`}
                inputMode="decimal"
                pattern="[0-9]*[.]?[0-9]*"
              />
              </div>
              <Button
                variant="primary"
                className="w-full sm:w-auto"
                onClick={onDeposit}
                disabled={busy || !wallet?.publicKey || !authority}
              >{`Deposit ${depositTokenLabel}`}</Button>
            </div>
            <div className="mt-1 text-xs text-white/60 text-left sm:text-right">
              {Number.isFinite(depositAmount) && depositAmount >= 0 && depositPrice
                ? <>≈ {fmtUsd(depositUsd)} at live {depositTokenLabel} price</>
                : <>Enter an amount to see ≈ USD</>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
