"use client";

// Set logo fetch dedupe (per setId). Prevents N panels from hammering /api/sets/:id/logos.
const _MM_SET_LOGOS_TTL_MS = 60_000;
const _MM_SET_LOGOS_CACHE = new Map<string, { ts: number; logos: Record<string, string> }>();
const _MM_SET_LOGOS_INFLIGHT = new Map<string, Promise<Record<string, string>>>();

const _MM_SET_LOGOS_MAX = 250;
let _MM_SET_LOGOS_LAST_PRUNE = 0;
function _mmPruneSetLogosCache(now: number) {
  // Cheap, occasional prune to avoid unbounded growth on long-lived dashboards.
  if (now - _MM_SET_LOGOS_LAST_PRUNE < 30_000) return;
  _MM_SET_LOGOS_LAST_PRUNE = now;

  for (const [k, v] of _MM_SET_LOGOS_CACHE.entries()) {
    if (!v || now - v.ts >= _MM_SET_LOGOS_TTL_MS) _MM_SET_LOGOS_CACHE.delete(k);
  }

// Size cap (rare): drop oldest entries.
  if (_MM_SET_LOGOS_CACHE.size > _MM_SET_LOGOS_MAX) {
    const entries = Array.from(_MM_SET_LOGOS_CACHE.entries()).sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
    const dropN = entries.length - _MM_SET_LOGOS_MAX;
    for (let i = 0; i < dropN; i++) _MM_SET_LOGOS_CACHE.delete(entries[i][0]);
  }
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
  return formatUsd(n);
}

async function _mmGetSetLogosCached(setId: string): Promise<Record<string, string>> {
  const sid = String(setId || "").trim();
  if (!sid) return {};
  const now = Date.now();
  _mmPruneSetLogosCache(now);
  const hit = _MM_SET_LOGOS_CACHE.get(sid);
  if (hit && now - hit.ts < _MM_SET_LOGOS_TTL_MS) return hit.logos || {};
  const inflight = _MM_SET_LOGOS_INFLIGHT.get(sid);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const r = await fetch(`/api/sets/${encodeURIComponent(sid)}/logos`, { cache: "no-store", next: { revalidate: 0 } as any });
      const j: any = await r.json().catch(() => ({}));
      const logos = (j && typeof j === "object" && j.logos && typeof j.logos === "object") ? (j.logos as Record<string, string>) : {};
      _MM_SET_LOGOS_CACHE.set(sid, { ts: Date.now(), logos });
      return logos;
    } catch {
      return {};
    } finally {
      _MM_SET_LOGOS_INFLIGHT.delete(sid);
    }
  })();
  _MM_SET_LOGOS_INFLIGHT.set(sid, p);
  return p;
}

// FULL FILE REPLACEMENT for: src/app/webhooks/_components/VaultInlinePanel.tsx
// filepath: src/app/webhooks/_components/VaultInlinePanel.tsx
// FULL FILE REPLACEMENT for: src/app/webhooks/_components/VaultInlinePanel.tsx
// Preserves existing UI/UX and behavior. Surgical change: Fix token-logo caching (USDC/ZEC wrong icons) & keep robust WSOL unwrapping on Withdraw All
// - Close ALL of the user's WSOL token accounts (ATA + any aux accounts), with small delays and confirmed reads.
// - Do not change UI or other side effects.
declare global {
  interface Window {
    mmTokenLogos?: Record<string, string>;
  }
}

function _emitLogo(mint: string, url: string | null | undefined) {
  try {
    if (!mint || !url) return;
    if (typeof window === "undefined") return;
    const g = (window as any).mmTokenLogos || ((window as any).mmTokenLogos = {});
    g[mint] = String(url);
    try { window.dispatchEvent(new CustomEvent("mm:tokenlogo", { detail: { mint, url: String(url) } })); } catch {}
  } catch {}
}


function _isTrustedLogoUrl(mint: string, url: string): boolean {
  try {
    const m = String(mint || "").trim();
    const u = String(url || "").trim();
    if (!m || !u) return false;
    if (!/^https?:\/\//i.test(u)) return false;

    // Always trust Jupiter icon CDN(s)
    const parsed = new URL(u);
    const host = (parsed.hostname || "").toLowerCase();
    if (host.endsWith("jup.ag")) return true;

    // Otherwise require the mint to appear in the URL (path or query) to prevent cross-mint poisoning
    const hay = (parsed.pathname + " " + parsed.search).toLowerCase();
    return hay.includes(m.toLowerCase());
  } catch {
    return false;
  }
}


function uiFromTokenBal(bal: any): number {
  try {
    if (typeof bal === "number") return Number.isFinite(bal) ? bal : 0;
    if (bal && typeof bal === "object") {
      const v: any = (bal as any).value ?? bal;
      if (typeof v?.uiAmount === "number") return v.uiAmount;
      const dec = Number(v?.decimals ?? NaN);
      const amtStr = v?.amount;
      if (typeof amtStr === "string" && Number.isFinite(dec) && dec >= 0) {
        const amt = Number(amtStr);
        if (Number.isFinite(amt)) return amt / Math.pow(10, dec);
      }
    }
  } catch {}
  return 0;
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


import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { PublicKey, Transaction, TransactionSignature, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { cachedGetBalance, cachedGetTokenAccountBalance, purgeRpcCache } from "@/lib/rpc-cache";
import { createVaultForSet } from "@/lib/mm-vault-create";

import { Button } from "@/components/ui/button";
import {
  readBalances,
  depositToVault,
  depositToVaultWithSend,
  ensureConnection,
  deriveVaultAuthorityPda,
} from "@/lib/vault-sdk";

import { withdrawFromVaultServerFirst } from "@/lib/vault-withdraw";
import { usePollingGate, withJitterMs } from "@/lib/useActivityGate";
import { registerVisibleMints } from "@/app/_lib/tokenRegistry";

// Panels can receive gentle "retry" nudges from the app header to re-fetch missing USD prices.
// This is intentionally NO-RPC (uses /api/prices) and is throttled.
type _MM_EquityRefreshEvent = CustomEvent<{ setIds?: string[] }>;


// Soft-confirm with a strict time budget so mobile UIs never hang waiting for RPC.
// Returns true only if confirmation completes within the budget; otherwise false.
// Never throws.
async function _mmSoftConfirm(conn: any, sig: string, timeoutMs: number = 6000): Promise<boolean> {
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


// ---- Mojo Pro gate (client) ----
// NOTE: Subscription is universal ("mojo-pro") even when the path uses mojo-pro-sol/eth/btc slugs.
// ---- Mojo Pro gate (client) ----
// NOTE: Subscription is universal ("mojo-pro") even when the path uses mojo-pro-sol/eth/btc slugs.
// Perf: on /app there can be many panels, so we dedupe the status fetch per wallet.
const _mmMojoProCache = new Map<string, { active: boolean; t: number; etag?: string }>();
const _mmMojoProInFlight = new Map<string, Promise<{ active: boolean; etag?: string }>>();

function useMojoProActive(walletB58: string | null, enabled: boolean): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!enabled) {
        if (!cancelled) setActive(false);
        return;
      }
      const w = String(walletB58 || "").trim();
      if (!w) {
        if (!cancelled) setActive(false);
        return;
      }

      // Hot-cache: avoids N parallel requests across panels.
      try {
        const now = Date.now();
        const c = _mmMojoProCache.get(w);
        if (c && now - c.t < 20_000) {
          if (!cancelled) setActive(!!c.active);
          return;
        }
      } catch {}

      // Dedupe in-flight request per wallet.
      let p = _mmMojoProInFlight.get(w);
      if (!p) {
        p = (async () => {
          const headers: Record<string, string> = {};
          const c = _mmMojoProCache.get(w);
          if (c?.etag) headers["If-None-Match"] = c.etag;

          const r = await fetch(
            `/api/subs/mojo-pro-sol/status?wallet=${encodeURIComponent(w)}`,
            { cache: "no-store", headers }
          );

          // If unchanged, keep existing cached value (if any).
          if (r.status === 304) {
            const cur = _mmMojoProCache.get(w);
            return { active: !!cur?.active, etag: cur?.etag };
          }

          const j = await r.json().catch(() => ({} as any));
          const etag = r.headers.get("etag") || undefined;
          const nextActive = !!j?.status?.active;
          return { active: nextActive, etag };
        })();

        _mmMojoProInFlight.set(w, p);
      }

      try {
        const res = await p;
        if (cancelled) return;
        _mmMojoProCache.set(w, { active: !!res.active, t: Date.now(), etag: res.etag });
        setActive(!!res.active);
      } catch {
        if (!cancelled) {
          _mmMojoProCache.set(w, { active: false, t: Date.now() });
          setActive(false);
        }
      } finally {
        try { _mmMojoProInFlight.delete(w); } catch {}
      }
    })();

    return () => { cancelled = true; };
  }, [walletB58, enabled]);

  return active;
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

// ---- Mojomaxi activity append helper (deposit/withdraw logging) ----
async function _mmLogEventAppend(
  setId: string,
  kind: "DEPOSIT" | "WITHDRAW",
  mint: string,
  wallet?: string | null,
  symbol?: string | null,
  decimals?: number | null,
  amountUi?: number | null,
  tx?: string | null
) {
  try {
    if (!setId || !mint) return;
    if (typeof amountUi !== "undefined" && amountUi !== null && !Number.isFinite(Number(amountUi))) return;

    const payload: any = { setId, kind, mint, symbol, decimals, amountUi: amountUi == null ? null : Number(amountUi) };
    if (wallet) payload.wallet = wallet;
    if (tx) payload.tx = tx;

    const resp = await fetch("/api/events/append", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });

    if (!resp.ok) {
      try {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        if (typeof navigator !== "undefined" && (navigator as any).sendBeacon) {
          (navigator as any).sendBeacon("/api/events/append", blob);
        }
      } catch {}
    }
  } catch {
    try {
      const payload: any = { setId, kind, mint, symbol, decimals, amountUi: amountUi == null ? null : Number(amountUi), tx };
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      if (typeof navigator !== "undefined" && (navigator as any).sendBeacon) {
        (navigator as any).sendBeacon("/api/events/append", blob);
      }
    } catch {}
  }
}

// --------------------------------------------------------------------

/**
 * Jupiter LITE-friendly helpers (no on-chain RPC)
 */

type _MM_TokenMeta = { address: string; name?: string; symbol?: string; decimals?: number; logoURI?: string; logoUri?: string; icon?: string };
const _mmMeta = new Map<string, { v: _MM_TokenMeta; t: number }>();
const _mmPrice = new Map<string, { v: number; t: number }>();
const _mmPriceEtag = new Map<string, { etag: string; t: number }>();
const _MM_PRICE_ETAG_TTL_MS = 15 * 60_000;
let _mmPriceEtagLastPrune = 0;
function _mmPrunePriceEtags(now: number) {
  // Prevent unbounded growth in long sessions with many unique mint combinations.
  if (now - _mmPriceEtagLastPrune < 30_000) return;
  _mmPriceEtagLastPrune = now;
  for (const [k, v] of _mmPriceEtag) {
    if (!v?.t || now - v.t > _MM_PRICE_ETAG_TTL_MS) _mmPriceEtag.delete(k);
  }
}

const _MM_TTL = 55_000;

const _MM_STABLES: Record<string, string> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
};

const _mmDexCache = new Map<string, { v: { symbol?: string; name?: string } | null; t: number }>();
const _MM_DEX_TTL = 10 * 60_000;

async function _mmDexName(mint: string): Promise<{ symbol?: string; name?: string } | null> {
  try {
    const m = String(mint || "").trim();
    if (!m) return null;

    const now = Date.now();
    const c = _mmDexCache.get(m);
    if (c && now - c.t < _MM_DEX_TTL) return c.v;

    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(m)}`,
      { cache: "no-store" }
    );
    if (!r.ok) {
      _mmDexCache.set(m, { v: null, t: now });
      return null;
    }

    const j = await r.json().catch(() => ({} as any));
    const pairs: any[] = j?.pairs || [];
    let best = 0;
    let out: { symbol?: string; name?: string } | null = null;
    for (const p of pairs) {
      const liq = Number(p?.liquidity?.usd || 0);
      const base = p?.baseToken || {};
      const s = typeof base?.symbol === "string" ? base.symbol : undefined;
      const n = typeof base?.name === "string" ? base.name : undefined;
      if (liq >= best && (s || n)) {
        best = liq;
        out = { symbol: s, name: n };
      }
    }

    _mmDexCache.set(m, { v: out, t: now });
    return out;
  } catch {
    try {
      const m = String(mint || "").trim();
      if (m) _mmDexCache.set(m, { v: null, t: Date.now() });
    } catch {}
    return null;
  }
}

// --- token meta (name/symbol/logo) via DB/Jupiter ---

async function _mmTokenMeta(mint: string): Promise<_MM_TokenMeta | null> {
  if (!mint) return null;
  const now = Date.now();
  const cached = _mmMeta.get(mint);
  if (cached && now - cached.t < _MM_TTL) return cached.v;

  // 1) Same-origin DB-backed meta first.
  // NOTE: /api/tokens/meta historically returned either:
  // - { items: [...] } (batch shape), or
  // - { data: {...} } (single-mint shape)
  // We accept either to avoid duplicate fetches under load.
  try {
    const u = new URL(
      "/api/tokens/meta",
      typeof window === "undefined" ? "http://localhost" : window.location.origin
    );
    u.searchParams.set("mints", mint);
    const r = await fetch(u.toString(), { cache: "no-store" } as any);
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      // Single-mint shape
      const d = j?.data;
      if (d && (d?.address || d?.mint || d?.symbol || d?.name || d?.decimals != null)) {
        const v: _MM_TokenMeta = {
          address: d?.address || d?.mint || mint,
          name: d?.name,
          symbol: d?.symbol,
          decimals: d?.decimals,
          logoURI: d?.logoURI || d?.logoUri || d?.icon,
        };
        _mmMeta.set(mint, { v, t: now });
        return v;
      }

      // Batch shape
      const items = Array.isArray(j?.items) ? j.items : [];
      const found = items.find((it: any) => (it?.mint || it?.address) === mint);
      if (found) {
        const v: _MM_TokenMeta = {
          address: found?.address || found?.mint || mint,
          name: found?.name,
          symbol: found?.symbol,
          decimals: found?.decimals,
          logoURI: found?.logoURI || found?.logoUri || found?.icon,
        };
        _mmMeta.set(mint, { v, t: now });
        return v;
      }
    }
  } catch {}

  // 2) Jupiter price API may include symbol/name (no logo).
  try {
    const r = await fetch(
      `https://price.jup.ag/v4/price?mints=${encodeURIComponent(mint)}&vsToken=USDC`,
      { cache: "no-store" }
    );
    if (r.ok) {
      const j = await r.json();
      const d = j?.data?.[mint];
      const v: _MM_TokenMeta | null = d
        ? {
            address: mint,
            symbol: d?.symbol,
            name: d?.name,
            decimals: typeof d?.decimals === "number" ? d.decimals : undefined,
          }
        : null;
      if (v) {
        _mmMeta.set(mint, { v, t: now });
        return v;
      }
    }
  } catch {}

  // 3) DexScreener names (last resort, and cached by _mmDexName itself).
  try {
    const ds = await _mmDexName(mint);
    if (ds && (ds.symbol || ds.name)) {
      const v = { address: mint, symbol: ds.symbol, name: ds.name };
      _mmMeta.set(mint, { v, t: now });
      return v;
    }
  } catch {}

  return null;
}

// --- USD prices via Jupiter price v4 ---
async function _mmPricesByMint(mints: string[]): Promise<Record<string, number>> {
  const now = Date.now();
  const uniq = Array.from(new Set(mints.filter(Boolean)));

  const need = uniq.filter((m) => {
    const c = _mmPrice.get(m);
    return !(c && now - c.t < _MM_TTL);
  });

  async function fetchBatch(ids: string[]) {
    const out: Record<string, number> = {};
    if (!ids.length) return out;
    try {
      const key = ids.slice().sort().join(",");
      const headers: Record<string, string> = {};
      const prev = _mmPriceEtag.get(key);
      if (prev?.etag) headers["If-None-Match"] = prev.etag;

      const r = await fetch(`/api/prices?mints=${encodeURIComponent(ids.join(","))}`, { cache: "no-store", headers });
      if (r.status === 304) {
        // Prices unchanged for this batch — refresh timestamps for cached values.
        for (const m of ids) {
          const c = _mmPrice.get(m);
          if (c) _mmPrice.set(m, { v: c.v, t: now });
        }
        return out;
      }
      if (!r.ok) return out;

      const etag = r.headers.get("etag");
      if (etag) { _mmPrunePriceEtags(now); _mmPriceEtag.set(key, { etag, t: now }); }

      const j: any = await r.json().catch(() => ({}));
      const data = (j && (j.data || j.prices || {})) as Record<string, number>;
      for (const [k, v] of Object.entries<any>(data)) {
        const p = Number(v);
        if (Number.isFinite(p)) _mmPrice.set(k, { v: p, t: now });
      }
    } catch {}
    for (const [mint, forced] of Object.entries(_MM_STABLES)) {
      if (need.includes(mint) && !_mmPrice.get(mint)) {
        _mmPrice.set(mint, { v: Number(forced), t: now });
      }
    }
    return out;
  }

  return (async () => {
    if (need.length) await fetchBatch(need);
    const out: Record<string, number> = {};
    for (const m of uniq) {
      const c = _mmPrice.get(m);
      out[m] = c ? c.v : Number.NaN;
    }
    return out;
  })();
}

function formatUsd(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "$–";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

type TokenInfo = { mint: string; symbol?: string; name?: string; logoURI?: string; logoUri?: string };
type Props = {
  setId: string;
  setTitle?: string;
  ownerWallet?: string;
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  
  onAggregatesChange?: (agg: { setId: string; running: boolean; vaultUsdTotal: number; vaultUiSum?: number; equityReady?: boolean; balancesReady?: boolean; hasVault?: boolean }) => void;
  walletShim?: {
    publicKey?: string | { toBase58: () => string };
    sendTransaction?: (tx: any, conn: any, opts?: any) => Promise<string>;
    signTransaction?: (tx: any) => Promise<any>;
    signAllTransactions?: (txs: any[]) => Promise<any>;
  } | null;
  initialVaultAddress?: string | null;
  assumeVaultExists?: boolean;
  /** When true (e.g., dashboard Total Equity is still 'Loading…'), hide transient $0.00 values and show a tiny clock placeholder instead. */
  showLoadingPlaceholders?: boolean;
  /** If true, postpone heavy network/RPC work until panel is visible (no UI change). */
  deferHeavy?: boolean;
};

const SOL_MINT = "So11111111111111111111111111111111111111112";
function toB58(v?: any): string | undefined {
  try {
    if (!v) return undefined;
    if (typeof v === "string") return v;
    if (v instanceof PublicKey) return v.toBase58();
    if (typeof v?.toBase58 === "function") return v.toBase58();
    return String(v);
  } catch {}
  return undefined;
}

const _logoCache: Map<string, { url: string; t: number }> = new Map();
const _LOGO_TTL = 55_000;

async function _getTokenLogo(mint: string, pref?: string | null): Promise<string | null> {
  if (!mint) return pref || null;
  try {
    const now = Date.now();
    const prox = `/api/token-logos/${encodeURIComponent(mint)}`;

    // 0) If we already have a strict URL for this mint (from prior discovery or TokenPicker), prefer it.
    // This avoids publishing placeholder proxy URLs to the global window cache which can poison other views.
    try {
      const strict0 = await _resolveLogoStrict(mint);
      if (strict0 && /^https?:\/\//i.test(strict0)) {
        _logoCache.set(mint, { url: strict0, t: now });
        _emitLogo(mint, strict0);
        return strict0;
      }
    } catch {}

    // Prefer provided TokenPicker/Jupiter logo when available.
    if (pref && /^https?:\/\//i.test(pref)) {
      _logoCache.set(mint, { url: pref, t: now });
      _emitLogo(mint, pref);
      // Warm proxy in background
      try { fetch(prox, { method: 'HEAD', cache: 'no-store' } as any).catch(() => {}); } catch {}
      return pref;
    }

    // Cached proxied resolver
    const cached = _logoCache.get(mint);
    if (cached && now - cached.t < _LOGO_TTL) return cached.url;

    // Display-only fallback: use the proxied resolver with a minute bucket cache buster.
    // Do NOT write this placeholder into window.mmTokenLogos to avoid cross-component pollution.
    const mmv = Math.floor(now / 60000);
    const proxWithBust = `${prox}?mmv=${mmv}`;
    _logoCache.set(mint, { url: proxWithBust, t: now });
    return proxWithBust;
  } catch {
    return pref || null;
  }
}

async function _resolveLogoStrict(mint: string): Promise<string | null> {
  if (!mint) return null;
  const needle = String(mint).trim();

  // 1) global mint→logo registry (Jupiter Lite-only backfill)
  try {
    const r = await fetch(`/api/token-logos/registry/${encodeURIComponent(mint)}`, { cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    const u = String(j?.url || "").trim();
    if (u && /^https?:\/\//i.test(u)) return u;
  } catch {}

  // 2) exact meta from same-origin DB (display-only fallback)
  try {
    const r = await fetch(`/api/tokens/meta?mints=${encodeURIComponent(mint)}`, { cache: "no-store" });
    const j: any = await r.json().catch(() => ({}));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    const exact = items.find((it: any) => String(it?.address || it?.mint || "").trim() === needle);
    const u = String(exact?.logoURI || exact?.logoUri || exact?.icon || "").trim();
    if (u && /^https?:\/\//i.test(u)) return u;
  } catch {}

  // 3) Jupiter Lite per-mint (display-only fallback)
  try {
    const r = await fetch(`/api/tokens/meta?mints=${encodeURIComponent(mint)}`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const data: any = j?.data || null;
      const u = String(data?.logoURI || data?.logoUri || data?.icon || "").trim();
      if (u && /^https?:\/\//i.test(u)) return u;
    }
  } catch {}

  // 4) Final: exact match from /api/tokens/search (no arr[0] fallback)
  try {
    const r = await fetch(`/api/tokens/search?q=${encodeURIComponent(mint)}`, { cache: "no-store" });
    const j: any = await r.json().catch(() => ({} as any));
    const arr: any[] = Array.isArray(j?.tokens) ? j.tokens : Array.isArray(j?.items) ? j.items : [];
    const exact = arr.find((t: any) => String(t?.address || t?.mint || "").trim() === needle);
    const u = String(exact?.logoURI || exact?.logoUri || exact?.icon || "").trim();
    if (u && /^https?:\/\//i.test(u)) return u;
  } catch {}

  // window cache (hints only): consult last, and only if it looks safe for this mint
  try {
    if (typeof window !== "undefined") {
      const u = (window as any)?.mmTokenLogos?.[mint];
      if (u && _isTrustedLogoUrl(mint, u)) return String(u);
    }
  } catch {}

  return null;
}


async function _rememberLogoInDb(mint: string, url: string): Promise<void> {
  try {
    await fetch(`/api/token-logos/${encodeURIComponent(mint)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, source: "ui-fallback" }),
    });
  } catch { /* ignore */ }
}

function BalanceNumber(props: { value: number; decimalsHint?: number; title?: string }) {
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

function TokenBadge(props: { mint: string; label: string; prefLogo?: string | null }) {
  const { mint, label, prefLogo } = props;
  const [logo, setLogo] = React.useState<string | null>(null);

  // Reset logo when the mint changes so we don't briefly show a wrong cached image.
  React.useEffect(() => { setLogo(null); }, [mint]);


  React.useEffect(() => {
    let alive = true;
    (async () => {
      const u = await _getTokenLogo(mint, prefLogo);
      if (!alive) return;
      setLogo(u);
    })();
    return () => { alive = false; };
  }, [mint, prefLogo]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    // Listener fanout guard: only listen while we still need a logo.
    if (logo) return;
    let removed = false;
    const onMsg = (ev: any) => {
      try {
        const d = ev?.detail || {};
        if (String(d?.mint || "").trim() === String(mint).trim() && d?.url) {
          setLogo(String(d.url));
          // One-shot: once we have a logo, stop listening to reduce listener fanout on large dashboards.
          if (!removed) {
            removed = true;
            try { window.removeEventListener("mm:tokenlogo" as any, onMsg as any); } catch {}
          }
        }
      } catch {}
    };
    window.addEventListener("mm:tokenlogo" as any, onMsg as any);
    return () => {
      if (removed) return;
      removed = true;
      try { window.removeEventListener("mm:tokenlogo" as any, onMsg as any); } catch {}
    };
  }, [mint, logo]);

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
              const strict = await _resolveLogoStrict(mint);
              if (strict) {
                setLogo(strict);
                _emitLogo(mint, strict);
                try { await _rememberLogoInDb(mint, strict); } catch {}
                return;
              }
              setLogo(`/api/token-logos/${encodeURIComponent(mint)}`);
              
            } catch {}
          }}
          onLoad={(e) => {
            try {
              const el = e.currentTarget as HTMLImageElement;
              const w = el?.naturalWidth || 0;
              const h = el?.naturalHeight || 0;
              if (w <= 1 || h <= 1) {
                (async () => {
                  const strict = await _resolveLogoStrict(mint);
                  if (strict) {
                    setLogo(strict);
                    _emitLogo(mint, strict);
                    try { await _rememberLogoInDb(mint, strict); } catch {}
                  }
                })();
              }
            } catch { /* ignore */ }
          }}
        />
      ) : (
        <span className="h-4 w-4 sm:h-5 sm:w-5 rounded-full bg-white/10 ring-1 ring-white/10" />
      )}
      <span className="ml-1 text-xs sm:text-sm font-medium">{label}</span>
    </span>
  );
}

export default function VaultInlinePanel(props: Props): React.ReactElement {
  const deferHeavy = Boolean(props?.deferHeavy);
  const showLoadingPlaceholders = Boolean((props as any)?.showLoadingPlaceholders);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Sticky token logos — hydrate per-set from Upstash on mount & refresh
  React.useEffect(() => {
    (async () => {
      try {
        const setId = String(props?.setId || "").trim();
        if (!setId || typeof window === "undefined") return;
        /* prime from localStorage first to avoid flicker */
        try {
          const lsRaw = localStorage.getItem("mmPickerLogos") || "{}";
          const ls: any = JSON.parse(lsRaw);
          const mintsLS = [props?.tokenA?.mint, props?.tokenB?.mint].map((x: any) => String(x || "").trim()).filter(Boolean);
          const g0: any = window as any;
          g0.mmTokenLogos = g0.mmTokenLogos || {};
          for (const m of mintsLS) {
            const u0 = String(ls?.[m] || "").trim();
            if (u0 && /^https?:\/\//i.test(u0) && _isTrustedLogoUrl(m, u0)) {
              g0.mmTokenLogos[m] = u0;
              try { window.dispatchEvent(new CustomEvent("mm:tokenlogo", { detail: { mint: m, url: u0 } })); } catch {}
            }
          }
        } catch {}
        const logos = await _mmGetSetLogosCached(setId);
        const g: any = window as any;
        g.mmTokenLogos = g.mmTokenLogos || {};
        const mints = [props?.tokenA?.mint, props?.tokenB?.mint].map((x: any) => String(x || "").trim()).filter(Boolean);
        for (const m of mints) {
          const u = String((logos as any)[m] || "").trim();
          if (u && /^https?:\/\//i.test(u) && _isTrustedLogoUrl(m, u)) {
            g.mmTokenLogos[m] = u;
            try { window.dispatchEvent(new CustomEvent("mm:tokenlogo", { detail: { mint: m, url: u } })); } catch {}
          }
        }
      } catch {}
    })();
  }, [props?.setId, props?.tokenA?.mint, props?.tokenB?.mint]);
  const [active, setActive] = useState<boolean>(() => !deferHeavy);

  // Viewport-activation: on low-end devices, delay heavy effects until the panel enters the viewport.
  useEffect(() => {
    if (!deferHeavy) return;
    let timer: any = null;
    let obs: any = null;
    try {
      if (typeof window !== "undefined" && "IntersectionObserver" in window) {
        obs = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              setActive(true);
              if (obs) { try { obs.disconnect(); } catch {} }
              break;
            }
          }
        }, { rootMargin: "200px" });
        if (rootRef.current) { try { obs.observe(rootRef.current); } catch {} }
      }
      // Fallback: ensure activation happens eventually even if not observed (e.g., hidden in tabs)
      timer = setTimeout(() => setActive(true), 4000);
    } catch {
      timer = setTimeout(() => setActive(true), 1000);
    }
    return () => { if (obs) { try { obs.disconnect(); } catch {} } if (timer) clearTimeout(timer); };
  }, [deferHeavy]);

  const balancesInFlightRef = useRef(false);
  const lastBalanceAtRef = useRef<number>(0);
  const balanceReqSeqRef = useRef<number>(0);

  const { shouldPoll } = usePollingGate({ idleMs: 60_000 });
  const { setId, ownerWallet, tokenA, tokenB, onAggregatesChange, walletShim, initialVaultAddress, assumeVaultExists } =
    props;
  const _mintAProp = tokenA?.mint || "";
  const _mintBProp = tokenB?.mint || "";
  const [mintA, setMintA] = useState<string>(_mintAProp);
  const [mintB, setMintB] = useState<string>(_mintBProp);

  useEffect(() => { setMintA(_mintAProp); setMintB(_mintBProp); }, [_mintAProp, _mintBProp]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const owner = String(ownerWallet || "").trim() || toB58(walletShim?.publicKey);
        const sid = String(setId || "").trim();
        if (!owner || !sid) return;
        if (!active) return;
        const aCur = String(mintA || "").trim();
        const bCur = String(mintB || "").trim();
        // If we already have valid-looking mints, avoid the extra set fetch (app page props are authoritative).
        if (aCur.length >= 30 && bCur.length >= 30) return;
        const rr = await fetch(`/api/webhooks/set/${encodeURIComponent(sid)}`, { cache: "no-store" });
        if (rr.ok) {
          const jj = await rr.json().catch(() => ({}));
          const s = (jj && jj.set) || null;
          const p = (s && s.prefs) || {};
          const a = p?.mintA || p?.mintIn || s?.mintA || s?.mintIn || s?.tokenA?.mint || s?.aMint || s?.buyOutputMint || s?.sellInputMint || _mintAProp;
          const b = p?.mintB || p?.mintOut || s?.mintB || s?.mintOut || s?.tokenB?.mint || s?.bMint || s?.sellOutputMint || _mintBProp;
          const aa = _mintAProp || a; const bb = _mintBProp || b; if (alive) { if (aa && aa !== mintA) setMintA(aa); if (bb && bb !== mintB) setMintB(bb); }
        }
      } catch {}
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setId, toB58(walletShim?.publicKey), active]);
  const [nameA, setNameA] = useState<string>("");
  const [nameB, setNameB] = useState<string>("");
  const [priceA, setPriceA] = useState<number | undefined>(undefined);
  const [priceB, setPriceB] = useState<number | undefined>(undefined);
  const lastPriceUpdateAtRef = useRef<number>(0);

  // Detect dashboard context early (used for polling fanout decisions + Mojo Pro gating)
  const pathname = usePathname();
  const __mmIsAppDashboard = pathname === "/app" || pathname.startsWith("/app/");
  const __mmOwnerB58 = useMemo(() => {
    const explicit = String(ownerWallet || "").trim();
    return explicit || toB58(walletShim?.publicKey);
  }, [ownerWallet, walletShim?.publicKey]);
  const __mmMojoProActive = useMojoProActive(__mmOwnerB58, __mmIsAppDashboard);


  useEffect(() => {
    if (!active) return;
    try {
      if (typeof window === "undefined") return;
      const g = (window as any).mmTokenLogos || ((window as any).mmTokenLogos = {});
      const la = (tokenA as any)?.logoURI || (tokenA as any)?.logoUri;
      if (la && mintA) g[mintA] = la;
      try { const prefA = (tokenA as any)?.mint || _mintAProp; if (la && prefA) g[prefA] = la; } catch {}
      const lb = (tokenB as any)?.logoURI || (tokenB as any)?.logoUri;
      if (lb && mintB) g[mintB] = lb;
      try { const prefB = (tokenB as any)?.mint || _mintBProp; if (lb && prefB) g[prefB] = lb; } catch {}
    } catch {}
  }, [mintA, mintB, (tokenA as any)?.logoURI, (tokenA as any)?.logoUri, (tokenB as any)?.logoURI, (tokenB as any)?.logoUri]);
  useEffect(() => {
    try {
      const la = (tokenA as any)?.logoURI || (tokenA as any)?.logoUri || null;
      const lb = (tokenB as any)?.logoURI || (tokenB as any)?.logoUri || null;
      if (mintA && la) _emitLogo(mintA, la);
      if (mintB && lb) _emitLogo(mintB, lb);
    } catch {}
  }, [mintA, mintB, (tokenA as any)?.logoURI, (tokenA as any)?.logoUri, (tokenB as any)?.logoURI, (tokenB as any)?.logoUri]);


  useEffect(() => {
    let alive = true;

    (async () => {
      const [ma, mb] = await Promise.all([_mmTokenMeta(mintA), _mmTokenMeta(mintB)]);
      if (!alive) return;
      const dispA = (
        (tokenA?.symbol || tokenA?.name) ?
          (tokenA?.symbol || tokenA?.name) :
          (_MM_STABLES[mintA] ? (_MM_STABLES[mintA]) :
            (ma?.symbol || ma?.name || (mintA ? mintA.slice(0, 6) : "")))
      );
      const dispB = (
        (tokenB?.symbol || tokenB?.name) ?
          (tokenB?.symbol || tokenB?.name) :
          (_MM_STABLES[mintB] ? (_MM_STABLES[mintB]) :
            (mb?.symbol || mb?.name || (mintB ? mintB.slice(0, 6) : "")))
      );

      setNameA(dispA);
      setNameB(dispB);
    })();

    (async () => {
      const map = await _mmPricesByMint([mintA, mintB]);
      if (!alive) return;
      lastPriceUpdateAtRef.current = Date.now();
      setPriceA((prev) => (Number.isFinite(Number(map[mintA])) ? Number(map[mintA]) : prev));
      setPriceB((prev) => (Number.isFinite(Number(map[mintB])) ? Number(map[mintB]) : prev));
    })();

    let t: any;
    if (shouldPoll) {
      if (!__mmIsAppDashboard) {
        // On /webhooks (or non-dashboard), poll occasionally as the panel may be the only price source.
        t = setInterval(async () => {
          const map = await _mmPricesByMint([mintA, mintB]);
          if (!alive) return;
          lastPriceUpdateAtRef.current = Date.now();
          setPriceA((prev) => (Number.isFinite(map[mintA]) ? map[mintA] : prev));
          setPriceB((prev) => (Number.isFinite(map[mintB]) ? map[mintB] : prev));
        }, withJitterMs(60_000, 0.2));
      } else {
        // On /app dashboard, prices are generally broadcast globally. Avoid N panels polling every minute.
        // Keep a slow safety fallback (only if we haven't seen a price update recently).
        t = setInterval(async () => {
          if (!alive) return;
          const now = Date.now();
          const last = Number(lastPriceUpdateAtRef.current || 0);
          const never = last <= 0;
          const stale = !never && (now - last > 5 * 60_000);
          if (!never && !stale) return;
          const map = await _mmPricesByMint([mintA, mintB]);
          if (!alive) return;
          lastPriceUpdateAtRef.current = Date.now();
          setPriceA((prev) => (Number.isFinite(map[mintA]) ? map[mintA] : prev));
          setPriceB((prev) => (Number.isFinite(map[mintB]) ? map[mintB] : prev));
        }, withJitterMs(8 * 60_000, 0.2));
      }
    }

    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [mintA, mintB, tokenA?.name, tokenA?.symbol, tokenB?.name, tokenB?.symbol, shouldPoll, active, __mmIsAppDashboard]);

  function _toNum(v: any) {
    if (v == null) return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") return Number(v) || 0;
    if (typeof v === "object" && typeof (v as any).ui !== "undefined")
      return Number((v as any).ui) || 0;
    return 0;
  }
  const walletBalances = (props as any)?.walletBalances || {};
  const vaultBalances = (props as any)?.vaultBalances || {};
  const wA = _toNum(walletBalances[mintA]);
  const wB = _toNum(walletBalances[mintB]);
  const vA = _toNum(vaultBalances[mintA]);
  const vB = _toNum(vaultBalances[mintB]);

  const [vaultAddress, setVaultAddress] = useState<string | undefined>(
    initialVaultAddress || undefined
  );
  const [vaultExists, setVaultExists] = useState<boolean>(
    Boolean(initialVaultAddress && assumeVaultExists)
  );
  const vaultExistedRef = useRef<boolean>(Boolean(initialVaultAddress && assumeVaultExists));
  useEffect(() => {
    if (vaultExists) vaultExistedRef.current = true;
  }, [vaultExists]);
  const [status, setStatus] = useState<"running" | "stopped" | "paused">("stopped");
  const [lastSig, setLastSig] = useState<TransactionSignature | null>(null);

  const [userA, setUserA] = useState<{ ui: number; dec: number }>({
    ui: 0,
    dec: 0,
  });
  const [userB, setUserB] = useState<{ ui: number; dec: number }>({
    ui: 0,
    dec: 0,
  });
  const [vaultA, setVaultA] = useState<{ ui: number; dec: number }>({
    ui: 0,
    dec: 0,
  });
  const [vaultB, setVaultB] = useState<{ ui: number; dec: number }>({
    ui: 0,
    dec: 0,
  });

  // True once we've completed at least one balance refresh (even if balances are 0).
  const [balancesReady, setBalancesReady] = useState(false);


  const lastEquityNudgeAtRef = useRef<number>(0);
  const refreshMissingPricesLight = useCallback(async () => {
    try {
      // Throttle: large pages can nudge multiple panels at once.
      const now = Date.now();
      if (now - lastEquityNudgeAtRef.current < 2_000) return;
      lastEquityNudgeAtRef.current = now;

      const want: string[] = [];
      const aUi = Number(vaultA?.ui ?? 0);
      const bUi = Number(vaultB?.ui ?? 0);
      if (aUi > 0 && !Number.isFinite(Number(priceA))) want.push(mintA);
      if (bUi > 0 && !Number.isFinite(Number(priceB))) want.push(mintB);
      const ids = Array.from(new Set(want)).filter(Boolean);
      if (ids.length === 0) return;

      const map = await _mmPricesByMint(ids);
      // Only fill missing; never overwrite an existing finite price.
      try {
        const pa = map[mintA];
        if (aUi > 0 && Number.isFinite(pa)) setPriceA((cur) => (Number.isFinite(cur as any) ? cur : Number(pa)));
      } catch {}
      try {
        const pb = map[mintB];
        if (bUi > 0 && Number.isFinite(pb)) setPriceB((cur) => (Number.isFinite(cur as any) ? cur : Number(pb)));
      } catch {}
    } catch {}
  }, [mintA, mintB, priceA, priceB, vaultA?.ui, vaultB?.ui]);

  useEffect(() => {
    if (!active) return;
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
  }, [active, setId, refreshMissingPricesLight]);

  const [depB, setDepB] = useState<string>("");


  const onMaxDepositB = useCallback(() => {
    try {
      const amt = Number(userB?.ui || 0);
      if (!Number.isFinite(amt) || amt <= 0) { setDepB(""); return; }
      const dec = Math.max(0, Math.min(9, Number(userB?.dec || 6)));
      const s = amt.toFixed(dec).replace(/\.?0+$/, "");
      setDepB(s);
    } catch {
      setDepB("");
    }
  }, [userB]);
  const [loading, setLoading] = useState(false);

  // Manual Swap (dashboard-only)
  const [__mmManualClicks, set__mmManualClicks] = useState(0);
  const __mmManualLastClickRef = useRef<number>(0);
  const __mmManualResetTimerRef = useRef<any>(null);
  const [__mmManualSwapping, set__mmManualSwapping] = useState(false);
  const [__mmManualDoneAt, set__mmManualDoneAt] = useState<number>(0);

  const __mmResetManualClicks = useCallback(() => {
    set__mmManualClicks(0);
    __mmManualLastClickRef.current = 0;
    if (__mmManualResetTimerRef.current) {
      try { clearTimeout(__mmManualResetTimerRef.current); } catch {}
      __mmManualResetTimerRef.current = null;
    }
  }, []);

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

  useEffect(() => {
    if (status !== "running") __mmResetStopClicks();
  }, [status, __mmResetStopClicks]);


  useEffect(() => {
    // Clear any partial confirm if bot stops or user navigates away from /app
    if (!__mmIsAppDashboard || status !== "running") {
      __mmResetManualClicks();
    }
  }, [__mmIsAppDashboard, status, __mmResetManualClicks]);

  useEffect(() => {
    if (!__mmManualDoneAt) return;
    const t = setTimeout(() => set__mmManualDoneAt(0), 2000);
    return () => { try { clearTimeout(t); } catch {} };
  }, [__mmManualDoneAt]);


  // ---- Manual Swap (dashboard-only) ----
  async function __mmExecuteManualSwap() {
    const owner = __mmOwnerB58;
    if (!owner) return alert("Connect wallet first.");
    if (!vaultExists) return alert("Create the vault first.");
    if (!__mmIsAppDashboard) return; // safety (dashboard-only surface)
    try {
      setLoading(true);
      set__mmManualSwapping(true);
      const r = await fetch("/api/vaults/manual-swap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setId, ownerPubkey: owner }),
      });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok || !j?.ok) {
        const err = String(j?.error || "manual_swap_failed");
        alert(err.replace(/_/g, " "));
        return;
      }
      set__mmManualDoneAt(Date.now());
      // Purge RPC balance caches so post-swap reads do not serve stale values (balance cache TTL is 60s).
      try { purgeRpcCache((k) => k.includes("|getTokenAccountBalance|") || k.includes("|getBalance|")); } catch {}
      // Refresh balances immediately (and notify listeners)
      try { window.dispatchEvent(new CustomEvent("mm:vault-updated", { detail: { setId } })); } catch {}
      // Force-refresh: bypass the 1s throttle so the UI updates right after a manual swap.
      try { lastBalanceAtRef.current = 0; } catch {}
      try { setTimeout(() => void refreshBalances(), 1200); } catch {}
      try { queueRefreshBalances(2400); } catch {}
      try { queueRefreshBalances(5200); } catch {}
    } catch (e: any) {
      alert(String(e?.message || "manual_swap_failed"));
    } finally {
      __mmResetManualClicks();
      set__mmManualSwapping(false);
      setLoading(false);
    }
  }

  function onManualSwapClick() {
    if (loading || __mmManualSwapping) return;
    if (!__mmIsAppDashboard) return;
    if (status !== "running") return;
    const now = Date.now();
    const within = __mmManualLastClickRef.current && (now - __mmManualLastClickRef.current) <= 1500;
    const next = within ? Math.min(3, __mmManualClicks + 1) : 1;
    __mmManualLastClickRef.current = now;
    set__mmManualClicks(next);
    if (__mmManualResetTimerRef.current) {
      try { clearTimeout(__mmManualResetTimerRef.current); } catch {}
      __mmManualResetTimerRef.current = null;
    }
    __mmManualResetTimerRef.current = setTimeout(() => {
      __mmResetManualClicks();
    }, 1700);
    if (next >= 3) {
      __mmResetManualClicks();
      void __mmExecuteManualSwap();
    }
  }




  const ownerPk = useMemo(() => {
    const explicit = String(ownerWallet || "").trim();
    return explicit || toB58(walletShim?.publicKey);
  }, [ownerWallet, walletShim?.publicKey]);

  useEffect(() => {
    // Wallet switches can race with a reused/stale wallet shim in mobile/in-app browsers.
    // Reset readiness and purge any in-flight result so the panel never commits a mismatched owner's $0 snapshot.
    balanceReqSeqRef.current += 1;
    balancesInFlightRef.current = false;
    lastBalanceAtRef.current = 0;
    setBalancesReady(false);
  }, [ownerPk, setId, mintA, mintB]);

  const refreshBalances = useCallback(async () => {
    if (balancesInFlightRef.current) return;
    const _now = Date.now();
    if (_now - lastBalanceAtRef.current < 1000) return;
    balancesInFlightRef.current = true;
    const reqSeq = ++balanceReqSeqRef.current;

    try {
      if (!ownerPk || !setId || !tokenA?.mint || !tokenB?.mint) return;
      const res = await readBalances(
        new PublicKey(ownerPk),
        setId,
        tokenA.mint,
        tokenB.mint
      );
      const conn = ensureConnection();

      let userA_ui = Number(res?.userA?.uiAmount ?? 0);
      let userA_dec = Number(res?.userA?.decimals ?? 0);
      let userB_ui = Number(res?.userB?.uiAmount ?? 0);
      let userB_dec = Number(res?.userB?.decimals ?? 0);
      let vaultA_ui = Number(res?.vaultA?.uiAmount ?? 0);
      let vaultA_dec = Number(res?.vaultA?.decimals ?? 0);
      let vaultB_ui = Number(res?.vaultB?.uiAmount ?? 0);
      let vaultB_dec = Number(res?.vaultB?.decimals ?? 0);

      let vaultAuthPk: PublicKey | null = null;
      try {
        const vStr = toB58(res?.vault) || vaultAddress || null;
        const pidStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID;
        if (vStr && pidStr) {
          const [auth] = deriveVaultAuthorityPda(new PublicKey(pidStr), new PublicKey(vStr));
          vaultAuthPk = auth;
        }
      } catch {}

      if (tokenA.mint === SOL_MINT) {
        try {
          const lam = await cachedGetBalance(conn, new PublicKey(ownerPk), "processed");
          userA_ui = (Number(userA_ui) || 0) + (lam / LAMPORTS_PER_SOL);
          userA_dec = 9;
        } catch {}
        try {
          if (vaultAuthPk) {
            const lam = await cachedGetBalance(conn, vaultAuthPk, "processed");
            vaultA_ui = (Number(vaultA_ui) || 0) + (lam / LAMPORTS_PER_SOL);
            vaultA_dec = 9;
          }
        } catch {}
      }

      if (tokenB.mint === SOL_MINT) {
        try {
          const lam = await cachedGetBalance(conn, new PublicKey(ownerPk), "processed");
          userB_ui = (Number(userB_ui) || 0) + (lam / LAMPORTS_PER_SOL);
          userB_dec = 9;
        } catch {}
        try {
          if (vaultAuthPk) {
            const lam = await cachedGetBalance(conn, vaultAuthPk, "processed");
            vaultB_ui = (Number(vaultB_ui) || 0) + (lam / LAMPORTS_PER_SOL);
            vaultB_dec = 9;
          }
        } catch {}
      }

      if (reqSeq !== balanceReqSeqRef.current) return;

      setUserA({ ui: userA_ui, dec: userA_dec });
      setUserB({ ui: userB_ui, dec: userB_dec });
      setVaultA({ ui: vaultA_ui, dec: vaultA_dec });
      setVaultB({ ui: vaultB_ui, dec: vaultB_dec });

      const v = toB58(res?.vault);
      if (v && !vaultAddress) {
        setVaultAddress(v);
        setVaultExists(true);
      }
    } catch (e) {
      console.error("[VaultInlinePanel] readBalances failed", e);
    }
    finally {
      balancesInFlightRef.current = false;
      lastBalanceAtRef.current = Date.now();
      try { if (reqSeq === balanceReqSeqRef.current) setBalancesReady(true); } catch {}
    }

  }, [ownerPk, setId, tokenA?.mint, tokenB?.mint, vaultAddress]);

  const _refreshLeadTimerRef = useRef<any>(null);
  const _refreshTrailTimerRef = useRef<any>(null);
  const _refreshTrailAtRef = useRef<number>(0);

  // Coalesced refresh scheduler:
  // - Schedules an immediate (leading) refresh at most once per tick.
  // - Allows ONE trailing refresh at a later time (e.g., after confirmations) without canceling the leading refresh.
  // This prevents post-tx "refresh storms" that can freeze Android WebViews.
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

  
  // --- Invalidate cached balances for user+vault ATAs so the post-action refresh reads fresh values.
  const invalidateTokenBalanceCache = useCallback(() => {
    try {
      const ownerStr = String(ownerWallet || "").trim() ||
        toB58(walletShim?.publicKey) ||
        (typeof window !== "undefined" && (window as any)?.solana?.publicKey?.toBase58?.()) ||
        null;
      const vStr = vaultAddress || null;
      if (!ownerStr || !vStr) return;
      const ownerPk = new PublicKey(ownerStr);
      const vPk = new PublicKey(vStr);
      const pidStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID;
      if (!pidStr) return;
      const [authPk] = deriveVaultAuthorityPda(new PublicKey(pidStr), vPk);

      const mints: string[] = [String(tokenA?.mint||""), String(tokenB?.mint||"")].filter((m) => m && m.length > 30);
      const atas: string[] = [];
      for (const m of mints) {
        try {
          const mintPk = new PublicKey(m);
          // Owner + Vault authority under both Token and Token-2022
          try { atas.push(getAssociatedTokenAddressSync(mintPk, ownerPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()); } catch {}
          try { atas.push(getAssociatedTokenAddressSync(mintPk, ownerPk, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()); } catch {}
          try { atas.push(getAssociatedTokenAddressSync(mintPk, authPk,  true,  TOKEN_PROGRAM_ID,  ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()); } catch {}
          try { atas.push(getAssociatedTokenAddressSync(mintPk, authPk,  true,  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()); } catch {}
        } catch {}
      }
      const uniqAtas = Array.from(new Set(atas));
      purgeRpcCache((key: string) => {
        // token account balances + account infos for these ATAs
        if (uniqAtas.some((a) => key.includes(a))) {
          if (key.includes("getTokenAccountBalance") || key.includes("getAccountInfo")) return true;
        }
        // native SOL balances (used when mint === SOL_MINT)
        if (key.includes(ownerPk.toBase58()) && key.includes("getBalance")) return true;
        if (key.includes(authPk.toBase58()) && key.includes("getBalance")) return true;
        return false;
      });
    } catch {}
  }, [ownerWallet, walletShim?.publicKey, vaultAddress, tokenA?.mint, tokenB?.mint]);
const __mmVaultRegId = React.useRef<string>((() => {
    try { return 'vault:' + Math.random().toString(36).slice(2); } catch { return 'vault:' + Date.now(); }
  })());
  React.useEffect(() => {
    const id: string = __mmVaultRegId.current;
    return registerVisibleMints(id, [mintA, mintB].filter(Boolean) as string[]);
  }, [mintA, mintB]);

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      const w: any = window as any;
      const symCache = w.mmSymbolCache || {};
      const priceCache = w.mmPriceCache || {};
      if (mintA) {
        const prevA = symCache[mintA];
        if (prevA && !nameA) setNameA(String(prevA).toUpperCase());
        const pa = Number(priceCache[mintA]);
        if (Number.isFinite(pa)) setPriceA((cur) => (Number.isFinite(cur as any) ? cur : pa));
      }
      if (mintB) {
        const prevB = symCache[mintB];
        if (prevB && !nameB) setNameB(String(prevB).toUpperCase());
        const pb = Number(priceCache[mintB]);
        if (Number.isFinite(pb)) setPriceB((cur) => (Number.isFinite(cur as any) ? (cur as number) : pb));
      }
      const onPrices = (ev: any) => {
        const map = (ev?.detail || {}) as Record<string, number>;
        lastPriceUpdateAtRef.current = Date.now();
        if (mintA && Number.isFinite(Number(map[mintA]))) {
          const v = Number(map[mintA]);
          setPriceA((cur) => (Number.isFinite(cur as any) ? (v || (cur as any)) : v));
        }
        if (mintB && Number.isFinite(Number(map[mintB]))) {
          const v = Number(map[mintB]);
          setPriceB((cur) => (Number.isFinite(cur as any) ? (v || (cur as any)) : v));
        }
      };
      window.addEventListener("mm:rebalance:prices", onPrices as any);
      return () => window.removeEventListener("mm:rebalance:prices", onPrices as any);
    } catch {}
  }, [mintA, mintB]);
  React.useEffect(() => {
    function onSymbols(ev: any) {
      try {
        const map = (ev?.detail || {}) as Record<string, string>;
        if (mintA && typeof map[mintA] === 'string' && !nameA) {
          const s = String(map[mintA]).toUpperCase();
          if (s) setNameA((cur) => (cur ? cur : s));
        }
        if (mintB && typeof map[mintB] === 'string' && !nameB) {
          const s = String(map[mintB]).toUpperCase();
          if (s) setNameB((cur) => (cur ? cur : s));
        }
      } catch {}
    }
    try {
      window.addEventListener('mm:rebalance:symbols' as any, onSymbols as any);
      return () => { window.removeEventListener('mm:rebalance:symbols' as any, onSymbols as any); };
    } catch { return; }
  }, [mintA, mintB, nameA, nameB]);

  useEffect(() => {
    if (!active) return;
    queueRefreshBalances(0);
  }, [ownerPk, tokenA?.mint, tokenB?.mint, setId, active]);

  useEffect(() => {
    if (!active) return;

    // IMPORTANT: filter by setId so one vault's refresh doesn't fan out to every mounted panel.
    const handler = (ev: any) => {
      try {
        const sid = ev?.detail?.setId;
        if (sid && String(sid) !== String(setId)) return;
      } catch {}
      queueRefreshBalances(0);
    };

    window.addEventListener("mm:vault-updated", handler as any);
    return () => window.removeEventListener("mm:vault-updated", handler as any);
  }, [active, setId, queueRefreshBalances]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/vaults/status/${encodeURIComponent(setId)}`, {
          cache: "no-store",
        });
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (j?.ok) {
          const v = toB58(j.vault);
          if (v) {
            setVaultAddress(v);
            setVaultExists(true);
          }
          const s = String(j.status || "").toLowerCase();
          if (s === "running" || s === "paused" || s === "stopped")
            setStatus(s as any);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [setId, active]);

  const walletAUsd = useMemo(
    () => (priceA !== undefined ? userA.ui * priceA : undefined),
    [userA.ui, priceA]
  );
  const vaultAUsd = useMemo(
    () => (priceA !== undefined ? vaultA.ui * priceA : undefined),
    [vaultA.ui, priceA]
  );
  const walletBUsd = useMemo(
    () => (priceB !== undefined ? userB.ui * priceB : undefined),
    [userB.ui, priceB]
  );
  
  const walletUsdTotal = useMemo(() => {
    try {
      const a = walletAUsd;
      const b = walletBUsd;
      if (a === undefined && b === undefined) return undefined;
      return Number(a ?? 0) + Number(b ?? 0);
    } catch {
      return undefined;
    }
  }, [walletAUsd, walletBUsd]);
  const vaultBUsd = useMemo(
    () => (priceB !== undefined ? vaultB.ui * priceB : undefined),
    [vaultB.ui, priceB]
  );

  const _vaultUsdTotal = useMemo(() => {
    const a = uiFromTokenBal(vaultAUsd);
    const b = uiFromTokenBal(vaultBUsd);
    return a + b;
  }, [vaultAUsd, vaultBUsd]);
  const vaultUsdTotal = _vaultUsdTotal;

  const _vaultUiSum = useMemo(() => {
    try {
      const a = Number(vaultA?.ui ?? 0);
      const b = Number(vaultB?.ui ?? 0);
      return (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
    } catch { return 0; }
  }, [vaultA?.ui, vaultB?.ui]);

  const _equityReady = useMemo(() => {
    try {
      // Equity is "ready" once every non-zero vault token has a known USD price.
      const aUi = Number(vaultA?.ui ?? 0);
      const bUi = Number(vaultB?.ui ?? 0);
      const aOk = !(aUi > 0) || (priceA !== undefined && Number.isFinite(Number(priceA)));
      const bOk = !(bUi > 0) || (priceB !== undefined && Number.isFinite(Number(priceB)));
      return Boolean(aOk && bOk);
    } catch { return false; }
  }, [vaultA?.ui, vaultB?.ui, priceA, priceB]);

  const _isRunningNow = useMemo(() => (status === "running" && vaultExists), [status, vaultExists]);

  useEffect(() => {
    if (typeof onAggregatesChange === "function") {
      try { onAggregatesChange({ setId, running: _isRunningNow, vaultUsdTotal: _vaultUsdTotal, vaultUiSum: _vaultUiSum, equityReady: _equityReady, balancesReady: balancesReady, hasVault: vaultExists }); } catch {}
    }
  }, [onAggregatesChange, setId, _isRunningNow, _vaultUsdTotal, _vaultUiSum, _equityReady, balancesReady, vaultExists]);

  const canWithdrawAll = status === "stopped" && (vaultA.ui > 0 || vaultB.ui > 0);
  const isRunning = status === "running" && vaultExists;
  const statusText = isRunning
    ? "Vault Running"
    : vaultExists
    ? "Vault Stopped"
    : "Vault Stopped (Awaiting Funds)";

  async function tryRpcControl(action: "start" | "stop") {
    const routes = [
      `/api/vaults/${action}`,
      `/api/vaults/${action === "start" ? "set-running" : "set-stopped"}`,
    ];
    for (const url of routes) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ setId }),
        });
        if (r.ok) return true;



      } catch {}
    }
    try {
      const r = await fetch(`/api/vaults/status/${encodeURIComponent(setId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: action === "start" ? "running" : "stopped" }),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async function onStart() {
    const owner = String(ownerWallet || "").trim() || toB58(walletShim?.publicKey);
    if (!owner) {
      alert("Connect wallet first.");
      return;
    }

    // If this panel is showing "Create Vault", we must create+initialize (or heal) the vault before starting.
    // Even when a vault PDA already exists, it can be in an uninitialized state (rare RPC hiccup). In that case,
    // /api/vaults/create will return a tx to initialize it, and the wallet will prompt for a separate signature.
    if (!vaultExists || !vaultExistedRef.current) {
      try {
        setLoading(true);
        const adapter: any = {
          publicKey: walletShim?.publicKey
            ? (typeof (walletShim as any).publicKey === "string"
                ? { toBase58: () => String((walletShim as any).publicKey) }
                : (walletShim as any).publicKey)
            : null,
          sendTransaction: walletShim?.sendTransaction,
          signTransaction: walletShim?.signTransaction,
        };

        const res = await createVaultForSet(adapter, setId, mintA, mintB, [mintA, mintB].filter(Boolean) as any);
        if (!res || !res.vault) {
          alert("Vault creation returned no vault address.");
          return;
        }

        // Heal mapping immediately (idempotent). This guarantees we never "lose" the vault association on refresh.
        try {
          await fetch("/api/vaults/record", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ setId, vault: res.vault, admin: owner }),
          });
        } catch {}
      } finally {
        setLoading(false);
      }
    }

    // Starting requires funds present in the vault.
    if (vaultA.ui === 0 && vaultB.ui === 0) {
      alert(`please deposit ${nameB || "Token B"} into your wallet`);
      return;
    }

    try {
      setLoading(true);
      // One more cheap "ensure initialized" pass right before marking running.
      // This is NO-OP if already initialized; will prompt a tx if a PDA exists but isn't initialized.
      try {
        const adapter: any = {
          publicKey: walletShim?.publicKey
            ? (typeof (walletShim as any).publicKey === "string"
                ? { toBase58: () => String((walletShim as any).publicKey) }
                : (walletShim as any).publicKey)
            : null,
          sendTransaction: walletShim?.sendTransaction,
          signTransaction: walletShim?.signTransaction,
        };
        const res = await createVaultForSet(adapter, setId, mintA, mintB, [mintA, mintB].filter(Boolean) as any);
        if (res?.vault) {
          try {
            await fetch("/api/vaults/record", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ setId, vault: res.vault, admin: owner }),
            });
          } catch {}
        }
      } catch {}

      const ok = await tryRpcControl("start");
      if (ok) setStatus("running");
    } finally {
      setLoading(false);
    }
  }
  async function onStopNow() {
    try {
      setLoading(true);
      const ok = await tryRpcControl("stop");
      if (ok) setStatus("stopped");
    } finally {
      setLoading(false);
    }
  }

  
  function onStopClick() {
    if (loading) return;
    if (status !== "running") return;

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

  async function onWithdrawAllAB() {
    const preA = { ui: vaultA?.ui ?? 0, dec: vaultA?.dec ?? 0 };
    const preB = { ui: vaultB?.ui ?? 0, dec: vaultB?.dec ?? 0 };

    const owner = toB58(walletShim?.publicKey);
    if (!owner) return alert("Connect wallet first.");
    if (!vaultExists) return alert("Create the vault first.");
    try {
      setLoading(true);
      const wa = (typeof window !== "undefined") ? (window as any) : undefined;

      let walletLike: any = null;
      if ((walletShim as any)?.signTransaction || (walletShim as any)?.sendTransaction) {
        walletLike = {
          publicKey: walletShim?.publicKey,
          ...(walletShim as any).sendTransaction ? { sendTransaction: (walletShim as any).sendTransaction } : {},
          ...(walletShim as any).signTransaction ? { signTransaction: (walletShim as any).signTransaction } : {},
        };
      } else if (wa?.solana?.publicKey) {
        walletLike = {
          publicKey: wa.solana.publicKey,
          sendTransaction: wa.solana.sendTransaction,
          signTransaction: wa.solana.signTransaction,
        };
      }
      
      // Jupiter desktop: wrap sendTransaction to gracefully fallback to signTransaction when NOT IMPLEMENTED YET
      if (walletLike && typeof walletLike.sendTransaction === "function") {
        const _origSend = walletLike.sendTransaction;
        const _sign = (walletLike as any).signTransaction;
        walletLike.sendTransaction = (tx: any, conn: any, opts?: any) =>
          _mmSendWithJupiterFallback(_origSend, _sign, tx, conn, opts);
      }
if (!walletLike) throw new Error("wallet unavailable");

      const tasks: Promise<void>[] = [];

      if (preA.ui > 0) {
        const pA = withdrawFromVaultServerFirst(walletLike, setId, tokenA.mint, "")
          .then(({ sig }) => _mmLogEventAppend(setId, "WITHDRAW", tokenA.mint, owner, tokenA?.symbol, vaultA?.dec ?? preA.dec, Number(preA.ui), sig))
          .catch(() => {})
          .finally(() => {
            try { window?.dispatchEvent(new CustomEvent("mm:vault-updated", { detail: { setId } })); } catch {}
            queueRefreshBalances(0); queueRefreshBalances(250); queueRefreshBalances(500);
          });
        tasks.push(pA);
      }

      if (preB.ui > 0) {
        const pB = withdrawFromVaultServerFirst(walletLike, setId, tokenB.mint, "")
          .then(({ sig }) => _mmLogEventAppend(setId, "WITHDRAW", tokenB.mint, owner, tokenB?.symbol, vaultB?.dec ?? preB.dec, Number(preB.ui), sig))
          .catch(() => {})
          .finally(() => {
            try { window?.dispatchEvent(new CustomEvent("mm:vault-updated", { detail: { setId } })); } catch {}
            queueRefreshBalances(0); queueRefreshBalances(250); queueRefreshBalances(500);
          });
        tasks.push(pB);
      }

      // NOTE: Do not optimistically zero balances before wallet approval.
      // We only reflect real on-chain balances via refreshBalances() after success/cancel.

      await Promise.all(tasks);

      try { invalidateTokenBalanceCache(); } catch {}

      // Post-withdraw refresh cadence:
      // - Fast nudge to show updated balances soon
      // - A couple follow-ups to catch finalization on congested slots
      try { queueRefreshBalances(800); } catch {}
      try { queueRefreshBalances(3500); } catch {}
      try { queueRefreshBalances(8000); } catch {}

      // WSOL unwrap is handled on-chain during withdraw-all (vault program closes the user's WSOL ATA when safe).
      return;
    } catch (e: any) {
      console.error("[VaultInlinePanel] onWithdrawAllAB error", e);
      alert((e?.message || e).toString());
    } finally {
      setLoading(false);
    }
  }

  
  
  async function onDepositB() {
    const owner =
      toB58(walletShim?.publicKey) ||
      (typeof window !== "undefined" && (window as any)?.solana?.publicKey?.toBase58?.()) ||
      null;
    if (!owner) return alert("Connect wallet first.");
    if (!vaultExists) return alert("Create the vault first.");
    const amt = Number(depB || 0);
    if (!(amt > 0)) return alert("Enter amount > 0");

    try {
      setLoading(true);
      const wa = (typeof window !== "undefined") ? (window as any)?.solana : undefined;

      let sig: string | null = null;

      if (tokenB.mint === SOL_MINT) {
        // Native SOL path — wrap only once and avoid triggering a second (fallback) transaction.
        try {
          const conn = ensureConnection();
          const pidStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID;
          const vStr = vaultAddress;
          if (!pidStr || !vStr) throw new Error("Missing vault program or address");
          const [auth] = deriveVaultAuthorityPda(new PublicKey(pidStr), new PublicKey(vStr));
          const mintPk = new PublicKey(SOL_MINT);
          const authAta = getAssociatedTokenAddressSync(mintPk, auth, true);
          const lamports = Math.round(amt * LAMPORTS_PER_SOL);
          if (!(lamports > 0)) throw new Error("invalid_lamports");

          const tx = new Transaction();
          // Idempotent create to avoid 'already in use' race on first deposit
          tx.add(createAssociatedTokenAccountIdempotentInstruction(new PublicKey(owner), authAta, auth, mintPk));
          tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: authAta, lamports }));
          tx.add(createSyncNativeInstruction(authAta));

          if (walletShim?.sendTransaction) {
            sig = await _mmSendWithJupiterFallback((walletShim as any)?.sendTransaction, (walletShim as any)?.signTransaction, tx, conn, { skipPreflight: false });
          } else if (wa && typeof wa.sendTransaction === "function" && wa.publicKey) {
            sig = await _mmSendWithJupiterFallback(wa?.sendTransaction, wa?.signTransaction, tx, conn, { skipPreflight: false });
          } else if (walletShim?.signTransaction) {
            const signed = await walletShim.signTransaction(tx);
            sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
          } else if (wa && typeof wa.signTransaction === "function" && wa.publicKey) {
            const signed = await wa.signTransaction(tx);
            sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
          } else {
            return alert("This wallet cannot send transactions here.");
          }
          if (sig) {
            try { void conn.confirmTransaction(sig, "confirmed").catch(() => {}); } catch {}
          }
        } catch (e) {
          console.error("[VaultInlinePanel] SOL deposit failed", e);
          throw e; // Do not fallback to SPL — avoids second phantom 'Simulation failed' prompt
        }
      } else {
        // Generic SPL deposit path (non-SOL)
        const mintPk = new PublicKey(tokenB.mint);

        const adapterFromShim =
          walletShim?.sendTransaction && walletShim?.publicKey
            ? { publicKey: walletShim.publicKey, sendTransaction: walletShim.sendTransaction }
            : null;

        const adapterFromWindow =
          wa && typeof wa.sendTransaction === "function" && wa.publicKey
            ? { publicKey: wa.publicKey, sendTransaction: wa.sendTransaction }
            : null;

        if (adapterFromShim) {
          try {
            try {
            sig = await depositToVaultWithSend(adapterFromShim as any, setId, mintPk, amt);
          } catch (e: any) {
            const msg = (e && (e.message || String(e))) || "";
            if ((walletShim as any)?.signTransaction && typeof msg === "string" && msg.toUpperCase().includes("NOT IMPLEMENTED YET")) {
              const fake: any = { publicKey: (walletShim as any).publicKey, signTransaction: (walletShim as any).signTransaction, signAllTransactions: async (txs: any[]) => txs };
              sig = await depositToVault(ensureConnection(), fake, setId, mintPk, amt);
            } else {
              throw e;
            }
          }
          } catch (e:any) {
            const msg = (e && (e.message || String(e))) || "";
            if ((walletShim as any)?.signTransaction && typeof msg === "string" && msg.toUpperCase().includes("NOT IMPLEMENTED YET")) {
              const fake: any = { publicKey: (walletShim as any).publicKey, signTransaction: (walletShim as any).signTransaction, signAllTransactions: async (txs: any[]) => txs };
              sig = await depositToVault(ensureConnection(), fake, setId, mintPk, amt);
            } else {
              throw e;
            }
          }
        } else if (adapterFromWindow) {
          try {
            try {
            sig = await depositToVaultWithSend(adapterFromWindow as any, setId, mintPk, amt);
          } catch (e: any) {
            const msg = (e && (e.message || String(e))) || "";
            if (wa && typeof wa.signTransaction === "function" && wa.publicKey && typeof msg === "string" && msg.toUpperCase().includes("NOT IMPLEMENTED YET")) {
              const fake: any = { publicKey: wa.publicKey, signTransaction: wa.signTransaction, signAllTransactions: async (txs: any[]) => txs };
              sig = await depositToVault(ensureConnection(), fake, setId, mintPk, amt);
            } else {
              throw e;
            }
          }
          } catch (e:any) {
            const msg = (e && (e.message || String(e))) || "";
            if (wa && typeof wa.signTransaction === "function" && typeof msg === "string" && msg.toUpperCase().includes("NOT IMPLEMENTED YET")) {
              const fake: any = { publicKey: wa.publicKey, signTransaction: wa.signTransaction, signAllTransactions: async (txs: any[]) => txs };
              sig = await depositToVault(ensureConnection(), fake, setId, mintPk, amt);
            } else {
              throw e;
            }
          }
        } else if (wa && typeof wa.signTransaction === "function" && wa.publicKey) {
          const fake: any = {
            publicKey: wa.publicKey,
            signTransaction: wa.signTransaction,
            signAllTransactions: async (txs: any[]) => txs,
          };
          sig = await depositToVault(ensureConnection(), fake, setId, mintPk, amt);
        } else if (walletShim?.signTransaction) {
          const fake: any = {
            publicKey: walletShim.publicKey,
            signTransaction: walletShim.signTransaction,
            signAllTransactions: async (txs: any[]) => txs,
          };
          sig = await depositToVault(ensureConnection(), fake, setId, mintPk, amt);
        } else {
          return alert("This wallet cannot send transactions here.");
        }
        try {
          if (sig) void _mmSoftConfirm(ensureConnection(), sig, 6000);
        } catch {}
      }

      // Optimistic UI update (snappy mobile): show balances immediately after a successful send.
      // This does NOT change on-chain behavior; follow-up refreshes still reconcile truth.
      try {
        const amtUiN = Number(amt);
        if (Number.isFinite(amtUiN) && amtUiN > 0) {
          setUserB((v: any) => ({ ui: Math.max(0, Number(v?.ui ?? 0) - amtUiN), dec: (v?.dec ?? vaultB?.dec ?? 0) }));
          setVaultB((v: any) => ({ ui: Math.max(0, Number(v?.ui ?? 0) + amtUiN), dec: (v?.dec ?? vaultB?.dec ?? 0) }));
        }
      } catch {}

      try {
        const amtUi = Number(amt);
        await _mmLogEventAppend(setId, "DEPOSIT", mintB, owner, tokenB?.symbol, vaultB?.dec, amtUi, sig || null);
      } catch {}

      setDepB("");
      try { invalidateTokenBalanceCache(); } catch {}
      // trailing refresh is scheduled below; avoid redundant timers on mobile
      try {
        window?.dispatchEvent(new CustomEvent("mm:vault-updated", { detail: { setId } }));
      } catch {}

      // Refresh now + a couple follow-ups to reconcile finality without creating a refresh storm (Android WebView-safe)
      try { queueRefreshBalances(0); } catch {}
      try { queueRefreshBalances(1200); } catch {}
      try { queueRefreshBalances(3500); } catch {}
      try { queueRefreshBalances(8000); } catch {}

    } catch (e: any) {
      // schedule retries in case of slow finality
      queueRefreshBalances(500);
      queueRefreshBalances(1000);
      queueRefreshBalances(2000);
      console.error("[VaultInlinePanel] onDepositB error", e);
      alert((e?.message || e).toString());
    } finally {
      setLoading(false);
    }
  }


  return (
    <div ref={rootRef} className="rounded-xl border border-white/10 bg-[#1D1D1D] p-4">
      
      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${status === "running" && vaultExists ? "bg-brandMint" : "bg-rose-500"}`}
          ></span>
          <span className="text-white/80">{statusText}</span>
        </div>
        {vaultExists ? (
          <div className="flex items-center gap-2">

            {canWithdrawAll && (
              <Button variant="dangerSoft" onClick={onWithdrawAllAB} disabled={loading}>
                Withdraw All
              </Button>
            )}

            {status === "running" && __mmIsAppDashboard && vaultExists && (
              <Button
                variant="secondary"
                onClick={onManualSwapClick}
                disabled={loading || __mmManualSwapping}
                title="Manual swap (confirm 3x) — swaps Token B→A if B balance exists, else A→B."
              >
                {__mmManualSwapping
                  ? "Swapping..."
                  : (__mmManualDoneAt
                    ? "Manual Swap ✓"
                    : (__mmManualClicks > 0
                      ? `Manual Swap (${__mmManualClicks}/3)`
                      : "Manual Swap"))}
              </Button>
            )}

            {status === "running" ? (
              <Button variant="warning" onClick={onStopClick} disabled={loading} className="bg-none bg-[#FD1B77]/20 hover:bg-[#FD1B77]/30 text-[#FD1B77] hover:text-[#FD1B77] shadow-none hover:shadow-none">{__mmStopClicks > 0 ? `Stop (${__mmStopClicks}/3)` : "Stop"}</Button>
            ) : (
              <Button variant="success" onClick={onStart} disabled={loading}>
                Start
              </Button>
            )}
          
          </div>
        ) : null}
      </div>
      {!vaultExists ? (
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={onStart} disabled={loading}>
            Create Vault
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-sm">
            <div className="rounded-lg border bg-black p-2.5 sm:p-3 overflow-hidden">
              <div className="mb-1 text-[10px] sm:text-xs tracking-wide bg-clip-text text-transparent bg-gradient-to-r from-brandPink/90 via-brandPurple/90 to-brandMint/90">Wallet</div>
              <div className="flex items-center gap-1">
                <TokenBadge mint={mintA} label={nameA || (mintA ? mintA.slice(0, 6) : "")} prefLogo={(tokenA as any)?.logoURI || (tokenA as any)?.logoUri || undefined} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <BalanceNumber value={userA.ui} decimalsHint={userA.dec} />
                </div>
                <div className="text-[11px] sm:text-xs text-muted-foreground text-right shrink-0 min-w-[72px] sm:min-w-[88px] ml-1">
                  {_mmUsdNode(walletAUsd, balancesReady, showLoadingPlaceholders)}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <TokenBadge mint={mintB} label={nameB || (mintB ? mintB.slice(0, 6) : "")} prefLogo={(tokenB as any)?.logoURI || (tokenB as any)?.logoUri || undefined} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <BalanceNumber value={userB.ui} decimalsHint={userB.dec} />
                </div>
                <div className="text-[11px] sm:text-xs text-muted-foreground text-right shrink-0 min-w-[72px] sm:min-w-[88px] ml-1">
                  {_mmUsdNode(walletBUsd, balancesReady, showLoadingPlaceholders)}
                </div>
              </div>

              <div className="mt-1 text-right text-[11px] text-white/60">
                Total ≈ <span className="font-medium">{_mmUsdNode(walletUsdTotal, balancesReady, showLoadingPlaceholders)}</span>
              </div>
            </div>
            <div className="rounded-lg border bg-black p-2.5 sm:p-3 overflow-hidden">
              <div className="mb-1 text-[10px] sm:text-xs tracking-wide bg-clip-text text-transparent bg-gradient-to-r from-brandPink/90 via-brandPurple/90 to-brandMint/90">Vault</div>
              <div className="flex items-center gap-1">
                <TokenBadge mint={mintA} label={nameA || (mintA ? mintA.slice(0, 6) : "")} prefLogo={(tokenA as any)?.logoURI || (tokenA as any)?.logoUri || undefined} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <BalanceNumber value={vaultA.ui} decimalsHint={vaultA.dec} />
                </div>
                <div className="text-[11px] sm:text-xs text-muted-foreground text-right shrink-0 min-w-[72px] sm:min-w-[88px] ml-1">
                  {_mmUsdNode(vaultAUsd, balancesReady, showLoadingPlaceholders)}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <TokenBadge mint={mintB} label={nameB || (mintB ? mintB.slice(0, 6) : "")} prefLogo={(tokenB as any)?.logoURI || (tokenB as any)?.logoUri || undefined} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <BalanceNumber value={vaultB.ui} decimalsHint={vaultB.dec} />
                </div>
                <div className="text-[11px] sm:text-xs text-muted-foreground text-right shrink-0 min-w-[72px] sm:min-w-[88px] ml-1">
                  {_mmUsdNode(vaultBUsd, balancesReady, showLoadingPlaceholders)}
                </div>
              </div>

              <div className="mt-1 text-right text-[11px] text-white/60">
                Total ≈ <span className="font-medium">{_mmUsdNode(vaultUsdTotal, balancesReady, showLoadingPlaceholders)}</span>
              </div>
            </div>
          </div>

          {status !== "running" && (
            <div className="mt-3 sm:mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
              <div className="sm:col-start-2">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <div className="flex items-center gap-2 w-full">
                    <button
                      type="button"
                      onClick={onMaxDepositB}
                      className="rounded-full border border-brandPurple/20 bg-brandPurple/15 px-2 py-0.5 text-[10px] font-medium hover:border-brandPurple/30 transition-colors"
                    >
                      Max
                    </button>
                    <input
                      className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
                      placeholder={`Amount ${nameB || (mintB ? mintB.slice(0, 6) : "")}`}
                      value={depB}
                      onChange={(e) => setDepB(e.target.value)}
                      inputMode="decimal"
                      pattern="[0-9]*[.]?[0-9]*"
                    />
                  </div>
                  <Button
                    variant="primary"
                    className="w-full sm:w-auto"
                    onClick={onDepositB}
                    disabled={loading}
                  >
                    Deposit {nameB || (mintB ? mintB.slice(0, 6) : "")}
                  </Button>
                </div>

                <div className="mt-1 text-xs text-white/60 text-left sm:text-right">
                  {Number.isFinite(Number(depB)) && Number(depB) >= 0 && priceB
                    ? <>≈ {formatUsd(Number(depB) * (priceB ?? NaN))} at live {(nameB || (mintB ? mintB.slice(0, 6) : "token"))} price</>
                    : <>Enter a {(nameB || (mintB ? mintB.slice(0, 6) : "token"))} amount to see ≈ USD</>}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
