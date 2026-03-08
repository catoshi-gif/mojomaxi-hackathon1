// filepath: src/app/app/page.tsx
'use client';
// ---- Low-end device heuristics (no UI changes) ----
if (typeof window !== "undefined" && !(window as any).__mmLowEndInit) {
  (window as any).__mmLowEndInit = true;
  try {
    const ua = navigator.userAgent || "";
    const isOldIOS = /iP(hone|od|ad)/.test(ua) && /OS (1[0-2])_/.test(ua); // iOS 10–12
    const lowMem = (navigator as any).deviceMemory && Number((navigator as any).deviceMemory) <= 2;
    const lowCPU = (navigator as any).hardwareConcurrency && Number((navigator as any).hardwareConcurrency) <= 2;
    const saveData = (navigator as any).connection && (navigator as any).connection.saveData === true;
    (window as any).__mmLowEnd = Boolean(isOldIOS || lowMem || lowCPU || saveData);
  } catch { (window as any).__mmLowEnd = false; }
}


// ---- Wallet-session deferral for this page (avoid modal clash) ----
if (typeof window !== "undefined") {
  try { (window as any).__mmDeferWalletSession = true; } catch {}
}
// ---- AbortError silence for background cancels ----
if (typeof window !== "undefined" && !(window as any).__mmAbortGuardInstalled) {
  (window as any).__mmAbortGuardInstalled = true;
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r: any = (e && (e as any).reason) || null;
    if (r && (r.name === "AbortError" || r.code === 20 || String(r).includes("AbortError"))) {
      e.preventDefault();
    }
  });
}

import { getVisibleMints } from '@/app/_lib/tokenRegistry';

/**
 * src/app/app/page.tsx — Unified Bot Hub (webhooks + rebalance + strategies)
 *
 * SACRED RULES RESPECTED
 * - No existing functionality removed.
 * - UI/UX preserved except the specific Pro-gated tweaks already requested:
 *   • Rebalance helper: Up to 20 tokens for Pro (vs 6) and adds "1h" cadence. Token 1 is locked to SOL only for NEW set creation; legacy sets remain unchanged.
 *   • Non‑Pro remains unchanged: Token 1 locked to SOL during creation, max 6 tokens, cadence 2/6/12/24h.
 * - Wallet addresses are *never* lowercased.
 * - Uses Jupiter Lite; no changes in swap logic.
 */

// ----------------------- MM FETCH GATE (1×/minute) -----------------------
// Install after mount to preserve composition order with AbortGuard/template.
function installMmFetchGate() {
  if (typeof window === "undefined") return;
  if ((window as any).__mmFetchGateInstalled) return;
  (window as any).__mmFetchGateInstalled = true;

  const down = window.fetch.bind(window);
  const _cache = new Map<string, { t: number; body: string; status: number; headers: [string, string][] }>();
  const _inflight = new Map<string, Promise<Response>>();

  // Prevent unbounded growth during long sessions / heavy traffic.
  // This is a tiny in-memory cache for a handful of high-churn endpoints.
  const MAX_CACHE_ENTRIES = 300;
  const MAX_INFLIGHT_ENTRIES = 80;

  function pruneOldest<K, V>(m: Map<K, V>, max: number) {
    try {
      while (m.size > max) {
        const first = m.keys().next();
        if (!first || first.done) break;
        m.delete(first.value);
      }
    } catch {}
  }

  function maybePrune(now: number) {
    // occasional pruning only (cheap)
    try {
      // About once every ~2 seconds at most per tab, based on time bucketing.
      const bucket = Math.floor(now / 2000);
      const w: any = window as any;
      if (w.__mmFetchGatePruneBucket === bucket) return;
      w.__mmFetchGatePruneBucket = bucket;
      pruneOldest(_cache, MAX_CACHE_ENTRIES);
      pruneOldest(_inflight, MAX_INFLIGHT_ENTRIES);
    } catch {}
  }

  function _normKey(input: RequestInfo | URL, init?: RequestInit): string | null {
    try {
      const url = typeof input === "string"
        ? new URL(input, window.location.origin)
        : input instanceof URL
          ? input
          : new URL((input as Request).url, window.location.origin);
      const path = url.pathname;
      if (path.startsWith("/api/tokens/search")) {
        const q = (url.searchParams.get("q") || "").toLowerCase();
        const meth = (init?.method || "GET").toUpperCase();
        if (meth !== "GET") return null;
        // coalesce identical in-flight searches; tiny TTL applied below
        return `${path}?q=${q}`;
      }
      if (!/^\/api\/(prices|tokens|tokens\/meta)/.test(path)) return null;
      const ids = (url.searchParams.get("mints") || url.searchParams.get("ids") || url.searchParams.get("id") || "")
        .split(/[\,\s]+/).map((s) => s.trim()).filter(Boolean).sort().join(",");
      // If the request didn't specify any mints/ids, don't gate/cache it.
      if (!ids) return null;
      const mode = url.searchParams.get("mode") || "";
      const meth = (init?.method || "GET").toUpperCase();
      if (meth !== "GET") return null;
      return `${path}?mints=${ids}&mode=${mode}`;
    } catch {
      return null;
    }
  }

  window.fetch = (input: any, init?: RequestInit): Promise<Response> => {
    const key = _normKey(input, init);
    if (!key) return down(input, init);

    const now = Date.now();
    const TTL = key.includes('/api/tokens/search?') ? 350 : key.includes('/api/prices') ? 15_000 : 60_000;

    maybePrune(now);

    // Serve hot cache if fresh.
    const hit = _cache.get(key);
    if (hit && now - hit.t >= TTL) {
      _cache.delete(key);
    }
    if (hit && now - hit.t < TTL) {
      return Promise.resolve(new Response(hit.body, { status: hit.status, headers: new Headers(hit.headers) }));
    }

    // If an identical request is in-flight, attach and synthesize a *fresh* Response
    // for each consumer to avoid "body stream already used" errors.
    if (_inflight.has(key)) {
      return _inflight.get(key)!.then(({ body, status, headers }: any) => {
        return new Response(body, { status, headers: new Headers(headers) });
      });
    }

    // Kick off the network and capture raw payload once.
    const pData: Promise<{ t: number; body: string; status: number; headers: [string, string][] }> =
      down(input, init).then(async (r) => {
        const body = await r.clone().text();
        const headers: [string, string][] = [];
        r.headers.forEach((v, k) => headers.push([k, v]));
        const rec = { t: Date.now(), body, status: r.status, headers };
        _cache.set(key, rec); // prime cache immediately
        try { maybePrune(rec.t); } catch {}
        return rec;
      }).finally(() => {
        _inflight.delete(key);
      });

    _inflight.set(key, pData as any);

    // Return a *new* Response per consumer.
    return pData.then(({ body, status, headers }) => new Response(body, { status, headers: new Headers(headers) }));
  };
}
// --------------------- END MM FETCH GATE (1×/minute) ---------------------

/**
 * Install lightweight RPC cache/coalecing for common web3.js calls
 * (no UI changes; reduces duplicate RPC traffic across panels).
 * This is a noop on server and only patches once on client.
 */
import "@/lib/rpc-cache";
import { initWalletSession } from "@/lib/auth/initWalletSession";

import * as React from "react";
import dynamic from "next/dynamic";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import DisclaimerModal from "@/components/DisclaimerModal";
import HumanCheckGate from "@/components/security/HumanCheckGate";
const MetricsPanel = dynamic(() => import("../webhooks/_components/MetricsPanel"), { ssr: false });
const ActivityPanel = dynamic(() => import("../webhooks/_components/ActivityPanel"), { ssr: false });
const VaultInlinePanel = dynamic(() => import("../webhooks/_components/VaultInlinePanel"), { ssr: false });
const RebalanceInlinePanel = dynamic(() => import("../rebalance/_components/RebalanceInlinePanel"), { ssr: false });
import TokenPicker from "../webhooks/_components/TokenPicker";
import { Button } from "@/components/ui/button";
import CreateBotModal from "@/components/CreateBotModal";
import { createVaultForSet } from "@/lib/mm-vault-create";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ensureConnection, deriveVaultAuthorityPda } from "@/lib/vault-sdk";
import { cachedGetTokenAccountBalance, cachedGetAccountInfoOwner, cachedGetMint } from "@/lib/rpc-cache";
import { getMwaWalletEntry, getWalletAdapterName, installMwaDebugHooks, isAndroidChromeOrPwaStandalone, isNamedMwaWallet, mwaLog, resetMwaDebugState } from "@/lib/mwa-debug";


// -------------------------------
// Mojo Pro detector (client only)
// -------------------------------
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
type MojoProStatus = { active: boolean; expiresAt: number; creditedUsd?: number; totalPaidUsd?: number } | null;
function useIsMojoPro(): boolean {
  const { publicKey, signMessage, sendTransaction, signTransaction, connected, connecting, wallet: selectedWallet, connect, select, wallets } = useWallet();
  // Wallet connect should be strictly user-initiated:
  // - No auto-prompt on page load
  // - If user clicks "connect wallet" and selects a wallet in the modal, follow up with connect()
  const pendingUserConnectRef = React.useRef(false);
  const pendingTimeoutRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!pendingUserConnectRef.current) return;
    if (connected || connecting) return;
    if (!selectedWallet) return;
// IMPORTANT (Android Chrome / PWA + MWA):
// Calling connect() from an effect (outside the original user gesture) can be blocked by Chromium
// when it tries to launch the external wallet intent. Users can tap the Connect button again
// after selecting a wallet to initiate connect within a trusted gesture.
if (isAndroidChromeOrPwaStandalone()) return;

    pendingUserConnectRef.current = false;
    if (pendingTimeoutRef.current) {
      window.clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }

    (async () => {
      try {
        await connect();
      } catch(e) {
      if ((e as any)?.name === "AbortError") {
        // Ignore aborted loads (a newer load superseded this one).
        return;
      }
        // eslint-disable-next-line no-console
        console.error("[/app] connect error:", e);
      }
    })();
  }, [selectedWallet, connected, connecting, connect]);

  const markPendingUserConnect = React.useCallback(() => {
    pendingUserConnectRef.current = true;
    if (pendingTimeoutRef.current) window.clearTimeout(pendingTimeoutRef.current);
    pendingTimeoutRef.current = window.setTimeout(() => {
      pendingUserConnectRef.current = false;
      pendingTimeoutRef.current = null;
    }, 30_000);
  }, []);

  // On this page, defer the automatic wallet-session handshake until the user clicks "create bot"
  React.useEffect(() => {
    try {
      (window as any).__mmDeferWalletSession = true;
      return () => { try { delete (window as any).__mmDeferWalletSession; } catch {} };
    } catch {}
  }, []);


  const keyFromAdapter = (publicKey as any)?.toBase58?.() || (publicKey as any)?.toString?.() || "";
  const wallet = React.useMemo(() => keyFromAdapter || tryInjectedWallet(), [keyFromAdapter]);
  const [isActive, setIsActive] = React.useState<boolean>(false);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!wallet) { if (!cancelled) setIsActive(false); return; }
      try {
        const r = await fetch(`/api/subs/mojo-pro-sol/status?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" });
        const j = await r.json();
        if (!cancelled) setIsActive(!!j?.status?.active);
      } catch {
        if (!cancelled) setIsActive(false);
      }
    })();
    return () => { cancelled = true; };
  }, [wallet]);
  return isActive;
}

// -------------------------------
// Types
// -------------------------------
type AnyObj = Record<string, any>;

type WebhookSet = {
  setId: string;
  wallet: string;
  label?: string;
  prefs?: { mintIn?: string; mintOut?: string; tokenA?: string; tokenB?: string; tokenIn?: string; tokenOut?: string };
  buyId?: string;
  sellId?: string;
  urls?: { buy?: string; sell?: string };
  createdAt?: number;
  createdOn?: string;
};

type Cadence = "1h" | "2h" | "6h" | "12h" | "24h";

type RebalanceSet = {
  id: string;
  wallet: string;
  mints: string[];
  cadence: Cadence | null;
  createdAt?: number;
  vaultId?: string | null;
  frozen?: boolean;
};
type AggregatedRow =
  | { kind: "webhook"; id: string; createdAt: number; data: WebhookSet }
  | { kind: "rebalance"; id: string; createdAt: number; data: RebalanceSet };

// -------------------------------
// Constants & pure helpers
// -------------------------------
const MINT_SOL  = "So11111111111111111111111111111111111111112";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_LOGO_DATA_URI = "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='12' fill='#2775CA'/><circle cx='32' cy='32' r='18' fill='none' stroke='white' stroke-width='4'/><text x='32' y='39' text-anchor='middle' font-family='system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' font-size='20' fill='white'>$</text></svg>`);

function fallbackLogoUri(mint?: string): string | undefined {
  const k = String(mint || "").trim();
  if (!k) return undefined;
  if (k === MINT_SOL)  return "/brand/solana-64.png";
  if (k === MINT_USDC) return USDC_LOGO_DATA_URI;
  return undefined;
}

function tsFromCreated(row: any): number {
  const ra = row?.createdAt;
  const ro = row?.createdOn;
  const tA = typeof ra === "number" ? ra : (typeof ra === "string" ? Date.parse(ra) : 0);
  if (Number.isFinite(tA) && tA > 0) return tA;
  const tO = typeof ro === "string" ? Date.parse(ro) : 0;
  return Number.isFinite(tO) ? tO : 0;
}

function fmtCreated(n?: number) {
  if (!n) return "—";
  try { return new Date(n).toLocaleString(); } catch { return "—"; }
}

function formatWalletDisplay(addr?: string | null): string {
  const s = String(addr || "").trim();
  if (!s) return "";
  // Solana base58 is case-sensitive. We only uppercase for *display* privacy in UI.
  if (s.length <= 10) return s.toUpperCase();
  return `${s.slice(0, 4).toUpperCase()}…${s.slice(-4).toUpperCase()}`;
}

function pickMint(v?: any, k?: "mintIn" | "mintOut"): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const read = (obj: any): string | undefined => {
    if (!obj || typeof obj !== "object") return undefined;
    // direct exact key
    if (typeof obj[k || "mintIn"] === "string") return obj[k || "mintIn"];
    // modern explicit
    if (k === "mintIn" && typeof obj.mintA === "string") return obj.mintA;
    if (k === "mintOut" && typeof obj.mintB === "string") return obj.mintB;
    // early-webhook
    if (k === "mintIn") {
      if (typeof obj.buyOutputMint === "string") return obj.buyOutputMint;
      if (typeof obj.sellInputMint === "string") return obj.sellInputMint;
    } else if (k === "mintOut") {
      if (typeof obj.sellOutputMint === "string") return obj.sellOutputMint;
    }
    // legacy aliases
    if (k === "mintIn") {
      if (typeof obj.tokenA === "string") return obj.tokenA;
      if (typeof obj.tokenIn === "string") return obj.tokenIn;
    } else if (k === "mintOut") {
      if (typeof obj.tokenB === "string") return obj.tokenB;
      if (typeof obj.tokenOut === "string") return obj.tokenOut;
    }
    // nested tokenA/tokenB shapes with { mint }
    try {
      if (k === "mintIn") {
        if (obj.tokenA && typeof obj.tokenA.mint === "string") return obj.tokenA.mint;
        if (obj.a && typeof obj.a.mint === "string") return obj.a.mint;
      } else if (k === "mintOut") {
        if (obj.tokenB && typeof obj.tokenB.mint === "string") return obj.tokenB.mint;
        if (obj.b && typeof obj.b.mint === "string") return obj.b.mint;
      }
    } catch {}
    return undefined;
  };
  // Try as prefs-like first, then as full set-like
  return read(v) ?? (typeof (v as any).prefs === "object" ? read((v as any).prefs) : undefined);
}

function cadenceShort(c: Cadence): string {
  return String(c || "").replace(/h$/, "hrs") as string;
}

type TokMap = Record<string, { symbol?: string; name?: string; logoURI?: string; verified?: boolean }>;

function symIsValid(x: any): x is string {
  return typeof x === "string" && x.trim().length > 0 && x !== "UNKNOWN" && x !== "?";
}

function tokenSymbolFromMap(mint?: string | null, fallback?: string, tokMap?: TokMap): string {
  const k = String(mint || "").trim();
  if (!k) return fallback || "";
  const hit = tokMap && tokMap[k];
  const sym = hit?.symbol;
  if (symIsValid(sym)) return sym as string;
  if (k === MINT_USDC) return "USDC";
  if (k === MINT_SOL)  return "SOL";
  return fallback || (k.length > 10 ? `${k.slice(0,4)}…${k.slice(-4)}` : k);
}

function tokenDisplaySymbol(mint: string, tokMap: TokMap): string {
  const k = String(mint || "").trim();
  if (!k) return "";
  const hit = tokMap[k];
  const sym = hit?.symbol;
  if (symIsValid(sym)) return sym as string;
  if (k === MINT_SOL) return "SOL";
  if (k === MINT_USDC) return "USDC";
  if (hit?.name && String(hit.name).trim().length > 0) return String(hit.name);
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function uniqueMints(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of list || []) {
    const k = String(m || "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function lastSegment(u?: string | null): string {
  const s = String(u || "").trim();
  if (!s) return "";
  const p = s.split("?")[0].replace(/\/+$/, "");
  const parts = p.split("/");
  return parts[parts.length - 1] || "";
}

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const plat = (navigator as any).platform || "";
  const iOS = /iP(ad|hone|od)/.test(ua) || /iP(ad|hone|od)/.test(plat);
  const iPadOnMac = /Mac/.test(plat) && (navigator as any).maxTouchPoints > 1;
  return iOS || iPadOnMac;
}

function isJupiterInAppIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  if (!isIOSDevice()) return false;
  const ua = navigator.userAgent || "";
  // Heuristic: Jupiter Mobile iOS in-app browser tends to include Jupiter/Jup markers.
  // Keep this narrow to avoid changing Phantom/Solflare behavior.
  if (/\bJupiter\b/i.test(ua)) return true;
  if (/\bJup\b/i.test(ua) && /Mobile\//i.test(ua)) return true;
  return false;
}


function isIOSInAppWebView(): boolean {
  if (typeof navigator === "undefined") return false;
  if (!isIOSDevice()) return false;
  const ua = navigator.userAgent || "";
  // Heuristic: iOS in-app WKWebView typically omits the "Safari" token.
  // This is intentionally conservative to avoid affecting normal Safari.
  const isMobile = /Mobile\//i.test(ua);
  const hasWebKit = /AppleWebKit\//i.test(ua);
  const hasSafari = /Safari\//i.test(ua);
  return Boolean(isMobile && hasWebKit && !hasSafari);
}

function originFromWindow(): string {
  if (typeof window !== "undefined" && window?.location?.origin) return window.location.origin;
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/,"") || "https://www.mojomaxi.com";
}

function rebalanceTitle(s: RebalanceSet, tokMap: TokMap): string {
  // Show ALL selected tokens (Pro: up to 20); keep gradient wrapper in render
  const mints = Array.isArray(s.mints) && s.mints.length ? s.mints : [MINT_SOL, MINT_USDC];
  const parts = mints.map((m) => tokenDisplaySymbol(m, tokMap));
  const cad = (s.cadence || "6h") as Cadence; // unify default to 6h
  return `Rebalance: ${parts.join(", ")} every ${cadenceShort(cad)}`;
}

function isPlaceholderWebhookLabel(lbl?: string | null): boolean {
  const raw = String(lbl || "").trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  // Labels produced before symbol resolution often contain generic placeholders
  if (/\bbase\b|\bquote\b/.test(lower)) return true;
  // Extremely truncated addresses imply fallback label
  if (/[.…]/.test(raw) && /[A-HJ-NP-Za-km-z1-9]{5,}/.test(raw)) return true;
  return false;
}

function GradientTitle(props: { kind: "webhook" | "rebalance"; defaultTitle: string; label?: string | null }) {
  // NOTE: Name preserved to avoid touching call sites. Visual-only change:
  // - No gradients
  // - Prefix ("Webhooks:" / "Rebalance:") is pure white
  // - Token symbols are brand pink (#FD1B77)
  // - All other words (e.g., "every 1HR") remain pure white

  const prefix = props.kind === "webhook" ? "Webhooks:" : "Rebalance:";

  // Prefer dynamic default title if label looks like a placeholder
  const chosen = isPlaceholderWebhookLabel(props.label) ? props.defaultTitle : String(props.label || props.defaultTitle);
  const raw = String(chosen || "");

  // Strip any existing leading "webhooks:" / "rebalance:" (case-insensitive) from the chosen string
  const rest = raw.replace(/^\s*(webhooks|rebalance)\s*:\s*/i, "").trimStart();

  // Tokenize: highlight ALL-CAPS-ish symbols (2+ chars) while leaving normal words white.
  // Exclude common non-token words that are also uppercase sometimes.
  const STOPWORDS = new Set(["EVERY", "HOUR", "HOURS", "HR", "HRS", "TO", "IN", "OUT"]);
  const parts = rest.split(/(\b[A-Za-z0-9]{2,}\b|,)/g);

  return (
    <span className="inline-block">
      <span className="text-white">{prefix}</span>{" "}
      {parts.map((p, i) => {
        const key = `${i}-${p}`;
        const up = String(p || "").toUpperCase();
        const low = String(p || "").toLowerCase();

        const isComma = p === ",";
        const isActionWord = props.kind === "webhook" && (low === "buy" || low === "sell" || low === "for");
        const isWord = /^[A-Za-z0-9]{2,}$/.test(p);
        // Treat mixed-case symbols (e.g., mSOL, JitoSOL, Bonk) as tokens too.
        // Keep normal lowercase words (e.g., "every") white.
        const isAllLower = /^[a-z0-9]{2,}$/.test(p) && /[a-z]/.test(p) && !/[A-Z]/.test(p);
        const isToken = isWord && !STOPWORDS.has(up) && !isAllLower;

        const isPink = isComma || isActionWord || isToken;

        return (
          <span key={key} className={isPink ? "text-[#FD1B77]" : "text-white"}>
            {p}
          </span>
        );
      })}
    </span>
  );
}

// -------------------------------
// Component
// -------------------------------

export default function AppHubPage() {

  // iOS Safari/WebView viewport units can "shrink" after the first paint when the address bar animates,
  // which can make the lower part of the page appear black/truncated. We keep a stable pixel min-height
  // via a CSS variable updated on resize/orientationchange (no functional behavior changes).
  const __mmIsIOS = useMemo((): boolean => {
    try { return isIOSDevice(); } catch { return false; }
  }, []);

  // Jupiter iOS in-app browser can be more fragile (older WebKit, stricter memory, buggy fetch overrides).
  // We treat it as "low-end" for scheduling/concurrency and we avoid monkeypatching fetch in that environment.
  const __mmIsJupIOS = useMemo((): boolean => {
    try { return isJupiterInAppIOS(); } catch { return false; }
  }, [__mmIsIOS]);


  // Generic iOS in-app WKWebView (Solflare/Jupiter/Phantom/etc) can black-tile under GPU memory pressure.
  // We detect it conservatively (no "Safari" token) and apply render-safety mitigations ONLY there.
  const __mmIsIOSInApp = useMemo((): boolean => {
    try { return __mmIsIOS && isIOSInAppWebView(); } catch { return false; }
  }, [__mmIsIOS]);

  // Low-end detection flag from global bootstrap (set in module prelude)
  // Memoized so we don't re-run try/catch + window access on every rerender.
  const __mmLowEnd = useMemo((): boolean => {
    try { return Boolean((window as any).__mmLowEnd) || __mmIsJupIOS || __mmIsIOSInApp; } catch { return __mmIsJupIOS; }
  }, [__mmIsJupIOS, __mmIsIOSInApp]);



  // Ensure MM fetch gate installs after AbortGuard (from template).
  React.useEffect(() => {
    if (__mmIsJupIOS || __mmIsIOSInApp) return;
    try { (installMmFetchGate as any)?.(); } catch {}
  }, [__mmIsJupIOS, __mmIsIOSInApp]);


  // iOS in-app WebViews (wallet browsers) can "black tile" while scrolling when GPU memory is tight,
  // especially with lots of blur/shadow/drop-shadow layers. To keep the UI usable on older devices,
  // we disable the most expensive compositor effects ONLY in iOS in-app webviews. (Visual-only.)
  React.useEffect(() => {
    if (!__mmIsIOSInApp) return;
    let styleEl: HTMLStyleElement | null = null;
    try {
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-mm-ios-webview-lite", "1");
      styleEl.textContent = `
        /* iOS in-app webview compositor safety (visual-only) */
        .backdrop-blur, [class*="backdrop-blur"] { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
        [class*="shadow-"], .shadow, .shadow-sm, .shadow-md, .shadow-lg, .shadow-xl, .shadow-2xl { box-shadow: none !important; }
        [class*="drop-shadow"], .drop-shadow, .drop-shadow-sm, .drop-shadow-md, .drop-shadow-lg, .drop-shadow-xl, .drop-shadow-2xl { filter: none !important; }
      `;
      document.head.appendChild(styleEl);
    } catch {}
    return () => {
      try { styleEl?.remove(); } catch {}
    };
  }, [__mmIsIOSInApp]);


  // Force a truly flat black page background (kills any inherited tiled background on mobile/connected states).
  React.useEffect(() => {
    try {
      const de = document.documentElement;
      const b = document.body;
      de.style.backgroundColor = "#000000";
      de.style.backgroundImage = "none";
      b.style.backgroundColor = "#000000";
      b.style.backgroundImage = "none";
      // Avoid iOS "rubber-band" showing non-black behind the page
      b.style.margin = "0";
    } catch {}
  }, []);

  React.useEffect(() => {
    if (!__mmIsIOS) return;
    const setVh = () => {
      try {
        const h = window.innerHeight;
        document.documentElement.style.setProperty("--mm-vh", `${h}px`);
      } catch {}
    };
    setVh();
    window.addEventListener("resize", setVh);
    window.addEventListener("orientationchange", setVh);
    return () => {
      window.removeEventListener("resize", setVh);
      window.removeEventListener("orientationchange", setVh);
    };
  }, [__mmIsIOS]);

  const { publicKey, signMessage, sendTransaction, signTransaction, connected, connecting, wallet: selectedWallet, connect, select, wallets } = useWallet();
  // Stable wallet base58: Android in-app wallets can briefly flicker publicKey null during tx approval.
  // Keep last-known base58 so panels don't unmount/remount (flash) and refreshes don't stall.
  const stableWalletBase58Ref = useRef<string>("");
  useEffect(() => {
    try {
      const b58 = (publicKey as any)?.toBase58?.() || (publicKey as any)?.toString?.();
      if (typeof b58 === "string" && b58.length > 0) stableWalletBase58Ref.current = b58;
    } catch {}
  }, [publicKey]);


  const wallet = useMemo(() => {
    try {
      const b58 = (publicKey as any)?.toBase58?.() || (publicKey as any)?.toString?.();
      if (typeof b58 === "string" && b58.length > 0) return b58;
    } catch {}
    return stableWalletBase58Ref.current || "";
  }, [publicKey]);
  const walletDisplay = useMemo(() => formatWalletDisplay(wallet), [wallet]);


// -------------------------------
// Panel wallet shim selection (Android Jupiter dapp browser stability)
// - On some Android in-app dapp browsers, the Wallet Adapter sendTransaction path can trigger
//   a WebView-level refresh after approval.
// - Prefer the in-app injected provider when present (window.solana / phantom / solflare),
//   and keep the last-known good shim so panels never lose their signer mid-flow.
// -------------------------------
const panelWalletShimRef = useRef<any>(null);
const panelWalletShim = useMemo(() => {
  try {
    if (typeof window !== "undefined") {
      const ua = navigator.userAgent || "";
      const uaL = ua.toLowerCase();
      const isJupiter = /jupiter/i.test(ua);
      const isAndroid = /android/.test(uaL);

      if (isJupiter && isAndroid) {
        const w: any = window as any;
        const injected =
          w?.solana ||
          w?.phantom?.solana ||
          w?.backpack?.solana ||
          w?.solflare?.solana ||
          w?.solflare;

        if (injected?.publicKey && (typeof injected?.sendTransaction === "function" || typeof injected?.signTransaction === "function")) {
          const shim = {
            publicKey: injected.publicKey,
            sendTransaction: typeof injected.sendTransaction === "function" ? injected.sendTransaction.bind(injected) : undefined,
            signTransaction: typeof injected.signTransaction === "function" ? injected.signTransaction.bind(injected) : undefined,
          };
          return shim;
        }
      }
    }
  } catch {}

  // Default: wallet-adapter methods.
  return { publicKey, sendTransaction, signTransaction };
}, [publicKey, sendTransaction, signTransaction]);

useEffect(() => {
  try {
    const pk = (panelWalletShim as any)?.publicKey;
    const hasPk = !!(pk && ((pk as any).toBase58 || (pk as any).toString));
    const hasFn = typeof (panelWalletShim as any)?.sendTransaction === "function" || typeof (panelWalletShim as any)?.signTransaction === "function";
    if (hasPk && hasFn) panelWalletShimRef.current = panelWalletShim;
  } catch {}
}, [panelWalletShim]);

const panelWalletShimStable = useMemo(() => {
  return panelWalletShimRef.current || panelWalletShim;
}, [panelWalletShim]);


  // -------------------------------
  // Page visibility/focus tracking
  // - Prevents background auto-connect prompts (tab hidden)
  // - Forces MetricsPanel to remount on resume so set-buckets reliably rehydrate
  // -------------------------------
  const [mmPageActive, setMmPageActive] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    return document.visibilityState === "visible" && !document.hidden;
  });
  const [metricsPanelKey, setMetricsPanelKey] = useState<number>(0);
  const mmWasActiveRef = useRef<boolean>(true);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const computeActive = () => {
      const active = document.visibilityState === "visible" && !document.hidden;

      const prevActive = mmWasActiveRef.current;
      if (active !== prevActive) {
        // Only update state when it actually changes (reduces pointless rerenders on focus/blur spam).
        setMmPageActive(active);

        // Only bump on transitions inactive -> active
        if (active && !prevActive) {
          setMetricsPanelKey((k) => k + 1);
        }

        mmWasActiveRef.current = active;
      }
    };

    // Seed immediately on mount/hydration
    computeActive();

    document.addEventListener("visibilitychange", computeActive);
    window.addEventListener("focus", computeActive);
    window.addEventListener("blur", computeActive);
    window.addEventListener("pageshow", computeActive);

    return () => {
      document.removeEventListener("visibilitychange", computeActive);
      window.removeEventListener("focus", computeActive);
      window.removeEventListener("blur", computeActive);
      window.removeEventListener("pageshow", computeActive);
    };
  }, []);




  // Wallet connect should be strictly user-initiated on this page:
  // - No auto-prompt on page load
  // - If user clicks "connect wallet" and selects a wallet in the modal, follow up with connect()
  const pendingUserConnectRef = React.useRef(false);
  const pendingTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!pendingUserConnectRef.current) return;
    if (connected || connecting) return;
    if (!selectedWallet) return;

    if (isAndroidChromeOrPwaStandalone()) {
      mwaLog("app_page_skip_effect_connect_android", {
        selectedWallet: String((selectedWallet as any)?.adapter?.name || ""),
      });
      return;
    }

    pendingUserConnectRef.current = false;
    if (pendingTimeoutRef.current) {
      window.clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }

    (async () => {
      try {
        await connect();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[/app] connect error:", e);
      }
    })();
  }, [selectedWallet, connected, connecting, connect]);

  const markPendingUserConnect = React.useCallback(() => {
    pendingUserConnectRef.current = true;
    if (pendingTimeoutRef.current) window.clearTimeout(pendingTimeoutRef.current);
    pendingTimeoutRef.current = window.setTimeout(() => {
      pendingUserConnectRef.current = false;
      pendingTimeoutRef.current = null;
    }, 30_000);
  }, []);


  // Soft auto-connect for returning users when a wallet-session is known to be active.
  // We can't read the httpOnly mm_wallet_session cookie directly, so initWalletSession()
  // also drops a non-sensitive localStorage hint (mm_wallet_session_hint) once a session
  // is confirmed for a wallet. On the /app page only, if that hint exists, we attempt a
  // one-shot auto-connect using the last selected wallet adapter.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (connected || connecting) return;

    if (isAndroidChromeOrPwaStandalone()) {
      mwaLog("app_page_skip_auto_connect_android", {
        selectedWallet: String((selectedWallet as any)?.adapter?.name || ""),
      });
      return;
    }

    if (!mmPageActive) return;

    let hasSessionHint = false;
    try {
      const w: any = window as any;
      const ls = w.localStorage as Storage | undefined;
      const hint = ls?.getItem("mm_wallet_session_hint") || "";
      hasSessionHint = typeof hint === "string" && hint.trim().length > 0;
    } catch {
      hasSessionHint = false;
    }
    if (!hasSessionHint) return;

    if (!selectedWallet) return;

    (async () => {
      try {
        await connect();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[/app] auto-connect error:", e);
      }
    })();
  }, [connected, connecting, selectedWallet, connect, mmPageActive]);

const ensureWalletSession = React.useCallback(async () => {
  try {
    if (publicKey) {
      const addr = publicKey.toBase58();
      const canMsg = typeof signMessage === "function";
      const canTx = typeof signTransaction === "function";

      let forcedTx = false;
      try {
        forcedTx =
          canTx &&
          typeof window !== "undefined" &&
          !!(window as any).localStorage &&
          String((window as any).localStorage.getItem(`mm_wallet_session_force_tx:${addr}`) || "") === "1";
      } catch {
        forcedTx = false;
      }

      const preferTx = (forcedTx || (!canMsg && canTx)) && canTx;

      if (preferTx) {
        await initWalletSession({
          wallet: addr,
          signTransaction,
          preferTx: true,
        });
      } else if (canMsg) {
        await initWalletSession({
          wallet: addr,
          signMessage: (msg: Uint8Array) => signMessage!(msg),
          signTransaction,
        });
      }
    }
  } catch {}
}, [publicKey, signMessage, signTransaction]);
  // Pro gating (client)
  const isPro = useIsMojoPro();
  const MAX_TOKENS: number = isPro ? 20 : 6;
  const cadenceOptions: ReadonlyArray<Cadence> = (isPro
    ? (["1h","2h","6h","12h","24h"] as const)
    : (["2h","6h","12h","24h"] as const)
  );

  // Token-1 (rebalance) locking policy:
  // - Non‑Pro: always locked to SOL during creation.
  // - Pro: ONLY lock Token 1 to SOL for NEW sets created after initial load (pre-vault).
  //         Legacy sets keep their existing Token 1 selection.
  const rebalanceLegacyIdsRef = React.useRef<Set<string>>(new Set());
  const rebalanceLegacyInitRef = React.useRef(false);
  const rebalanceLegacyWalletRef = React.useRef<string>("");

  React.useEffect(() => {
    // Reset legacy snapshot when wallet changes
    if (rebalanceLegacyWalletRef.current !== wallet) {
      rebalanceLegacyWalletRef.current = wallet;
      rebalanceLegacyIdsRef.current = new Set();
      rebalanceLegacyInitRef.current = false;
    }
  }, [wallet]);

  const lockToken1ToSOLForSet = React.useCallback(
    (setId: string, hasVault: boolean) => {
      if (hasVault) return false;
      if (!isPro) return true;
      // Pro: lock only for NEW sets (not present in initial snapshot)
      return !rebalanceLegacyIdsRef.current.has(setId);
    },
    [isPro]
  );


  // -------------------------------
  // Ultra-light page-level cleanup sweep (symbols + USD)
  // -------------------------------
  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const sweepAbort = new AbortController();
    const sweepSignal = sweepAbort.signal;

    function acquireLock(ttlMs: number): boolean {
      try {
        const w: any = window as any;
        const now = Date.now();
        const until = Number(w.mmRebalanceSymbolSweepLock || 0);
        if (Number.isFinite(until) && now < until) return false;
        w.mmRebalanceSymbolSweepLock = now + Math.max(3000, ttlMs);
        return true;
      } catch { return true; }
    }

    function knownSymbol(mint: string): string | null {
      try {
        const w: any = window as any;
        const s = (w.mmSymbolCache || {})[mint];
        if (s) return String(s);
      } catch {}
      try {
        const boot = (window as any).__mmBootstrap?.tokens?.items || [];
        for (const it of (Array.isArray(boot) ? boot : [])) {
          const m = String((it?.mint || it?.address) || '').trim();
          if (m === mint) {
            const sym = String(it?.symbol || it?.name || '');
            if (sym) return sym;
          }
        }
      } catch {}
      try {
        const raw = window.localStorage.getItem('mm_boot_tokens_v1');
        if (raw) {
          const arr: any[] = JSON.parse(raw);
          for (const it of (Array.isArray(arr) ? arr : [])) {
            const m = String((it?.mint || it?.address) || '').trim();
            if (m === mint) {
              const sym = String(it?.symbol || it?.name || '');
              if (sym) return sym;
            }
          }
        }
      } catch {}
      return null;
    }

    function knownPrice(mint: string): number | null {
      try {
        const w: any = window as any;
        const p = Number((w.mmPriceCache || {})[mint]);
        if (Number.isFinite(p)) return p;
      } catch {}
      return null;
    }

    async function fetchSymbols(mints: string[], lowEnd: boolean): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      if (!mints || mints.length === 0) return out;
      try {
        const CHUNK = lowEnd ? 40 : 120;
        for (let i = 0; i < mints.length; i += CHUNK) {
          const group = mints.slice(i, i + CHUNK);
          try {
            const u = new URL('/api/tokens/meta', window.location.origin);
            u.searchParams.set('mints', group.join(','));
            const r = await fetch(u.toString(), { cache: 'no-store', signal: sweepSignal } as any);
            if (r.ok) {
              const j: any = await r.json().catch(() => ({}));
              const items: any[] = Array.isArray(j?.items) ? j.items : [];
              for (const it of items) {
                const mint = String((it?.mint || it?.address) || '').trim();
                const sym  = String(it?.symbol || it?.name || '').trim();
                if (mint && sym) out[mint] = sym.toUpperCase();
              }
            }
          } catch {}
          // Yield to the browser between chunks to keep main thread responsive
          await new Promise(res => setTimeout(res, 0));
        }
      } catch {}
      return out;
    }
    async function fetchPrices(mints: string[], lowEnd: boolean): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      if (!mints || mints.length === 0) return out;
      try {
        const CHUNK = lowEnd ? 40 : 120;
        for (let i = 0; i < mints.length; i += CHUNK) {
          const group = mints.slice(i, i + CHUNK);
          try {
            const u = new URL('/api/prices', window.location.origin);
            u.searchParams.set('mints', group.join(','));
            const r = await fetch(u.toString(), { cache: 'no-store', signal: sweepSignal } as any);
            if (r.ok) {
              const j: any = await r.json().catch(() => ({}));
              const map: Record<string, number> = (j?.data || j?.prices || {}) || {};
              for (const [k, v] of Object.entries(map)) {
                const n = Number(v);
                if (Number.isFinite(n)) out[k] = n;
              }
            }
          } catch {}
          await new Promise(res => setTimeout(res, 0));
        }
      } catch {}
      return out;
    }
    function commitSymbols(map: Record<string, string>) {
      if (!map || !Object.keys(map).length) return;
      try {
        const w: any = window as any;

        // Merge in-place to avoid large object churn (Android WebView is especially sensitive).
        const cache: Record<string, string> = (w.mmSymbolCache && typeof w.mmSymbolCache === "object") ? w.mmSymbolCache : {};
        for (const [mint, sym] of Object.entries(map)) {
          const k = String(mint || "").trim();
          const v = String(sym || "").trim();
          if (!k || !v) continue;
          cache[k] = v;
        }
        w.mmSymbolCache = cache;

        // notify both Rebalance and any other listeners
        window.dispatchEvent(new CustomEvent('mm:rebalance:symbols', { detail: map }));

        // also seed TokenMetaProvider so downstream components hydrate instantly
        const arr = Object.entries(map).map(([mint, symbol]) => ({ mint, address: mint, symbol }));
        window.dispatchEvent(new CustomEvent('mm:seedTokens', { detail: arr }));

        // Persist for next boot (debounced + incremental to avoid stringify stalls).
        try {
          const now = Date.now();
          const BOOT_KEY = 'mm_boot_tokens_v1';

          // Keep an in-memory map so we don't repeatedly parse/stringify large arrays.
          const bootMap: Record<string, any> = (w.__mmBootTokenMap && typeof w.__mmBootTokenMap === "object") ? w.__mmBootTokenMap : (() => {
            try {
              const raw = window.localStorage.getItem(BOOT_KEY);
              const prev: any[] = raw ? (JSON.parse(raw) || []) : [];
              const m: Record<string, any> = {};
              for (const it of Array.isArray(prev) ? prev : []) {
                const mm = (it?.mint || it?.address);
                if (mm) m[String(mm)] = it;
              }
              return m;
            } catch {
              return {};
            }
          })();

          let changed = false;
          for (const [mint, symbol] of Object.entries(map)) {
            const k = String(mint || "").trim();
            const v = String(symbol || "").trim();
            if (!k || !v) continue;
            const prev = bootMap[k] || { mint: k, address: k };
            if (prev.symbol !== v) {
              bootMap[k] = { ...prev, symbol: v };
              changed = true;
            }
          }

          // Cap persisted size to avoid unbounded growth
          const MAX_BOOT = 800;
          w.__mmBootTokenMap = bootMap;

          if (changed) {
            // Debounce writes; collapse multiple commits into one stringify
            if (w.__mmBootTokenSaveTimer) clearTimeout(w.__mmBootTokenSaveTimer);
            w.__mmBootTokenSaveTimer = setTimeout(() => {
              try {
                const vals = Object.values(w.__mmBootTokenMap || {});
                const trimmed = vals.length > MAX_BOOT ? vals.slice(0, MAX_BOOT) : vals;
                window.localStorage.setItem(BOOT_KEY, JSON.stringify(trimmed));
                window.localStorage.setItem('mm_boot_tokens_ts', String(now));
              } catch {}
            }, 750);
          }
        } catch {}
      } catch {}
    }

    function commitPrices(map: Record<string, number>) {
      if (!map || !Object.keys(map).length) return;
      try {
        const w: any = window as any;

        // Merge in-place to avoid large object churn.
        const cache: Record<string, number> = (w.mmPriceCache && typeof w.mmPriceCache === "object") ? w.mmPriceCache : {};
        for (const [mint, px] of Object.entries(map)) {
          const k = String(mint || "").trim();
          const n = Number(px);
          if (!k || !Number.isFinite(n)) continue;
          cache[k] = n;
        }
        w.mmPriceCache = cache;

        window.dispatchEvent(new CustomEvent('mm:rebalance:prices', { detail: map }));
      } catch {}
    }

    async function sweepOnce() {
      if (document?.hidden) return; // skip work in background tabs
      if (!acquireLock(5000)) return;

      const w: any = window as any;
      const lowEnd = __mmLowEnd;
      const visible = Array.from(new Set((getVisibleMints() || []).filter(Boolean)));
      let target = lowEnd ? visible.slice(0, 64) : visible; // clamp on low-end devices

      // If nothing is visible yet, consider bootstrap-known mints — but skip this on low-end devices.
      if (!target.length && !lowEnd) {
        const mintSet = new Set<string>();
        try {
          const boot = (w && w.__mmBootstrap?.tokens?.items) || [];
          for (const it of (Array.isArray(boot) ? boot : [])) {
            const m = String((it?.mint || it?.address) || "").trim();
            if (m) mintSet.add(m);
          }
        } catch {}
        try {
          const raw = window.localStorage.getItem('mm_boot_tokens_v1');
          if (raw) {
            const arr = JSON.parse(raw) || [];
            for (const it of (Array.isArray(arr) ? arr : [])) {
              const m = String((it?.mint || it?.address) || "").trim();
              if (m) mintSet.add(m);
            }
          }
        } catch {}
        target = Array.from(mintSet).slice(0, 200); // safety clamp
      }
      if (!target.length) return;

      const missingSym: string[] = [];
      const missingPx: string[]  = [];

      for (const m of target) {
        if (!knownSymbol(m)) missingSym.push(m);
        if (!Number.isFinite(knownPrice(m) as any)) missingPx.push(m);
      }

      // Dedup + low-end clamps
      let uniqSym = Array.from(new Set(missingSym));
      let uniqPx  = Array.from(new Set(missingPx));
      if (lowEnd) { uniqSym = uniqSym.slice(0, 64); uniqPx = uniqPx.slice(0, 64); }

      const doWork = async () => {
        try {
          const [syms, px] = await Promise.all([
            fetchSymbols(uniqSym, lowEnd),
            fetchPrices(uniqPx, lowEnd),
          ]);
          commitSymbols(syms);
          commitPrices(px);
        } catch { /* swallow */ }
      };

      const ric: any = (window as any).requestIdleCallback;
      if (!isIOSDevice() && typeof ric === 'function') {
        ric(() => { doWork().catch(() => {}); }, { timeout: 1500 });
      } else {
        // iOS/WebKit or no RIC: run promptly to avoid idle starvation
        setTimeout(() => { doWork().catch(() => {}); }, 0);
      }
    }

    let sweepRuns = 0;
    const sweepInterval = setInterval(() => {
      sweepRuns += 1;
      sweepOnce().catch(() => {});
      if (sweepRuns >= 3) {
        clearInterval(sweepInterval);
      }
    }, 5000);
    const onVis = () => { if (!document.hidden) { sweepOnce().catch(() => {}); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { sweepAbort.abort(); clearInterval(sweepInterval); document.removeEventListener('visibilitychange', onVis); };
  }, []);


  // Cloudflare Turnstile human verification
  const [humanOK, setHumanOK] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const raw = localStorage.getItem("mm_turnstile_ok_ts");
      const until = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(until) && Date.now() < until;
    } catch {
      return false;
    }
  });
// Android Chrome / installed PWA + Mobile Wallet Adapter:
// Do NOT auto-run wallet-session signing right after connect.
// Chrome only allows one external-app navigation per trusted user gesture; if we auto-sign
// in an effect, the Mobile Wallet Adapter intent can be blocked ("popup blocked"/no-op).
// Instead, we sign on the next explicit user action (e.g. Create / Deposit / Withdraw).
const __mmIsAndroidChromePwa = React.useMemo(() => {
  try {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const uaL = ua.toLowerCase();
    const isAndroid = uaL.includes("android");
    if (!isAndroid) return false;
    const isWebView = uaL.includes("; wv)") || (uaL.includes("version/") && uaL.includes("chrome") && uaL.includes("wv"));
    const isJupiter = /jupiter/i.test(ua);
    if (isWebView || isJupiter) return false;
    const isChromeLike = uaL.includes("chrome/") && !uaL.includes("edg/") && !uaL.includes("opr/");
    const isStandalone =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      (window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches ||
        window.matchMedia("(display-mode: minimal-ui)").matches);
    return Boolean(isChromeLike || isStandalone);
  } catch {
    return false;
  }
}, []);

const __mmIsMwaSelected = React.useMemo(() => {
  try {
    const n = String((selectedWallet as any)?.adapter?.name || "").toLowerCase();
    return n.includes("mobile wallet adapter");
  } catch {
    return false;
  }
}, [selectedWallet]);

React.useEffect(() => {
    if (!humanOK) return;
    if (!publicKey) return;

    // Critical for Seeker/Android Chrome/PWA: prevent non-gesture wallet navigations.
    if (__mmIsAndroidChromePwa && __mmIsMwaSelected) return;

    void ensureWalletSession();
  }, [humanOK, publicKey, ensureWalletSession, __mmIsAndroidChromePwa, __mmIsMwaSelected]);

  const [walletSessionReadyNonce, setWalletSessionReadyNonce] = useState(0);
  const { setVisible } = useWalletModal?.() || ({} as any);
  const [mwaConnectStatus, setMwaConnectStatus] = useState<string>("");
  const [mwaConnectBusy, setMwaConnectBusy] = useState(false);
  const mwaSoftTimerRef = useRef<number | null>(null);
  const mwaHardTimerRef = useRef<number | null>(null);

  React.useEffect(() => {
    installMwaDebugHooks();
  }, []);

  React.useEffect(() => {
    return () => {
      try {
        if (mwaSoftTimerRef.current) window.clearTimeout(mwaSoftTimerRef.current);
        if (mwaHardTimerRef.current) window.clearTimeout(mwaHardTimerRef.current);
      } catch {}
    };
  }, []);

  const [openCreate, setOpenCreate] = useState(false);
  const [createLimit, setCreateLimit] = useState<{ limit: number; remaining: number; resetAt?: number } | null>(null);

  const [webhookSets, setWebhookSets] = useState<WebhookSet[]>([]);
  const [rebalanceSets, setRebalanceSets] = useState<RebalanceSet[]>([]);

  // Stable rebalance vault IDs: Android wallets can briefly flicker derived vaultMap entries during tx approval/refresh.

  const [loading, setLoading] = useState(false);

  const [vaultMap, setVaultMap] = useState<Record<string, string | null>>({});
  const [deletableMap, setDeletableMap] = useState<Record<string, boolean>>({});

  // Keep last-known vaultId per set so the Rebalance panel never swaps to the "Create Vault" placeholder (prevents flash).
  const stableRebalanceVaultIdRef = useRef<Record<string, string>>({});
  useEffect(() => {
    try {
      const out = stableRebalanceVaultIdRef.current || (stableRebalanceVaultIdRef.current = {});
      for (const s of (rebalanceSets as any) || []) {
        const id = String((s as any)?.id || "").trim();
        if (!id) continue;
        const v = String((vaultMap as any)?.[id] || (s as any)?.vaultId || "").trim();
        if (v) out[id] = v;
      }
    } catch {}
  }, [vaultMap, rebalanceSets]);

  // Keep latest maps in refs so effects can read them without re-triggering.
  const vaultMapRef = useRef<Record<string, string | null>>({});
  const deletableMapRef = useRef<Record<string, boolean>>({});
  const prewarmAbortRef = useRef<AbortController | null>(null);
  const lastPrewarmKeyRef = useRef<string>("");
  useEffect(() => { vaultMapRef.current = vaultMap; }, [vaultMap]);
  useEffect(() => { deletableMapRef.current = deletableMap; }, [deletableMap]);
  const [topTokens, setTopTokens] = useState<any[]>([]);

  const [showWebhooksMap, setShowWebhooksMap] = useState<Record<string, boolean>>({});

  const [copyStatus, setCopyStatus] = useState<{ setId: string; side: "buy" | "sell" } | null>(null);

  const [dexSymbolMap, setDexSymbolMap] = useState<Record<string, string>>({});
  const dexSymbolMapRef = useRef<Record<string, string>>({});
  const dexMintLastRunRef = useRef<Record<string, number>>({});
  const dexRetryAtRef = useRef<Record<string, number>>({});
  const dexFailCountRef = useRef<Record<string, number>>({});
  const DEX_PER_MINT_TTL_MS   = 24 * 60 * 60 * 1000;
  const META_PER_MINT_TTL_MS   = 24 * 60 * 60 * 1000;
  const metaMintLastRunRef = useRef<Record<string, number>>({});

  // Error diagnostics (very small red text under Create Vault buttons)
  const [webhookCreateErr, setWebhookCreateErr] = useState<Record<string, string>>({});
  const [rebalanceCreateErr, setRebalanceCreateErr] = useState<Record<string, string>>({});
  // Rebalance save locks (disable +/− and cadence while saving)
  const [rebalanceSaving, setRebalanceSaving] = useState<Record<string, { mints: number; cadence: number }>>({});
  React.useEffect(() => {
    if (!wallet) return;
    // Snapshot the sets that existed when the page finished its initial load.
    // This ensures we DO NOT force SOL into already-created (legacy) Pro bots.
    if (!rebalanceLegacyInitRef.current && !loading) {
      rebalanceLegacyIdsRef.current = new Set(rebalanceSets.map((s) => s.id));
      rebalanceLegacyInitRef.current = true;
    }
  }, [wallet, loading, rebalanceSets]);


  // NEW: adopt externally seeded symbols directly into local state so UI reflects sweep results.
  useEffect(() => {
    const w: any = window as any;
    if (!w.__mmPendingSymbols) w.__mmPendingSymbols = {};
    const pending: Record<string, string> = w.__mmPendingSymbols;

    const flush = () => {
      try {
        w.__mmSymbolsFlushReq = null;
        const patch = w.__mmPendingSymbols || {};
        w.__mmPendingSymbols = {};
        const keys = Object.keys(patch);
        if (!keys.length) return;

        setDexSymbolMap((prev) => {
          // Avoid allocating/merging if nothing actually changes
          let changed = false;
          for (const k of keys) {
            if (String(prev[k] || '') !== String(patch[k] || '')) { changed = true; break; }
          }
          if (!changed) return prev;
          return { ...prev, ...patch };
        });
      } catch {}
    };

    const scheduleFlush = () => {
      try {
        if (w.__mmSymbolsFlushReq) return;
        const raf = w.requestAnimationFrame?.bind(w);
        if (typeof raf === 'function') {
          w.__mmSymbolsFlushReq = raf(flush);
        } else {
          w.__mmSymbolsFlushReq = setTimeout(flush, 0);
        }
      } catch {
        setTimeout(flush, 0);
      }
    };

    const onSymbols = (e: any) => {
      try {
        const map = (e?.detail && typeof e.detail === 'object') ? e.detail : {};
        if (!map || !Object.keys(map).length) return;
        for (const [mint, sym] of Object.entries(map)) {
          const k = String(mint || '').trim();
          const v = String(sym || '').trim();
          if (!k || !v) continue;
          pending[k] = v;
        }
        scheduleFlush();
      } catch {}
    };

    window.addEventListener('mm:rebalance:symbols', onSymbols as any);
    return () => {
      try { window.removeEventListener('mm:rebalance:symbols', onSymbols as any); } catch {}
    };
  }, []);
  // Keep a ref of latest dexSymbolMap so background resolvers don't restart on each setState.
  useEffect(() => { dexSymbolMapRef.current = dexSymbolMap; }, [dexSymbolMap]);


  const tokMap = React.useMemo<TokMap>(() => {
    const out: TokMap = {};
    for (const t of topTokens || []) {
      try {
        const k = String((t?.address || t?.mint || "").trim());
        if (!k) continue;
        const sym = String(t?.symbol || "").trim();
        const nm  = String(t?.name   || "").trim();
        const logo = String(((t as any)?.logoURI || (t as any)?.logoUri || "")).trim();
        const ver  = typeof (t as any)?.verified === "boolean" ? (t as any).verified : undefined;
        out[k] = { symbol: sym || undefined, name: nm || undefined, logoURI: logo || undefined, verified: ver };
      } catch {}
    }
    for (const [mint, sym] of Object.entries(dexSymbolMap)) {
      const k = String(mint || "").trim();
      const prev = out[k] || {};
      const prevSym = (prev as any).symbol;
      out[k] = { ...prev, symbol: symIsValid(prevSym) ? prevSym : sym };
    }
    return out;
  }, [topTokens, dexSymbolMap]);

  type PickerToken = { address: string; mint?: string; symbol: string; name?: string; logoURI?: string; verified?: boolean };
  type RawToken = { address?: string; mint?: string; symbol?: string; name?: string; logoURI?: string; logoUri?: string; verified?: boolean };

  function dedupeByAddressPicker(list: PickerToken[]): PickerToken[] {
    const bag: Record<string, PickerToken> = {};
    for (const t of list || []) {
      const addr = String((t?.address || t?.mint || "")).trim();
      if (!addr) continue;
      const prev = bag[addr];
      const hasNewLogo = Boolean((t as any)?.logoURI || (t as any)?.logoUri);
      const hasPrevLogo = Boolean((prev as any)?.logoURI || (prev as any)?.logoUri);
      if (!prev || (hasNewLogo && !hasPrevLogo)) {
        bag[addr] = { ...t, address: addr, mint: addr };
      }
    }
    return Object.values(bag);
  }

  function coerceRawToPickerToken(raw: RawToken, fallbacks?: Partial<PickerToken>): PickerToken | null {
    const addr = String(raw?.address || raw?.mint || fallbacks?.address || "").trim();
    if (!addr) return null;
    const symbol = String(raw?.symbol || fallbacks?.symbol || "").trim() || "UNKNOWN";
    const name = raw?.name || fallbacks?.name;
    const logoURI = (raw as any)?.logoURI ?? (raw as any)?.logoUri ?? fallbacks?.logoURI;
    const verified = (raw as any)?.verified ?? (fallbacks as any)?.verified ?? false;
    return { address: addr, mint: addr, symbol, name, logoURI, verified };
  }

  const initialTokens: PickerToken[] = React.useMemo(() => {
    const bag: Record<string, PickerToken> = {};
    for (const t of topTokens || []) {
      const coerced = coerceRawToPickerToken(t as any);
      if (coerced) bag[coerced.address] = coerced;
    }
    for (const [mint, meta] of Object.entries(tokMap || {})) {
      const addr = String(mint || "").trim();
      if (!addr) continue;
      const prev = bag[addr] || { address: addr, mint: addr, symbol: meta.symbol || "UNKNOWN" } as PickerToken;
      bag[addr] = {
        ...prev,
        symbol: (meta.symbol || prev.symbol || "UNKNOWN") as string,
        name: meta.name || prev.name,
        logoURI: (meta as any)?.logoURI || (prev as any)?.logoURI,
        verified: typeof (meta as any)?.verified === "boolean" ? (meta as any).verified : (prev as any)?.verified,
      };
    }
    
    // Ensure currently-selected mints are present even if not in topTokens yet.
    // This prevents the TokenPicker from briefly "defaulting" to a different token
    // before token metadata for the selected mint is hydrated.
    try {
      const wanted = new Set<string>();
      for (const s of (webhookSets || [])) {
        try {
          const a = String(pickMint((s as any)?.prefs, "mintIn") || pickMint(s as any, "mintIn") || "").trim();
          const b = String(pickMint((s as any)?.prefs, "mintOut") || pickMint(s as any, "mintOut") || "").trim();
          if (a) wanted.add(a);
          if (b) wanted.add(b);
        } catch {}
      }
      for (const r of (rebalanceSets || [])) {
        try {
          const arr: any[] = Array.isArray((r as any)?.mints) ? (r as any).mints : [];
          for (const mm of arr) {
            const k = String(mm || "").trim();
            if (k) wanted.add(k);
          }
        } catch {}
      }

      for (const mint of wanted) {
        const k = String(mint || "").trim();
        if (!k) continue;
        if (bag[k]) continue;
        const meta = (tokMap as any)?.[k] || {};
        const sym =
          (typeof meta.symbol === "string" && meta.symbol.trim()) ?
            meta.symbol.trim() :
            tokenSymbolFromMap(k, "", tokMap) || (k.length > 10 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k);
        bag[k] = {
          address: k,
          mint: k,
          symbol: sym,
          name: (typeof meta.name === "string" && meta.name.trim()) ? meta.name : undefined,
          logoURI: (typeof meta.logoURI === "string" && meta.logoURI.trim()) ? meta.logoURI : (fallbackLogoUri(k) || undefined),
          verified: typeof meta.verified === "boolean" ? meta.verified : false,
        } as PickerToken;
      }
    } catch {}
if (!bag[MINT_SOL]) bag[MINT_SOL] = { address: MINT_SOL, mint: MINT_SOL, symbol: "SOL", name: "Solana", logoURI: "/brand/solana-64.png" } as PickerToken;
    if (!bag[MINT_USDC]) bag[MINT_USDC] = { address: MINT_USDC, mint: MINT_USDC, symbol: "USDC", name: "USD Coin", logoURI: fallbackLogoUri(MINT_USDC) } as PickerToken;
    return dedupeByAddressPicker(Object.values(bag));
  }, [topTokens, tokMap, webhookSets, rebalanceSets]);

  const initialReady = initialTokens.length > 0;

  const fetchDexSymbol = useCallback(async (mint: string, signal?: AbortSignal): Promise<string | null> => {
    const q = encodeURIComponent(mint);

    // Prefer our token registry endpoints (server-side is backed by Jupiter Pro).
    const tryUrls = [
      `/api/tokens/symbol?mint=${q}`,
    ];

    for (const url of tryUrls) {
      try {
        const r = await fetch(url, { cache: "no-store", signal });
        if (!r.ok) continue;
        const j = await r.json().catch(() => ({}));
        const sym =
          (typeof (j as any)?.symbol === "string" && (j as any).symbol) ||
          (typeof (j as any)?.data?.symbol === "string" && (j as any).data.symbol) ||
          (typeof (j as any)?.token?.symbol === "string" && (j as any).token.symbol) ||
          null;
        if (sym && typeof sym === "string" && sym.trim().length > 0) return sym.trim();
      } catch (e) {
        if ((e as any)?.name === "AbortError") return null;
        /* ignore */
      }
    }

    // Search fallback within our own token index (still Jupiter-backed).
    try {
      const r = await fetch(`/api/tokens/search?q=${q}`, { cache: "no-store", signal });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const arr: any[] = Array.isArray((j as any)?.tokens) ? (j as any).tokens : Array.isArray((j as any)?.items) ? (j as any).items : [];
        const hit = arr.find((t) => {
          const id = String((t?.address || t?.mint || '').trim());
          return id.length > 0 && id === String(mint).trim();
        });
        if (hit) {
          const sym = String(hit?.symbol || hit?.name || "").trim();
          if (sym) return sym;
        }
      }
    } catch (e) {
      if ((e as any)?.name === "AbortError") return null;
      /* ignore */
    }

    return null;
  }, []);

  // Resolve symbols for all mints referenced by sets (with iOS-friendly retry/backoff).
  useEffect(() => {
    if (!humanOK) return;
    let alive = true;
    const ac = new AbortController();

    const mints = new Set<string>();
    for (const s of rebalanceSets || []) for (const m of (s.mints || [])) { const k = String(m || "").trim(); if (k) mints.add(k); }
    for (const s of webhookSets || []) {
      const prefs = s?.prefs || {};
      const a = String(pickMint(prefs, "mintIn") || "").trim();
      const b = String(pickMint(prefs, "mintOut") || "").trim();
      if (a) mints.add(a);
      if (b) mints.add(b);
    }

    const run = async () => {
      const curDex = dexSymbolMapRef.current || {};
      const candidates: string[] = [];
      const lastRun = dexMintLastRunRef.current || {};
      const retryAt = dexRetryAtRef.current || {};
      const now = Date.now();

      for (const mint of mints) {
        if (!alive) return;
        if (tokMap[mint]?.symbol && symIsValid(tokMap[mint]?.symbol)) continue;
        if (curDex[mint] && symIsValid(curDex[mint])) continue;

        const last = lastRun[mint] || 0;
        const nextRetry = retryAt[mint] || 0;

        // obey failure backoff
        if (now < nextRetry) continue;

        // if we've had a successful fetch recently, respect the 24h TTL
        if (last && now - last < DEX_PER_MINT_TTL_MS) continue;

        candidates.push(mint);
      }

      if (!candidates.length) return;

      // Concurrency-cap to avoid bursty network / server load on busy pages.
      const limit = __mmLowEnd ? 2 : 5;
      let idx = 0;

      const worker = async () => {
        while (alive) {
          const mint = candidates[idx++];
          if (!mint) return;

          const sym = await fetchDexSymbol(mint, ac.signal);
          if (!alive) return;

          if (sym) {
            setDexSymbolMap((prev) => ({ ...prev, [mint]: sym }));
            dexMintLastRunRef.current[mint] = Date.now();      // successful TTL start
            delete dexRetryAtRef.current[mint];                // clear failure backoff
            delete dexFailCountRef.current[mint];
          } else {
            const prevFails = dexFailCountRef.current[mint] || 0;
            const schedule = [15_000, 60_000, 300_000, 900_000, 3_600_000]; // 15s → 1m → 5m → 15m → 60m
            const wait = schedule[Math.min(prevFails, schedule.length - 1)];
            dexFailCountRef.current[mint] = prevFails + 1;
            dexRetryAtRef.current[mint] = Date.now() + wait;
          }
        }
      };

      const n = Math.min(limit, candidates.length);
      await Promise.all(Array.from({ length: n }, () => worker()));
    };

    // Defer heavy work to idle time where possible; skip when tab is hidden.
    let cancel: null | (() => void) = null;

    const kick = () => { run().catch(() => {}); };

    if (typeof document !== "undefined" && (document as any).hidden) {
      // no-op
    } else if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const id = (window as any).requestIdleCallback(() => { if (alive) kick(); }, { timeout: 1500 });
      cancel = () => { try { (window as any).cancelIdleCallback(id); } catch {} };
    } else {
      const t = setTimeout(() => { if (alive) kick(); }, 0);
      cancel = () => { try { clearTimeout(t); } catch {} };
    }

    return () => {
      alive = false;
      try { ac.abort(); } catch {}
      try { cancel?.(); } catch {}
    };
  }, [humanOK, webhookSets, rebalanceSets, tokMap, fetchDexSymbol, __mmLowEnd]);

  const loadAllAbortRef = useRef<AbortController | null>(null);

  const loadAll = useCallback(async () => {
    if (!wallet) return;

    // Abort any in-flight load to avoid stale work when wallet changes or user refreshes quickly.
    try { loadAllAbortRef.current?.abort(); } catch {}
    const ac = new AbortController();
    loadAllAbortRef.current = ac;

    setLoading(true);
    try {
      const [rA, rB, rD] = await Promise.allSettled([
        fetch(`/api/webhooks/for/${encodeURIComponent(wallet)}?ts=${Date.now()}`, { cache: "no-store", signal: ac.signal }),
        fetch(`/api/rebalance/for/${encodeURIComponent(wallet)}`, { cache: "no-store", signal: ac.signal }),
                fetch(`/api/limits/creates?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store", signal: ac.signal }),
      ]);

      if (rA.status === "fulfilled") {
        const j: AnyObj = await rA.value.json().catch(() => ({}));
        const arr: AnyObj[] = Array.isArray(j?.sets) ? j.sets : [];
        const rows: WebhookSet[] = arr
          .map((s) => ({
            setId: String(s?.setId || s?.id || ""),
            wallet,
            label: typeof s?.label === "string" ? s.label : undefined,
            prefs: (() => {
              const p0: AnyObj = (typeof s?.prefs === "object" && s.prefs) ? (s.prefs as AnyObj) : {};
              // Some legacy docs store selected mints at the top-level (mintA/mintB, tokenA/tokenB, etc.)
              // Normalize into prefs so the TokenPicker reads the persisted selection on page refresh.
              const mi = pickMint(s as any, "mintIn");
              const mo = pickMint(s as any, "mintOut");
              const out: AnyObj = { ...(p0 || {}) };
              // Only fill missing keys (never overwrite explicit prefs)
              if (mi && !pickMint(out as any, "mintIn")) {
                out.mintIn = mi;
                if (typeof out.mintA !== "string") out.mintA = mi;
                if (typeof out.tokenA !== "string") out.tokenA = mi;
                if (typeof out.tokenIn !== "string") out.tokenIn = mi;
              }
              if (mo && !pickMint(out as any, "mintOut")) {
                out.mintOut = mo;
                if (typeof out.mintB !== "string") out.mintB = mo;
                if (typeof out.tokenB !== "string") out.tokenB = mo;
                if (typeof out.tokenOut !== "string") out.tokenOut = mo;
              }
              return out;
            })(),
            buyId: typeof s?.buyId === "string" ? s.buyId : undefined,
            sellId: typeof s?.sellId === "string" ? s.sellId : undefined,
            urls: s?.urls && typeof s.urls === "object" ? { buy: String(s.urls.buy || ""), sell: String(s.urls.sell || "") } : undefined,
            createdAt: tsFromCreated(s),
            createdOn: typeof s?.createdOn === "string" ? s.createdOn : undefined,
          }))
          .filter((s) => !!s.setId);
        {
          const rowsWithOpt = rows.map((row) => ({
            ...row,
            prefs: { ...(row.prefs || {}), ...(optimisticPrefsRef.current[row.setId] || {}) },
          }));
          startTransition(() => {
            setWebhookSets(rowsWithOpt);
          });
        }
      }

      if (rB.status === "fulfilled") {
        const j: AnyObj = await rB.value.json().catch(() => ({}));
        const arr: AnyObj[] = Array.isArray(j?.sets) ? j.sets : [];
        const rows: RebalanceSet[] = arr
          .map((row) => ({
            id: String(row?.id || row?.setId || ""),
            wallet: String(row?.wallet || wallet),
            mints: Array.isArray(row?.mints) ? row.mints.map((m: any) => String(m || "")).filter(Boolean) : [],
            cadence: normalizeCadence(row?.cadence),
            createdAt: tsFromCreated(row),
            vaultId: typeof row?.vaultId === "string" ? row.vaultId : null,
            frozen: !!row?.frozen,
          }))
          .filter((s) => !!s.id);
        startTransition(() => {
          setRebalanceSets(rows);
        });
      }

      if (rD.status === "fulfilled") {
        try {
          const j: AnyObj = await rD.value.json().catch(() => ({}));
          if (j && j.ok !== false && (typeof j.remaining === "number" || typeof j.limit === "number")) {
            setCreateLimit({ limit: Number(j.limit ?? 0), remaining: Number(j.remaining ?? 0), resetAt: j.resetAt ? Number(j.resetAt) : undefined });
          }
        } catch {}
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  // Batch vault id & deletable per set — prioritize vaultId (panel render) before deletable (delete button)
// This reduces perceived load time for webhook vault panels under server load without changing behavior.
useEffect(() => {
  let alive = true;
  const ac = new AbortController();

  // De-dupe set ids and avoid re-fetching fields we already know.
  const idsAll = [
    ...webhookSets.map((s) => s.setId),
    ...rebalanceSets.map((s) => s.id),
  ];
  const uniq: string[] = Array.from(new Set(idsAll.filter(Boolean)));
  if (uniq.length === 0) return;

  const knownVault = vaultMapRef.current || {};
  const knownDel = deletableMapRef.current || {};

  // Some routes already return vaultId inline (e.g., /api/webhooks/for, /api/rebalance/for). Treat those
  // as "known" so we don't fan out per-set vaultId fetches, and so panels can mount immediately.
  const setVaultHints: Record<string, string | null> = {};
  for (const s of (webhookSets as any[]) || []) {
    const id = String((s as any)?.setId || (s as any)?.id || "");
    if (!id) continue;
    if (Object.prototype.hasOwnProperty.call(s as any, "vaultId")) setVaultHints[id] = ((s as any)?.vaultId ?? null) as any;
  }
  for (const s of (rebalanceSets as any[]) || []) {
    const id = String((s as any)?.id || (s as any)?.setId || "");
    if (!id) continue;
    if (Object.prototype.hasOwnProperty.call(s as any, "vaultId")) setVaultHints[id] = ((s as any)?.vaultId ?? null) as any;
  }

  const needVault = uniq.filter((id) => !(id in knownVault) && !(id in setVaultHints));
  const needDel = uniq.filter((id) => !(id in knownDel));

  // Seed vaultMap with any inline vaultId hints (including explicit null) so UI can render without waiting.
  const hintEntries = Object.entries(setVaultHints);
  if (hintEntries.length) {
    const patch: Record<string, string | null> = {};
    for (const [id, v] of hintEntries) {
      if (!(id in knownVault)) patch[id] = v;
    }
    if (Object.keys(patch).length) {
      startTransition(() => setVaultMap((prev) => ({ ...patch, ...(prev || {}) })));
    }
  }

  // Small concurrency pool to avoid thundering-herd under heavy traffic.
  const runPool = async <T,>(items: string[], limit: number, worker: (id: string) => Promise<T>): Promise<T[]> => {
    const out: T[] = [];
    if (items.length === 0) return out;
    const q = items.slice();
    const n = Math.max(1, Math.min(limit, q.length));
    const runners = Array.from({ length: n }, async () => {
      while (q.length) {
        const id = q.shift();
        if (!id) return;
        try {
          out.push(await worker(id));
        } catch {
          // ignore per-item failures
        }
      }
    });
    await Promise.all(runners);
    return out;
  };

  (async () => {
    try {
      const base = originFromWindow();
      const isLowEndMint = typeof window !== "undefined" && Boolean((window as any).__mmLowEnd);
      const limit = isLowEndMint ? 2 : 6;

      // 1) Vault IDs first (unblocks inline panels + equity aggregation)
      const vaultResults = await runPool(
        needVault,
        limit,
        async (id) => {
          const j = await fetch(`${base}/api/sets/${encodeURIComponent(id)}/vaultid`, { cache: "no-store", signal: ac.signal })
            .then((r) => r.json())
            .catch(() => ({} as any));
          return { id, vault: (j?.vault || j?.vaultId || null) as string | null };
        }
      );
      if (!alive) return;

      if (vaultResults.length) {
        const m: Record<string, string | null> = {};
        for (const r of vaultResults) m[r.id] = r.vault;
        startTransition(() => {
          setVaultMap((prev) => {
            // IMPORTANT (Android in-app browsers): during tx approval the WebView can blur/freeze network briefly.
            // If our vaultId fetch returns empty/null in that window, NEVER overwrite a known vaultId with null,
            // otherwise the inline panel will unmount/remount (flash) and can get stuck showing 0 balances.
            const next: Record<string, string | null> = { ...(prev || {}) };
            for (const r of vaultResults) {
              const id = String((r as any)?.id || "");
              const v = (r as any)?.vault as any;
              if (!id) continue;
              if (typeof v === "string" && v.trim().length > 0) {
                next[id] = v;
              } else {
                // Only write null for truly-unknown ids (preserve any previously known value).
                if (!Object.prototype.hasOwnProperty.call(next, id)) next[id] = null;
              }
            }
            return next;
          });
        });
      }

      // 2) Deletable next (delete button)
      const delResults = await runPool(
        needDel,
        limit,
        async (id) => {
          const j = await fetch(`${base}/api/sets/${encodeURIComponent(id)}/deletable`, { cache: "no-store", signal: ac.signal })
            .then((r) => r.json())
            .catch(() => ({} as any));
          return { id, deletable: Boolean(j?.deletable) };
        }
      );
      if (!alive) return;

      if (delResults.length) {
        const d: Record<string, boolean> = {};
        for (const r of delResults) d[r.id] = r.deletable;
        startTransition(() => {
          setDeletableMap((prev) => ({ ...prev, ...d }));
        });
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      // ignore
    }
  })();

  return () => {
    alive = false;
    try { ac.abort(); } catch {}
  };
}, [webhookSets, rebalanceSets]);


  // React to wallet-session readiness (emitted from initWalletSession)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handler = (ev: Event) => {
      try {
        const detail = (ev as CustomEvent<any>).detail || {};
        const readyWallet = typeof detail?.wallet === "string" ? detail.wallet : "";
        if (!readyWallet || !wallet) return;
        if (readyWallet !== wallet) return;
        setWalletSessionReadyNonce((n) => n + 1);
      } catch {}
    };

    window.addEventListener("mm-wallet-session-ready", handler);

    // Seed from global in case the event fired before this component hydrated
    try {
      const w: any = window as any;
      const map = (w && (w as any).__mmWalletSessionReady) || {};
      if (wallet && map && (map as any)[wallet]) {
        setWalletSessionReadyNonce((n) => n + 1);
      }
    } catch {}

    return () => {
      window.removeEventListener("mm-wallet-session-ready", handler);
    };
  }, [wallet]);
  
  // Initial sets/limits load
  useEffect(() => {
    if (!wallet || !humanOK) return;
    loadAll().catch(() => {});
  }, [wallet, humanOK, walletSessionReadyNonce, loadAll]);

  // --- Prewarm: token meta/prices and balances across all bots (client-side; no UI changes).
  useEffect(() => {
    if (!wallet || !humanOK) return;

    // Skip warmups when tab is hidden; they'll run next time we're visible.
    try {
      if (typeof document !== "undefined" && (document as any).hidden) return;
    } catch {}

    // Avoid repeating expensive warmups for the same wallet/sets/mints snapshot.
    const webhookIds = webhookSets.map((s) => s.setId).filter(Boolean) as string[];
    const rebalanceIds = rebalanceSets.map((s) => s.id).filter(Boolean) as string[];

    // Only run after vaultMap has "settled" for the current set list (undefined = not fetched yet).
    const vm = vaultMapRef.current || {};
    const allWebhookKnown = webhookIds.every((id) => Object.prototype.hasOwnProperty.call(vm, id));
    if (!allWebhookKnown) return;

    // Collect unique mints from webhook + rebalance sets
    const mints = new Set<string>();
    for (const s of webhookSets) {
      const p: any = (s as any)?.prefs || {};
      const a = String(p.mintIn || p.tokenA || p.tokenIn || "").trim();
      const b = String(p.mintOut || p.tokenB || p.tokenOut || "").trim();
      if (a) mints.add(a);
      if (b) mints.add(b);
    }
    for (const r of rebalanceSets) {
      // Prefer normalized rebalance shape (mints: string[]) used by this page.
      const arr: string[] = Array.isArray((r as any)?.mints) ? ((r as any).mints as any) : [];
      if (arr.length) {
        for (const m of arr) {
          const mint = String(m || "").trim();
          if (mint) mints.add(mint);
        }
      } else {
        // Legacy fallback (older shapes)
        const toks: any[] = (r as any)?.tokens || (r as any)?.prefs?.tokens || [];
        for (const t of toks) {
          const mint = String((t as any)?.mint || (t as any)?.address || "").trim();
          if (mint) mints.add(mint);
        }
      }
    }

    const mintIds = Array.from(mints).sort();
    const vaultSig = webhookIds
      .slice()
      .sort()
      .map((id) => String((vm as any)[id]))
      .join("|");
    const warmKey = `${wallet}|${webhookIds.slice().sort().join(",")}|${rebalanceIds
      .slice()
      .sort()
      .join(",")}|${mintIds.join(",")}|${vaultSig}`;

    if (lastPrewarmKeyRef.current === warmKey) return;
    lastPrewarmKeyRef.current = warmKey;

    // Abort any prior warmup in flight.
    try {
      prewarmAbortRef.current?.abort();
    } catch {}
    const ac = new AbortController();
    prewarmAbortRef.current = ac;

    let cancelled = false;

    const schedule = (fn: () => void) => {
      try {
        const w: any = window as any;
        if (w && typeof w.requestIdleCallback === "function") {
          const id = w.requestIdleCallback(
            () => fn(),
            { timeout: 2000 }
          );
          return () => {
            try { w.cancelIdleCallback?.(id); } catch {}
          };
        }
      } catch {}
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    };

    const cancelSchedule = schedule(() => {
      (async () => {
        try {
          if (cancelled || ac.signal.aborted) return;

          // Warm server caches (prices + token meta); browser fetch gate + server caching handle dedupe.
          const ids = mintIds;
          if (ids.length === 0) return;

          try {
            await fetch(`/api/tokens?mints=${encodeURIComponent(ids.join(","))}`, {
              cache: "no-store",
              signal: ac.signal,
            });
          } catch {}
          try {
            await fetch(`/api/prices?mints=${encodeURIComponent(ids.join(","))}`, {
              cache: "no-store",
              signal: ac.signal,
            });
          } catch {}

          if (cancelled || ac.signal.aborted) return;

          // Prime client RPC caches for balances + mint decimals, and coalesce into batched reads.
          // Jupiter Mobile iOS WebView can be extremely sensitive to heavy RPC fanout during initial render.
          // Warm server caches above, but skip the client RPC priming on that environment (no functional change).
          // iOS in-app webviews (Jupiter/Solflare/etc) can freeze if we do any RPC fanout during initial render.
          // This warmup is non-critical; we only need server-side caches (tokens/prices) for a smooth first paint.
          // So we skip client RPC priming on *all* slower iOS environments, not just Jupiter.
          try {
            const dm = (navigator as any)?.deviceMemory;
            const hc = (navigator as any)?.hardwareConcurrency;
            const isIOS = isIOSDevice();
            const isFastIOS = (typeof dm === "number" && dm >= 6) || (typeof hc === "number" && hc >= 10);
            const iOSSlow = isIOS && !isFastIOS;
            if (isJupiterInAppIOS() || iOSSlow) return;
          } catch {
            // If we can't reliably detect, be conservative on iOS.
            try { if (isIOSDevice()) return; } catch {}
          }
          const conn = ensureConnection();
          const owner = new PublicKey(wallet);

          // Detect token program per mint (cached ~30 days) and prime mint decimals
          const progByMint: Record<string, any> = {};

          // Warm mint program/decimals with a small concurrency pool to avoid RPC bursts.
          const lowEndWarm = typeof window !== "undefined" && Boolean((window as any).__mmLowEnd);
          const idsLimited = lowEndWarm ? ids.slice(0, 80) : ids.slice(0, 200);
          const mintLimit = lowEndWarm ? 2 : 6;
          let mintIdx = 0;

          await Promise.all(
            Array.from({ length: Math.min(mintLimit, idsLimited.length) }, async () => {
              while (true) {
                if (cancelled || ac.signal.aborted) return;
                const id = idsLimited[mintIdx++];
                if (!id) return;
                try {
                  const mintPk = new PublicKey(id);
                  const info = await cachedGetAccountInfoOwner(conn as any, mintPk, "processed");
                  const is22 = !!(info && info.exists && (info.owner as any)?.toBase58?.() === TOKEN_2022_PROGRAM_ID.toBase58());
                  const prog = is22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
                  progByMint[id] = prog;
                  await cachedGetMint(conn as any, mintPk, "processed", prog);
                } catch {
                  // ignore per-mint warmup failures
                }
              }
            })
          );

          if (cancelled || ac.signal.aborted) return;

// Derive all ATAs for webhook vaults + user wallet, then fetch balances (chunked)
          const atas: PublicKey[] = [];
          for (const s of webhookSets) {
            const setId = (s as any)?.setId;
            if (!setId) continue;
            const p: any = (s as any)?.prefs || {};
            const a = String(p.mintIn || p.tokenA || p.tokenIn || "").trim();
            const b = String(p.mintOut || p.tokenB || p.tokenOut || "").trim();
            const vaultId = (vm as any)[setId] as string | null | undefined;

            // Only warm vault ATAs if a vault exists (string). null means "no vault created" and is settled.
            let authPk: PublicKey | null = null;
            if (vaultId && typeof vaultId === "string") {
              try {
                authPk = new PublicKey(vaultId);
              } catch {
                authPk = null;
              }
            }

            const pairs: string[] = [];
            if (a) pairs.push(a);
            if (b) pairs.push(b);

            for (const mint of pairs) {
              if (cancelled || ac.signal.aborted) return;
              const prog = progByMint[mint] || TOKEN_PROGRAM_ID;
              try {
                const ataUser = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, prog, ASSOCIATED_TOKEN_PROGRAM_ID);
                atas.push(ataUser);
              } catch {}
              if (authPk) {
                try {
                  const ataVault = getAssociatedTokenAddressSync(new PublicKey(mint), authPk, true, prog, ASSOCIATED_TOKEN_PROGRAM_ID);
                  atas.push(ataVault);
                } catch {}
              }
            }
          }

          // De-dupe ATAs (PublicKey -> base58) before warming.
          const uniqAtas: PublicKey[] = [];
          const seen = new Set<string>();
          for (const pk of atas) {
            const k = pk.toBase58();
            if (!seen.has(k)) {
              seen.add(k);
              uniqAtas.push(pk);
            }
          }

          if (uniqAtas.length === 0) return;
          if (cancelled || ac.signal.aborted) return;

          const chunkSize = lowEndWarm ? 8 : 24;

          // Safety clamp: warmups are non-critical; cap the total to avoid huge spikes on large wallets.
          const maxWarmAtas = lowEndWarm ? 96 : 256;
           const warmAtas = uniqAtas.length > maxWarmAtas ? uniqAtas.slice(0, maxWarmAtas) : uniqAtas;


          for (let i = 0; i < warmAtas.length; i += chunkSize) {
            if (cancelled || ac.signal.aborted) return;
            const chunk = warmAtas.slice(i, i + chunkSize);
            await Promise.all(
              chunk.map((pk) =>
                cachedGetTokenAccountBalance(conn as any, pk, "processed")
                  .then(() => null)
                  .catch(() => null)
              )
            );
          }
        } catch {
          // swallow — non-critical warmup
        }
      })();
    });

    return () => {
      cancelled = true;
      try { cancelSchedule?.(); } catch {}
      try { ac.abort(); } catch {}
    };
  }, [wallet, humanOK, webhookSets, rebalanceSets, vaultMap]);

  // Token meta bootstrap: load top tokens for initial picker/map hydration.
  useEffect(() => {
    if (!humanOK) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/tokens/top", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        const arr = Array.isArray(j?.tokens) ? j.tokens : Array.isArray(j?.items) ? j.items : [];
        if (alive) setTopTokens(arr);
      } catch {
        try {
          const r2 = await fetch("/api/tokens", { cache: "no-store" });
          const j2 = await r2.json().catch(() => ({}));
          const arr2 = Array.isArray(j2?.tokens) ? j2.tokens : Array.isArray(j2?.items) ? j2.items : [];
          if (alive) setTopTokens(arr2);
        } catch {}
      }
    })();
    return () => { alive = false; };
  }, [humanOK]);

  // Backfill missing logos/symbols with /api/tokens/meta; TTL per mint; runs when sets change
  useEffect(() => {
    let alive = true;
    try {
      const wanted = new Set<string>();
      for (const s of webhookSets || []) {
        const a = String(pickMint(s?.prefs, "mintIn") || pickMint(s as any, "mintIn") || "").trim();
        const b = String(pickMint(s?.prefs, "mintOut") || pickMint(s as any, "mintOut") || "").trim();
        if (a) wanted.add(a);
        if (b) wanted.add(b);
      }
      for (const s of rebalanceSets || []) {
        for (const m of (s?.mints || [])) {
          const k = String(m || "").trim();
          if (k) wanted.add(k);
        }
      }
      const all = Array.from(wanted);
      if (all.length === 0) return () => { alive = false; };
      const topBag: Record<string, any> = {};
      for (const t of topTokens || []) {
        const k = String((t as any)?.address || (t as any)?.mint || "").trim();
        if (k) topBag[k] = t;
      }
      const missing: string[] = [];
      const _nowPerMint = Date.now();
      for (const m of all) {
        const meta = (tokMap as any)[m];
        const inTop = !!topBag[m];
        const hasSym = symIsValid(meta?.symbol) || symIsValid(dexSymbolMap[m]);
        const hasLogo = Boolean((meta && (meta.logoURI)) || (inTop && ((topBag[m] as any)?.logoURI || (topBag[m] as any)?.logoUri)));
        // UPDATED: fetch meta when **symbol OR logo** is missing (iOS-friendly fallback).
        if (!hasLogo || !hasSym) {
          const last = metaMintLastRunRef.current[m] || 0;
          if (_nowPerMint - last >= META_PER_MINT_TTL_MS) {
            missing.push(m);
          }
        }
      }
      if (missing.length === 0) return () => { alive = false; };
      (async () => {
        for (const m of missing) metaMintLastRunRef.current[m] = Date.now();
        try {
          const res = await fetch(`/api/tokens/meta?mints=${encodeURIComponent(missing.join(","))}`, { cache: "no-store" });
          const j = await res.json().catch(() => ({}));
          const items: any[] = Array.isArray(j?.items) ? j.items : Array.isArray(j?.tokens) ? j.tokens : [];
          if (!items.length) return;
          setTopTokens((prev) => {
            const bag: Record<string, any> = {};
            for (const t of prev || []) {
              const addr = String((t?.address || t?.mint || "").trim());
              if (!addr) continue;
              // Keep existing symbol if set; avoid forcing "UNKNOWN"
              bag[addr] = { ...(t as any), address: addr, mint: addr, symbol: String(t?.symbol || "") || undefined };
            }
            for (const meta of items) {
              const k = String((meta?.address || meta?.mint || "").trim());
              if (!k) continue;
              bag[k] = {
                ...(bag[k] || {}),
                address: k,
                mint: k,
                symbol: String(meta?.symbol || bag[k]?.symbol || "" ) || undefined,
                name: String(meta?.name || (tokMap[k]?.name || "")),
                logoURI: String((meta as any)?.logoURI || (meta as any)?.logoUri || (bag[k] as any)?.logoURI || fallbackLogoUri(k) || ""),
                verified: Boolean((meta as any)?.verified),
              };
            }
            if (!bag[MINT_SOL]) bag[MINT_SOL] = { address: MINT_SOL, mint: MINT_SOL, symbol: "SOL", name: "Solana", logoURI: "/brand/solana-64.png" };
            if (!bag[MINT_USDC]) bag[MINT_USDC] = { address: MINT_USDC, mint: MINT_USDC, symbol: "USDC", name: "USD Coin", logoURI: fallbackLogoUri(MINT_USDC) };
            return dedupeByAddressPicker(Object.values(bag));
          });
        } catch {}
      })();
    } catch {}
    return () => { alive = false; };
  }, [webhookSets, rebalanceSets, topTokens, tokMap, dexSymbolMap]);


  // --- Total Equity aggregation (no extra RPC; relayed from inline vault panels) ---
  const [equityTick, setEquityTick] = useState(0);
  const equityTickReq = useRef<number | null>(null);
  const bumpEquityTick = useCallback(() => {
    try {
      if (equityTickReq.current) return;
      equityTickReq.current = window.requestAnimationFrame(() => {
        equityTickReq.current = null;
        setEquityTick((t) => t + 1);
      });
    } catch {
      setEquityTick((t) => t + 1);
    }
  }, []);

  const aggregatesRef = useRef<Record<string, { running: boolean; vaultUsdTotal: number; vaultUiSum?: number; equityReady?: boolean; balancesReady?: boolean; hasVault?: boolean; ts?: number }>>({});
  const onAggregatesChange = useCallback((agg: { setId: string; running: boolean; vaultUsdTotal: number; vaultUiSum?: number; equityReady?: boolean; balancesReady?: boolean; hasVault?: boolean }) => {
    // Panels can emit frequent "no-op" aggregate updates (e.g., polling ticks). Avoid forcing
    // a hub re-render unless something materially changed.
    const prev = aggregatesRef.current[agg.setId];
    const next = {
      running: agg.running,
      vaultUsdTotal: agg.vaultUsdTotal,
      vaultUiSum: agg.vaultUiSum,
      equityReady: agg.equityReady,
      balancesReady: agg.balancesReady,
      hasVault: agg.hasVault,
      ts: Date.now(),
    };
    aggregatesRef.current[agg.setId] = next;

    let changed = true;
    if (prev) {
      changed = !(
        prev.running === next.running &&
        Object.is(prev.vaultUsdTotal, next.vaultUsdTotal) &&
        Object.is((prev.vaultUiSum ?? null), (next.vaultUiSum ?? null)) &&
        (prev.equityReady ?? null) === (next.equityReady ?? null) &&
        (prev.balancesReady ?? null) === (next.balancesReady ?? null) &&
        (prev.hasVault ?? null) === (next.hasVault ?? null)
      );
    }
    if (changed) bumpEquityTick();
  }, [bumpEquityTick]);

  const [equityGateReady, setEquityGateReady] = useState(false);
  const [equityCheckNonce, setEquityCheckNonce] = useState(0);

  // Refresh nudges: ask panels to retry missing USD prices (no extra RPC; panels already use /api/prices).
  // Event-based so we can target only incomplete panels and avoid prop drilling.
  const equityRefreshTargetsRef = useRef<string[]>([]);
  const nudgeEquityRefresh = useCallback((setIds: string[]) => {
    try {
      if (!setIds || setIds.length === 0) return;
      if (typeof window === 'undefined') return;
      window.dispatchEvent(new CustomEvent('mm:equityRefresh', { detail: { setIds: Array.from(new Set(setIds)).filter(Boolean) } }));
    } catch {}
  }, []);

  // Periodic re-checks (5s, 10s, 15s, 20s after load) to avoid showing partial equity during initial hydration/price loads.
  useEffect(() => {
    if (equityGateReady) return;
    const fire = () => {
      const targets = (equityRefreshTargetsRef.current || []) as any;
      if (!Array.isArray(targets) || targets.length === 0) return;
      try { nudgeEquityRefresh(targets); } catch {}
      setEquityCheckNonce((n) => n + 1);
      bumpEquityTick();
    };
    const t5  = window.setTimeout(fire, 5_000);
    const t10 = window.setTimeout(fire, 10_000);
    const t15 = window.setTimeout(fire, 15_000);
    const t20 = window.setTimeout(fire, 20_000);
    return () => { try { window.clearTimeout(t5); window.clearTimeout(t10); window.clearTimeout(t15); window.clearTimeout(t20); } catch {} };
  }, [equityGateReady, bumpEquityTick, nudgeEquityRefresh]);

      // Precompute bot id list + vaultId presence map so equitySnapshot doesn't redo this work
    // on every equityTick. (No UI changes; reduces CPU under heavy panel updates.)
    const botIds = useMemo(() => {
      try {
        const ids = new Set<string>();
        for (const s of webhookSets || []) ids.add(String((s as any)?.setId || ''));
        for (const s of rebalanceSets || []) ids.add(String((s as any)?.id || ''));
        return Array.from(ids).map((s) => String(s || '').trim()).filter(Boolean);
      } catch {
        return [] as string[];
      }
    }, [webhookSets, rebalanceSets]);

    const vaultIdByIdMemo = useMemo(() => {
      try {
        const vaultIdById: Record<string, string | null> = {};

        // IMPORTANT: Only treat a set's vaultId as authoritative if the property is actually present.
        // Webhook sets historically do NOT include vaultId in /api/webhooks/for/:wallet responses.
        // If we default missing -> null here, we permanently classify that bot as "no vault" and
        // the header may commit a low total before vaultMap/panels hydrate.
        for (const s of webhookSets || []) {
          const sid = String((s as any)?.setId || '').trim();
          if (!sid) continue;

          // Only commit an entry if the field exists on the object.
          if (Object.prototype.hasOwnProperty.call(s as any, "vaultId")) {
            const v = (s as any)?.vaultId;
            vaultIdById[sid] = (typeof v === 'string' && v.trim().length > 0) ? v : null;
          }
        }
        for (const s of rebalanceSets || []) {
          const sid = String((s as any)?.id || '').trim();
          if (!sid) continue;

          // Rebalance sets generally include vaultId, but keep the same "present field" guard for safety.
          if (Object.prototype.hasOwnProperty.call(s as any, "vaultId")) {
            const v = (s as any)?.vaultId;
            vaultIdById[sid] = (typeof v === 'string' && v.trim().length > 0) ? v : null;
          }
        }

        return vaultIdById;
      } catch {
        return {} as Record<string, string | null>;
      }
    }, [webhookSets, rebalanceSets]);

  const equitySnapshot = useMemo(() => {
      try {
        const bag = aggregatesRef.current || {};
        const scanIds: string[] = Array.isArray(botIds) ? botIds : [];

        const vaultIdById: Record<string, string | null> = vaultIdByIdMemo || {};

        let total = 0;
        let pending = 0;
        let activeCount = 0;
        const refreshTargets: string[] = [];

        for (const id of scanIds) {
          const agg: any = bag[id];

          // Gate 0: we need a definitive "hasVault" decision for this bot.
          // - true: treat as vault-bearing and require balancesReady + vaultUiSum.
          // - false: resolved (no vault; excluded)
          // - undefined: pending (header stays Loading…)
          const hasVault: boolean | undefined = (() => {
            try {
              // Primary source of truth: the set object itself (vaultId).
              if (Object.prototype.hasOwnProperty.call(vaultIdById, id)) {
                const v = (vaultIdById as any)[id];
                return (typeof v === 'string' && v.trim().length > 0) ? true : false;
              }

              // Secondary: vaultMap batch lookup (may hydrate later).
              if (Object.prototype.hasOwnProperty.call(vaultMap as any, id)) {
                const v = (vaultMap as any)[id];
                if (typeof v === 'string' && v.trim().length > 0) return true;
                if (v === null) return false;
                return undefined;
              }

              // Final fallback: panel-reported hasVault (may be undefined during hydration).
              return (typeof agg?.hasVault === 'boolean') ? Boolean(agg.hasVault) : undefined;
            } catch {
              return undefined;
            }
          })();

  if (hasVault === undefined) {
            pending += 1;
            refreshTargets.push(id);
            continue;
          }
          if (hasVault === false) {
            // Explicitly no vault => resolved, excluded.
            continue;
          }

          // Phase 1 readiness: we must know vaultUiSum (so we know whether to include this bot at all)
          const uiSum = Number(agg?.vaultUiSum);
          const balancesReady = Boolean(agg?.balancesReady);
          if (!balancesReady || !Number.isFinite(uiSum)) {
            pending += 1;
            refreshTargets.push(id);
            continue;
          }

          // Determine whether the vault is funded.
          // - Webhook vaults normally report a positive vaultUiSum once balances load.
          // - Rebalance vaults may not report a meaningful vaultUiSum (or may keep it at 0)
          //   while still having a correct USD total.
          const usd = Number(agg?.vaultUsdTotal);
          const ready = Boolean(agg?.equityReady);
          const funded = (uiSum > 0) || (ready && Number.isFinite(usd) && usd > 0);

          // If vault exists but is not funded, it's resolved and not included.
          if (!funded) continue;

          activeCount += 1;

          // Phase 2 readiness: funded vault must have a complete USD total.
          if (!ready || !Number.isFinite(usd)) {
            pending += 1;
            refreshTargets.push(id);
            continue;
          }

          total += usd;
        }

        const complete = scanIds.length === 0 ? true : pending === 0;
        return { total, complete, activeCount, pending, refreshTargets };
      } catch {
        return { total: 0, complete: false, activeCount: 0, pending: 0, refreshTargets: [] as string[] };
      }
    }, [botIds, vaultIdByIdMemo, vaultMap, equityTick, equityCheckNonce]);

  // Keep latest refresh targets in a ref so timed checks can nudge panels without needing to
  // re-evaluate closures.
  useEffect(() => {
    try {
      const raw: any = (equitySnapshot as any)?.refreshTargets;
      const arr: any[] = Array.isArray(raw) ? raw : [];
      const next: string[] = Array.from(new Set(arr))
        .map((v: any) => (typeof v === "string" ? v.trim() : ""))
        .filter((v: string) => v.length > 0);
      equityRefreshTargetsRef.current = next;
    } catch {}
  }, [equitySnapshot]);

  useEffect(() => {
    if (equityGateReady) return;
    if (equitySnapshot.complete) setEquityGateReady(true);
  }, [equityGateReady, equitySnapshot.complete]);

  // Commit the displayed equity *only once* when all vault panels are fully ready,
  // so the header never shows a scary "low" number that climbs over time.
  const equityKey = useMemo(() => {
    try {
      const ids = new Set<string>();
      for (const s of webhookSets || []) ids.add(String((s as any)?.setId || ''));
      for (const s of rebalanceSets || []) ids.add(String((s as any)?.id || ''));
      const arr = Array.from(ids).map((s) => String(s || '').trim()).filter(Boolean).sort();
      return arr.join('|');
    } catch {
      return '';
    }
  }, [webhookSets, rebalanceSets]);

  const [equityCommittedUsd, setEquityCommittedUsd] = useState<number | null>(null);
  useEffect(() => {
    // Reset gate on any bot list changes.
    setEquityCommittedUsd(null);
    setEquityGateReady(false);
  }, [equityKey]);

  useEffect(() => {
    if (equityCommittedUsd != null) return;
    // Prevent early "$0" commit while the bot list is still hydrating.
    // We only commit once we have at least one aggregate tick for a non-empty bot list.
    const botCount = (Array.isArray(webhookSets) ? webhookSets.length : 0) + (Array.isArray(rebalanceSets) ? rebalanceSets.length : 0);
    // If we have bots but haven't received any panel state yet, do not commit.
    if (botCount > 0 && equityTick === 0) return;
    // If we are still fetching the set list, keep the header on Loading…
    if (typeof loading !== "undefined" && (loading as any) === true) return;
    if (!equitySnapshot.complete) return;
    setEquityGateReady(true);
    setEquityCommittedUsd(Number(equitySnapshot.total || 0));
  }, [equityCommittedUsd, equitySnapshot.complete, equitySnapshot.total, webhookSets, rebalanceSets, equityTick, loading]);

  const totalEquityLabel = useMemo(() => {
    try {
      if (equityCommittedUsd == null) return 'Loading…';
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(equityCommittedUsd || 0));
    } catch {
      return equityCommittedUsd == null ? 'Loading…' : String(equityCommittedUsd);
    }
  }, [equityCommittedUsd]);
  // --- End Total Equity aggregation ---


  const aggregated = useMemo<AggregatedRow[]>(() => {
    // De-duplicate by set id across kinds to avoid ghost "webhook" rows for rebalance sets.
    // Priority: rebalance > webhook
    const byId = new Map<string, AggregatedRow>();

    // 1) Rebalance first
    for (const s of rebalanceSets) {
      const row: AggregatedRow = { kind: "rebalance", createdAt: tsFromCreated(s), id: s.id, data: s };
      byId.set(s.id, row);
    }

    // 2) Webhooks next (skip if id already claimed by rebalance)
    for (const s of webhookSets) {
      if (!byId.has(s.setId)) {
        byId.set(s.setId, { kind: "webhook", createdAt: tsFromCreated(s), id: s.setId, data: s });
      }
    }
    const out = Array.from(byId.values());
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }, [webhookSets, rebalanceSets]);

  const totalBots = aggregated.length;
  const BOT_LIMIT = 6;
  const canCreate = totalBots < BOT_LIMIT && (!createLimit || (createLimit && createLimit.remaining > 0));

  // -------------------------------
  // Mobile perf: stagger mounting heavy panels on fragile WebViews (iOS + low-end Android) to avoid freezes
  // -------------------------------
  const isIosSlow = useMemo(() => {
    try {
      if (!isIOSDevice()) return false;
      const dm = (navigator as any)?.deviceMemory;
      const hc = (navigator as any)?.hardwareConcurrency;
      // If we can detect higher-spec iOS devices, let them behave like desktop.
      if (typeof dm === "number" && dm >= 6) return false;
      if (typeof hc === "number" && hc >= 10) return false;
      return true;
    } catch {
      return true;
    }
  }, []);

  // Android in-app browsers / WebViews can also freeze under bursty mounts + RPC refresh storms.
  // We only stagger on Android when it *looks* like an in-app WebView AND the device is likely low-end.
  const isAndroidSlow = useMemo(() => {
    try {
      const ua = navigator.userAgent || "";
      if (!/Android/i.test(ua)) return false;

      // WebView markers: "wv" token is common; some in-app browsers omit "Safari" and include "Version/".
      const isWv = /\bwv\b/i.test(ua) || (/Version\//i.test(ua) && /Chrome\//i.test(ua) && !/Safari\//i.test(ua));

      // Wallet/in-app signals (best-effort; harmless if missed).
      const isWalletInApp = /(Jupiter|Solflare|Phantom|Backpack)/i.test(ua);

      const dm = (navigator as any)?.deviceMemory;
      const hc = (navigator as any)?.hardwareConcurrency;
      const saveData = (navigator as any)?.connection && (navigator as any).connection.saveData === true;

      // Slightly looser than the global __mmLowEnd (Android devices commonly report 4 cores / 4GB).
      const lowMem = typeof dm === "number" ? dm <= 4 : false;
      const lowCPU = typeof hc === "number" ? hc <= 4 : false;

      // Also honor the global heuristic if it already flagged this tab.
      const globalLowEnd = Boolean((window as any)?.__mmLowEnd);

      return (isWv || isWalletInApp) && (globalLowEnd || lowMem || lowCPU || saveData);
    } catch {
      return false;
    }
  }, []);

  const isMobileSlow = Boolean(isIosSlow || isAndroidSlow);

  const [renderCount, setRenderCount] = useState<number>(() => {
    try {
      return isMobileSlow ? Math.min(1, aggregated.length) : aggregated.length;
    } catch {
      return 1;
    }
  });

  const [showMetrics, setShowMetrics] = useState<boolean>(() => !isMobileSlow);

  useEffect(() => {
    // Keep high-spec devices behaving like desktop: mount everything immediately.
    if (!isMobileSlow) {
      setRenderCount(aggregated.length);
      return;
    }

    // On iOS (especially in-app webviews), mounting all panels at once can freeze the UI.
    // We progressively mount one panel at a time. This does not change data or behavior—only pacing.
    let cancelled = false;
    const target = aggregated.length;

    // Reset to first panel whenever the list changes.
    setRenderCount(target > 0 ? 1 : 0);

    if (target <= 1) return;

    let i = 1;
    const tickMs = (() => {
      // iOS in-app webviews can choke if multiple heavy panels mount while effects are still running.
      // Use a slower cadence for larger wallets to avoid overlapping RPC bursts.
      if (!isMobileSlow) return 0;
      if (target >= 24) return 900;
      if (target >= 12) return 700;
      if (target >= 6) return 450;
      return 260;
    })();

    // Track the most recent scheduled work so the effect cleanup can cancel it (prevents leaks on iOS webviews).
let tickTimer: any = null;
let tickIdle: any = null;

const scheduleTick = (fn: () => void) => {
  // Prefer idle time when available; fall back to a small timeout.
  try {
    const ric = (window as any).requestIdleCallback as any;
    if (typeof ric === "function") {
      tickIdle = ric(() => fn(), { timeout: tickMs });
      return;
    }
  } catch {}
  tickTimer = setTimeout(fn, tickMs);
};


    const tick = () => {
      if (cancelled) return;
      i = Math.min(target, i + 1);
      setRenderCount(i);
      if (i < target) scheduleTick(tick);
    };

    scheduleTick(tick);
    return () => {
      cancelled = true;
      try { if (tickTimer) clearTimeout(tickTimer as any); } catch {}
      try {
        const cic = (window as any).cancelIdleCallback as any;
        if (tickIdle && typeof cic === "function") cic(tickIdle);
      } catch {}
    };
  }, [aggregated.length, isMobileSlow]);


  useEffect(() => {
    // Defer metrics panel on iOS webviews until the list begins rendering to avoid main-thread stalls.
    if (!isMobileSlow) return;
    if (showMetrics) return;
    let cancelled = false;

    // Show once we have at least a couple panels mounted, or after a short timeout.
    const threshold = Math.min(3, aggregated.length);
    if (renderCount >= threshold && threshold > 0) {
      setShowMetrics(true);
      return;
    }

    const t = setTimeout(() => {
      if (cancelled) return;
      setShowMetrics(true);
    }, 2500);

    return () => {
      cancelled = true;
      try { clearTimeout(t as any); } catch {}
    };
  }, [isMobileSlow, showMetrics, renderCount, aggregated.length]);


  // -------------------------------
  // Webhooks helpers (token prefs + delete)
  // -------------------------------
  const savingPrefsRef = useRef<string | null>(null);
  const prefsSeqRef = useRef<Record<string, number>>({});

  const optimisticRebalanceRef = useRef<Record<string, Partial<RebalanceSet>>>({});
  const optimisticPrefsRef = useRef<Record<string, AnyObj>>({});
  const saveWebhookPrefs = useCallback(
    async (
      setId: string,
      patch: any,
      tok?: { address: string; symbol: string; logoURI?: string }
    ) => {
      if (!wallet) return;

      // Sequence guard: ignore stale in-flight saves for this set (prevents SOL/USDC default writes from "winning" later).
      const __seq = (prefsSeqRef.current[setId] || 0) + 1;
      prefsSeqRef.current[setId] = __seq;

      // FIX: allow saving when vault status is unknown; only block if a vault actually exists.
      const hasVault = Boolean(vaultMap[setId]);
      if (hasVault) {
        alert("Tokens are locked after a vault is created. Delete the set to change tokens.");
        return;
      }

      // Sanitize: drop undefined/null/empty to avoid poisoning optimistic state
      const patchClean = Object.fromEntries(
        Object.entries(patch || {}).filter(([, v]) => v !== undefined && v !== null && v !== "")
      ) as AnyObj;

      savingPrefsRef.current = setId;

      // Optimistic local merge
      // IMPORTANT: Some backend implementations treat `prefs` as a full object (replace) not a partial merge.
      // So we always compute and persist a *fully merged* prefs object (existing + optimistic + patch).
      let mergedPrefsForSave: AnyObj = { ...(optimisticPrefsRef.current[setId] || {}), ...patchClean };
      setWebhookSets((prev) =>
        prev.map((s) => {
          if (s.setId !== setId) return s;
          const base = { ...(s.prefs || {}), ...(optimisticPrefsRef.current[setId] || {}) };
          const merged = { ...base, ...patchClean };
          mergedPrefsForSave = merged;
          return { ...s, prefs: merged };
        })
      );
      optimisticPrefsRef.current = {
        ...optimisticPrefsRef.current,
        [setId]: mergedPrefsForSave,
      };

      // Seed token meta cache if the picker returned a token object
      if (tok && tok.address && tok.symbol) {
        setTopTokens((prev) => {
          const bag: Record<string, any> = {};
          for (const t of prev || []) {
            const addr = String((t as any)?.address || (t as any)?.mint || "").trim();
            if (!addr) continue;
            bag[addr] = { ...(t as any), address: addr, mint: addr, symbol: String((t as any)?.symbol || "UNKNOWN") };
          }
          const addr = String(tok.address).trim();
          if (addr && !bag[addr]) {
            bag[addr] = {
              address: addr,
              mint: addr,
              symbol: tok.symbol,
              logoURI: (tok as any)?.logoURI || fallbackLogoUri(addr),
            };
          }
          return dedupeByAddressPicker(Object.values(bag));
        });

        // Persist a stable per-mint tokenMeta entry in prefs (logo cache) and warm global meta cache.
        try {
          const addr = String((tok as any)?.address || "").trim();
          const logo = String(((tok as any)?.logoURI || (tok as any)?.logoUri || "")).trim();
          const sym  = String((tok as any)?.symbol || "").trim();
          const nm   = String((tok as any)?.name || "").trim();
          if (addr) {
            // Warm long-lived token meta cache (Upstash-backed) for logo stability.
            void fetch(`/api/tokens/meta?mints=${encodeURIComponent(addr)}`, { cache: "no-store" }).catch(() => {});

            // Mirror into patchClean so it gets saved on the set document immutably.
            const meta = { address: addr, mint: addr, symbol: sym || undefined, name: nm || undefined, logoURI: logo || undefined };
            const prevMeta = (patchClean as any)?.tokenMeta || {};
            (patchClean as any).tokenMeta = { ...(prevMeta || {}), [addr]: meta };

            // Also write mirrored explicit fields to dodge precedence issues in mixed legacy docs.
            if ((patchClean as any).mintIn === addr) (patchClean as any).mintA = addr;
            if ((patchClean as any).mintOut === addr) (patchClean as any).mintB = addr;
          }
        } catch {}
      }

      try {
        // Include explicit top-level mint fields for back-compat with legacy DB schemas/read paths.
        // Some older endpoints persist mintA/mintB (or tokenA/tokenB) at the root, not only under prefs.
        const __mi = String(pickMint(mergedPrefsForSave as any, "mintIn") || "").trim();
        const __mo = String(pickMint(mergedPrefsForSave as any, "mintOut") || "").trim();

        const res = await fetch("/api/webhooks/prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-wallet": wallet },
          body: JSON.stringify({
            wallet,
            setId,
            prefs: mergedPrefsForSave,
            // root mirrors (server may ignore extras; safe additive)
            mintA: __mi || undefined,
            mintB: __mo || undefined,
            mintIn: __mi || undefined,
            mintOut: __mo || undefined,
            tokenA: __mi || undefined,
            tokenB: __mo || undefined,
          }),
        });
        const data: AnyObj = await res.json().catch(() => ({} as AnyObj));
        if (prefsSeqRef.current[setId] !== __seq) return;
        if (res.ok && data?.ok !== false) {
        }

        // Confirm optimistic state with server response by merging once more
        setWebhookSets((prev) =>
          prev.map((row) =>
            row.setId === setId
              ? { ...row, prefs: { ...(row.prefs || {}), ...mergedPrefsForSave } }
              : row
          )
        );
      } catch (e) {
        console.error("saveWebhookPrefs error", e);
      } finally {
        savingPrefsRef.current = null;
      }
    },
    [wallet, loadAll, vaultMap]
  );
  const deleteSet = useCallback(async (kind: "webhook" | "rebalance", setId: string) => {
    const vId = vaultMap[setId] || null;
    const agg = (aggregatesRef.current || {})[setId];

    if (vId) {
      const hasNumericBalance = agg && typeof agg.vaultUsdTotal === "number";
      const bal = hasNumericBalance ? agg.vaultUsdTotal : null;

      if (!hasNumericBalance) {
        alert("Vault balances are still loading for this set. Please wait a moment and try again before deleting.");
        return;
      }

      if ((bal || 0) > 0) {
        alert("This set's vault still has funds. Please withdraw all funds before deleting the set.");
        return;
      }
    }

    const proceed = isIOSDevice() ? true : confirm("Are you sure you want to delete this set and its associated vault? This will remove all records from the database.");
    if (!proceed) return;
    try {
      let ok = false;
      if (kind === "rebalance") {
        const res = await fetch(`/api/rebalance/delete`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", "x-wallet": wallet },
          body: JSON.stringify({ setId }),
          cache: "no-store",
        });
        const data: AnyObj = await res.json().catch(() => ({} as AnyObj));
        ok = Boolean(res.ok && (data?.ok !== false));
      } else {
        const res = await fetch(`/api/sets/${encodeURIComponent(setId)}/delete`, {
          method: "POST",
          cache: "no-store",
        });
        const data: AnyObj = await res.json().catch(() => ({} as AnyObj));
        ok = Boolean(res.ok && (data?.ok !== false));
      }
      if (!ok) {
        alert("failed to delete set");
        return;
      }
      setWebhookSets((prev) => prev.filter((s) => s.setId !== setId));
      setRebalanceSets((prev) => prev.filter((s) => (s as any).id !== setId));
      // Re-sync from the backend to avoid reappearing items in case other state holders reload
      loadAll().catch(() => {});
    } catch (e) {
      alert("failed to delete set");
    }
  }, [loadAll, wallet, vaultMap]);

  // -------------------------------
  // Rebalance helpers (persist mints/cadence; create vault)
  // -------------------------------
  
const persistRebalancePart = useCallback(
    async (setId: string, patch: Partial<{ mints: string[]; cadence: Cadence }>) => {
      const isMints = Array.isArray((patch as any)?.mints);
      const isCadence = typeof (patch as any)?.cadence === "string";
      // mark saving for this set/field(s)
      try {
        setRebalanceSaving((prev) => {
          const cur = prev[setId] || { mints: 0, cadence: 0 };
          return { ...prev, [setId]: { mints: cur.mints + (isMints ? 1 : 0), cadence: cur.cadence + (isCadence ? 1 : 0) } };
        });
      } catch {}
      try {
        let res = await fetch("/api/rebalance/set", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-wallet": wallet },
          body: JSON.stringify({ id: setId, wallet, ...patch }),
        });
        let data = await res.json().catch(() => ({} as any));
        if (!res.ok || (data && data.ok === false)) {
          res = await fetch("/api/rebalance/set", {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-wallet": wallet },
            body: JSON.stringify({ setId, ...patch }),
          });
          data = await res.json().catch(() => ({} as any));
          if (!res.ok || (data && data.ok === false)) throw new Error((data && data.error) || "save failed");
        }
      } catch (e) {
        console.error("persistRebalancePart error", e);
      } finally {
        // Wait for DB->API to catch up before re-enabling buttons
        try { await loadAll(); } catch {}
        try {
          setRebalanceSaving((prev) => {
            const cur = prev[setId] || { mints: 0, cadence: 0 };
            const nextM = Math.max(0, cur.mints - (isMints ? 1 : 0));
            const nextC = Math.max(0, cur.cadence - (isCadence ? 1 : 0));
            return { ...prev, [setId]: { mints: nextM, cadence: nextC } };
          });
        } catch {}
      }
    },
    [wallet, loadAll]
  );


  // -------------------------------
  // Render helpers
  // -------------------------------
  function makeWebhookUrls(s: WebhookSet): { buy: string; sell: string } {
    const origin = originFromWindow();
    const buyId =
      s.buyId?.trim() ||
      (s.urls?.buy ? lastSegment(s.urls.buy) : "");
    const sellId =
      s.sellId?.trim() ||
      (s.urls?.sell ? lastSegment(s.urls.sell) : "");
    const buy = buyId ? `${origin}/buy/${buyId}` : "";
    const sell = sellId ? `${origin}/sell/${sellId}` : "";
    return { buy, sell };
  }

  function nextAvailableMint(current: string[], initial: any[]): string {
    const pool = (Array.isArray(initial) ? initial : []).map((t) => String(t?.address || t?.mint || "")).filter(Boolean);
    const picks = pool.filter((m) => !current.includes(m));
    return picks[0] || MINT_USDC;
  }

  function renderInline(row: AggregatedRow) {
    // WEBHOOKS
    if (row.kind === "webhook") {
      const s = row.data as WebhookSet;
      const mintIn = pickMint(s.prefs, "mintIn") || pickMint(s as any, "mintIn") || MINT_SOL;
      const valIn = pickMint(s.prefs, "mintIn") || pickMint(s as any, "mintIn");
      const mintOut = pickMint(s.prefs, "mintOut") || pickMint(s as any, "mintOut") || MINT_USDC;
      const valOut = pickMint(s.prefs, "mintOut") || pickMint(s as any, "mintOut");
      const urls = makeWebhookUrls(s);
      const __vHas = Object.prototype.hasOwnProperty.call(vaultMap, s.setId) || Object.prototype.hasOwnProperty.call((s as any) || {}, "vaultId");
      const vId = (vaultMap[s.setId] || (s as any)?.vaultId || null);
      
      const __showPickers = __vHas && !vId;
      const __prefsReadyForPickers = !__showPickers || (typeof valIn === "string" && valIn.trim().length > 0 && typeof valOut === "string" && valOut.trim().length > 0);
      const created = row.createdAt;
      const show = !!showWebhooksMap[s.setId];

      const isCopiedBuy = !!copyStatus && copyStatus.setId === s.setId && copyStatus.side === "buy";
      const isCopiedSell = !!copyStatus && copyStatus.setId === s.setId && copyStatus.side === "sell";

      const defaultWebhookTitle = `Webhooks: Buy ${tokenSymbolFromMap(mintIn, "BASE", tokMap)} Sell for ${tokenSymbolFromMap(mintOut, "QUOTE", tokMap)}`;

      return (
        <div key={`w-${s.setId}`} className="mb-6 rounded-2xl border border-white/10 bg-[#1D1D1D] p-4 ring-1 ring-brandPurple/30 shadow-md shadow-brandPurple/20">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-base font-semibold">
              <GradientTitle kind="webhook"  defaultTitle={defaultWebhookTitle} label={s.label?.trim() || undefined} />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowWebhooksMap((prev) => ({ ...prev, [s.setId]: !show }))}
                className="rounded-full border border-brandPurple/20 bg-brandPurple/15 px-2 py-0.5 text-[10px] font-medium hover:border-brandPurple/30 transition-colors"
              >
                {show ? "Hide Webhooks" : "Show Webhooks"}
              </button>
              {(() => {
                const agg = (aggregatesRef.current || {})[s.setId];
                const vaultKnown = Object.prototype.hasOwnProperty.call(vaultMap, s.setId);
                const vId = vaultKnown ? (vaultMap[s.setId] || null) : null;

                // If vault is definitively NOT created yet, allow delete as soon as /deletable says so.
                if (vaultKnown && !vId) return !!deletableMap[s.setId];

                // Otherwise, require a safe aggregate snapshot before allowing delete.
                const hasAgg = !!agg;
                const hasNumericBalance = hasAgg && typeof (agg as any).vaultUsdTotal === "number";
                const bal = hasNumericBalance ? Number((agg as any).vaultUsdTotal || 0) : 0;
                const isRunning = !!(agg && (agg as any).running);
                const hasVault = !!vId || bal > 0;
                const safeVaultOK = hasAgg && (!hasVault || (bal === 0 && !isRunning));
                return !!deletableMap[s.setId] && safeVaultOK;
              })() ? (
                <button
                  onClick={() => deleteSet("webhook", s.setId)}
                  title="Delete Set"
                  aria-label="Delete Set"
                  className="rounded-md border border-red-400/60 bg-red-900/20 px-2 py-0.5 text-[10px] font-medium text-red-300 hover:bg-red-500/20"
                >
                  x
                </button>
              ) : null}
            </div>
          </div>

          <div className={"grid gap-3 sm:grid-cols-2 " + (__showPickers ? "" : "hidden")}>
            {(initialReady && __prefsReadyForPickers) ? (
              <>
                <TokenPicker
                  label="BUY (trade)"
                  locked={!!vId}
                  value={valIn!}
                  onChange={(mint, tok) => {
                    const next = (mint || "").trim();
                    if (next && valOut && next === valOut) return;
                    return saveWebhookPrefs(
                      s.setId,
                      { mintIn: next || undefined },
                      tok
                    );
                  }}
                  initialTokens={initialTokens}
                />
                <TokenPicker
                  label="SELL (deposit into vault)"
                  locked={!!vId}
                  value={valOut!}
                  onChange={(mint, tok) => {
                    const next = (mint || "").trim();
                    if (next && valIn && next === valIn) return;
                    return saveWebhookPrefs(
                      s.setId,
                      { mintOut: next || undefined },
                      tok
                    );
                  }}
                  initialTokens={initialTokens}
                />
              </>
            ) : (
              <>
                <div className="h-10 rounded-md bg-white/5 animate-pulse" />
                <div className="h-10 rounded-md bg-white/5 animate-pulse" />
              </>
            )}
          </div>

          <div className="mt-3">
            <div className={(show ? "grid" : "hidden") + " mt-0 gap-2 sm:grid-cols-[1fr_auto]"}>
              <div className="w-full select-text break-all rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm font-mono text-slate-100">
                {urls.buy || "—"}
              </div>
              <button
                onClick={async () => {
                  if (!urls.buy) return;
                  try {
                    await navigator.clipboard.writeText(urls.buy);
                    setCopyStatus({ setId: s.setId, side: "buy" });
                    setTimeout(() => {
                      setCopyStatus((prev) =>
                        prev && prev.setId === s.setId && prev.side === "buy" ? null : prev
                      );
                    }, 1500);
                  } catch {
                    // ignore clipboard errors (e.g., unsupported browser)
                  }
                }}
                className={"rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 hover:bg-white/10" + (isCopiedBuy ? " border-brandMint/70 bg-brandMint/20" : "")}
                disabled={!urls.buy}
              >
                {isCopiedBuy ? "Copied ✓" : "Copy BUY"}
              </button>
              <div className="w-full select-text break-all rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm font-mono text-slate-100">
                {urls.sell || "—"}
              </div>
              <button
                onClick={async () => {
                  if (!urls.sell) return;
                  try {
                    await navigator.clipboard.writeText(urls.sell);
                    setCopyStatus({ setId: s.setId, side: "sell" });
                    setTimeout(() => {
                      setCopyStatus((prev) =>
                        prev && prev.setId === s.setId && prev.side === "sell" ? null : prev
                      );
                    }, 1500);
                  } catch {
                    // ignore clipboard errors (e.g., unsupported browser)
                  }
                }}
                className={"rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 hover:bg-white/10" + (isCopiedSell ? " border-brandMint/70 bg-brandMint/20" : "")}
                disabled={!urls.sell}
              >
                {isCopiedSell ? "Copied ✓" : "Copy SELL"}
              </button>
            </div>
          </div>

          <div className="mt-3">
            {(__vHas && vId) ? (
              <VaultInlinePanel
                setId={s.setId}
                setTitle={s.label?.trim() || undefined}
                ownerWallet={wallet}
                tokenA={{ mint: mintIn, symbol: tokenDisplaySymbol(mintIn, tokMap), logoURI: tokMap?.[mintIn]?.logoURI }}
                tokenB={{ mint: mintOut, symbol: tokenDisplaySymbol(mintOut, tokMap), logoURI: tokMap?.[mintOut]?.logoURI }} /*__PATCHED__*/
                walletShim={panelWalletShimStable}
                initialVaultAddress={vId}
                deferHeavy={__mmLowEnd}
                onAggregatesChange={onAggregatesChange}
                assumeVaultExists
                showLoadingPlaceholders={equityCommittedUsd == null}
              />
            ) : (__vHas ? (
              <div className="flex flex-col items-stretch gap-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-white/60">Create a vault to start trading from webhook signals.</div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-full border border-brandPurple/20 bg-brandPurple/15 hover:border-brandPurple/30 transition-colors"
                    type="button"
                    style={{ touchAction: "manipulation", WebkitTransform: "translateZ(0)" }}
                    onClick={async (ev) => {
                      // iOS 12/13 double-fire guard
                      try {
                        const __t: any = (ev && (ev as any).currentTarget) || null;
                        if (__t) {
                          const now = Date.now();
                          if (typeof (__t as any).__mmClickRanAt === "number" && now - ( __t as any ).__mmClickRanAt < 700) {
                            return;
                          }
                          try { (__t as any).__mmClickRanAt = now; } catch {}
                        }
                      } catch {}
                      setWebhookCreateErr((prev) => ({ ...prev, [s.setId]: "" }));
                      try {
                        const opt = (optimisticPrefsRef.current?.[s.setId] || {}) as AnyObj;
                        const merged = { ...(s.prefs || {}), ...opt };
                        const mintA = (pickMint(merged, "mintIn") || "").trim();
                        const mintB = (pickMint(merged, "mintOut") || "").trim();
                        if (!mintA || !mintB) {
                          setWebhookCreateErr((prev) => ({ ...prev, [s.setId]: "Please select both tokens before creating the vault." }));
                          return;
                        }

                        // IMPORTANT (iOS old Safari): trigger wallet action *first* so it's within the user gesture
                        let vaultAddr = "";
                        try {
                          const res = await createVaultForSet({ publicKey, sendTransaction, signTransaction } as any, s.setId, mintA, mintB);
                          vaultAddr = (res && (res as any).vault) ? String((res as any).vault) : "";
                        } catch (e: any) {
                          setWebhookCreateErr((prev) => ({ ...prev, [s.setId]: (e && e.message) ? String(e.message) : "Vault creation failed." }));
                          return;
                        }
                        if (!vaultAddr) {
                          setWebhookCreateErr((prev) => ({ ...prev, [s.setId]: "Vault creation returned no vault address." }));
                          return;
                        }

                        // Update UI immediately
                        setVaultMap((prev) => ({ ...prev, [s.setId]: vaultAddr }));

                        // Persist mapping immediately so subsequent refreshes don't null it out
                        try {
                          await fetch('/api/vaults/record', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ setId: s.setId, vault: vaultAddr })
                          }).then((r) => r.json()).catch(() => ({}));
                        } catch {}

                        // Best-effort: persist explicit prefs after on-chain success (no blocking of wallet gesture)
                        try {
                          if (!s.prefs?.mintIn || !s.prefs?.mintOut || s.prefs.mintIn !== mintA || s.prefs.mintOut !== mintB) {
                            await fetch("/api/webhooks/prefs", {
                              method: "POST",
                              headers: { "Content-Type": "application/json", "x-wallet": wallet },
                              body: JSON.stringify({ setId: s.setId, mintIn: mintA, mintOut: mintB, prefs: { mintIn: mintA, mintOut: mintB, mintA: mintA, mintB: mintB } }),
                            }).then((r) => r.json()).catch(() => ({}));
                          }
                        } catch {}

                        // Refresh server-side derived state
                        loadAll().catch(() => {});
                      } catch (e) {
                        console.error("createVaultForSet error", e);
                        setWebhookCreateErr((prev) => ({ ...prev, [s.setId]: "Failed to create vault. See console for details." }));
                      }
                    }}
                  >
                    Create Vault
                  </Button>
                </div>
                <div className="mt-0.5 text-[10px] leading-3 text-red-400 min-h-[0.8rem]">
                  {webhookCreateErr[s.setId] ? `Error: ${webhookCreateErr[s.setId]}` : ""}
                </div>
              </div>

            ) : null)}
          </div>

          <div className="mt-4 border-t border-white/10 pt-2 text-[11px] text-white/60">
            <div>Set ID: <span className="font-mono text-white/70">{s.setId}</span></div>
            <div>Vault ID: <span className="font-mono text-white/70">{vId || "—"}</span></div>
            <div>Created On: <span className="font-mono text-white/70">{fmtCreated(created)}</span></div>
          </div>
        </div>
      );
    }

    // REBALANCE
    if (row.kind === "rebalance") {
      const s = row.data as RebalanceSet;
      const vId = stableRebalanceVaultIdRef.current[s.id] || vaultMap[s.id] || s.vaultId || null;
      const hasVault = !!vId;
      const lockToken1ToSOL = lockToken1ToSOLForSet(s.id, hasVault);

      // Normalize tokens
      let rowMints = Array.isArray(s.mints) && s.mints.length ? uniqueMints(s.mints) : [MINT_SOL, MINT_USDC];
      if (lockToken1ToSOL && !hasVault) {
        // Enforce SOL at index 0 during creation only
        rowMints = uniqueMints([MINT_SOL, ...rowMints.filter((m) => m !== MINT_SOL)]);
      }
      // Ensure at least 2 tokens
      if (rowMints.length < 2) {
        const fallback = (lockToken1ToSOL && !hasVault) ? MINT_USDC : (rowMints[0] === MINT_USDC ? MINT_SOL : MINT_USDC);
        rowMints = uniqueMints([...(rowMints), fallback]).slice(0, 2);
      }
      // Cap to Pro/Free max
      if (rowMints.length > MAX_TOKENS) rowMints = rowMints.slice(0, MAX_TOKENS);

      const created = row.createdAt;
      const title = rebalanceTitle({ ...s, mints: rowMints }, tokMap);
      const cadence = (s.cadence || "6h") as Cadence;

      return (
        <div key={`r-${s.id}`} className="mb-6 rounded-2xl border border-white/10 bg-[#1D1D1D] p-4 ring-1 ring-brandPurple/30 shadow-md shadow-brandPurple/20">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-base font-semibold"><GradientTitle kind="rebalance" defaultTitle={title} /></div>
            {(() => {
              const vId = stableRebalanceVaultIdRef.current[s.id] || vaultMap[s.id] || s.vaultId || null;
              const agg = (aggregatesRef.current || {})[s.id];
              const hasVault = !!vId;
              const hasAgg = !!agg;
              const hasNumericBalance = hasAgg && typeof agg.vaultUsdTotal === "number";
              const bal = hasNumericBalance ? agg.vaultUsdTotal : 0;
              const isRunning = !!(agg && agg.running);
              // Rebalance safety: only allow delete when we *know* there is no balance
              // and the bot is not running. Sets without a vault remain freely deletable.
              const safeVaultOK =
                !hasVault ||
                (hasAgg && hasNumericBalance && bal === 0 && !isRunning);
              const canDelete = !!deletableMap[s.id] && safeVaultOK;
              return canDelete;
            })() ? (
              <button
                onClick={() => deleteSet("rebalance", s.id)}
                title="Delete Set"
                aria-label="Delete Set"
                className="rounded-md border border-red-400/60 bg-red-900/20 px-2 py-0.5 text-[10px] font-medium text-red-300 hover:bg-red-500/20"
              >
                x
              </button>
            ) : null}
          </div>

          {/* Token pickers — SOL locked only for Free; HIDE after vault */}
          <div className={(hasVault ? "hidden " : "") + "grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3"}>
            {initialReady ? (
              <>
                {rowMints.map((mint, idx) => (
                  <div key={idx} className="min-w-0">
                    <div className="mb-1 text-xs text-white/60">
                      {idx === 0 ? (lockToken1ToSOL ? "Token 1 (locked to SOL)" : "Token 1") : `Token ${idx + 1}`}
                    </div>
                    <TokenPicker
                      key={`${s.id}-${idx}-${mint}-${hasVault ? "locked" : "free"}`}
                      locked={(lockToken1ToSOL && idx === 0) || hasVault}
                      value={(lockToken1ToSOL && idx === 0) ? MINT_SOL : mint}
                      onChange={async (m) => {
                        if ((lockToken1ToSOL && idx === 0) || hasVault) return;
                        const next = rowMints.slice();
                        next[idx] = (m || "").trim();
                        // Prevent duplicates
                        const seen = new Set<string>();
                        const dedup: string[] = [];
                        for (const x of next) {
                          const k = String(x || "").trim();
                          if (!k || seen.has(k)) continue;
                          seen.add(k);
                          dedup.push(k);
                        }
                        /* keep exact count; don't auto-add a new picker */
                        setRebalanceSets((prev) => prev.map((r) => (r.id === s.id ? { ...r, mints: dedup } : r)));
                        await persistRebalancePart(s.id, { mints: dedup });
                      }}
                      initialTokens={initialTokens}
                    />
                  </div>
                ))}
              </>
            ) : (
              <>
                <div className="h-10 rounded-md bg-white/5 animate-pulse" />
                <div className="h-10 rounded-md bg-white/5 animate-pulse" />
                <div className="h-10 rounded-md bg-white/5 animate-pulse" />
              </>
            )}
          </div>

          {/* Add / Remove (HIDE when locked) */}
          <div className={"mt-3 flex items-center gap-3 " + (hasVault ? "hidden" : "")}>
            {rowMints.length < MAX_TOKENS ? (
              <button
                type="button"
                disabled={hasVault || rowMints.length >= MAX_TOKENS || ((rebalanceSaving[s.id]?.mints || 0) > 0)}
                aria-disabled={hasVault || rowMints.length >= MAX_TOKENS || ((rebalanceSaving[s.id]?.mints || 0) > 0)}
                className={
                  "rounded-full px-3 py-1 text-sm font-semibold " +
                  ((hasVault || ((rebalanceSaving[s.id]?.mints || 0) > 0)) ? "bg-brandMint/40 text-white/40 cursor-not-allowed" : "bg-brandMint hover:bg-brandMint")
                }
                title={hasVault ? "locked after vault creation — delete set to change" : undefined}
                onClick={async () => {
                  if (hasVault) return;
                  const current = uniqueMints(rowMints);
                  if (current.length >= MAX_TOKENS) return;
                  let next = current.slice();
                  const pick = nextAvailableMint(next, topTokens);
                  if (!next.includes(pick)) next.push(pick);
                  next = (lockToken1ToSOL ? uniqueMints([MINT_SOL, ...next.filter((m) => m !== MINT_SOL)]) : uniqueMints(next)).slice(0, MAX_TOKENS);
                  setRebalanceSets((prev) => prev.map((r) => (r.id === s.id ? { ...r, mints: next } : r)));
                  await persistRebalancePart(s.id, { mints: next });
                }}
              >
                +
              </button>
            ) : null}

            {rowMints.length > 2 ? (
              <button
                type="button"
                disabled={hasVault || rowMints.length <= 2 || ((rebalanceSaving[s.id]?.mints || 0) > 0)}
                aria-disabled={hasVault || rowMints.length <= 2 || ((rebalanceSaving[s.id]?.mints || 0) > 0)}
                className={
                  "rounded-full px-3 py-1 text-sm font-semibold " +
                  ((hasVault || ((rebalanceSaving[s.id]?.mints || 0) > 0)) ? "bg-rose-900/40 text-white/40 cursor-not-allowed" : "bg-rose-600 hover:bg-rose-500")
                }
                title={hasVault ? "locked after vault creation — delete set to change" : undefined}
                onClick={async (ev) => {
                  // iOS 12/13 double-fire guard
                  try {
                    const __t: any = (ev && (ev as any).currentTarget) || null;
                    if (__t) {
                      const now = Date.now();
                      if (typeof (__t as any).__mmClickRanAt === "number" && now - ( __t as any ).__mmClickRanAt < 700) {
                        return;
                      }
                      try { (__t as any).__mmClickRanAt = now; } catch {}
                    }
                  } catch {}
                  if (hasVault) return;
                  if (rowMints.length <= 2) return;
                  const next = rowMints.slice(0, rowMints.length - 1);
                  const fixed = lockToken1ToSOL ? uniqueMints([MINT_SOL, ...next.filter((m) => m !== MINT_SOL)]) : uniqueMints(next);
                  setRebalanceSets((prev) => prev.map((r) => (r.id === s.id ? { ...r, mints: fixed } : r)));
                  await persistRebalancePart(s.id, { mints: fixed });
                }}
              >
                −
              </button>
            ) : null}
          </div>

          {/* Cadence (HIDE completely when locked) */}
          {!hasVault && (
            <div className="mt-3">
              <div className="mb-1 text-xs text-white/60">Cadence</div>
              <div className="flex flex-wrap items-center gap-2">
                {(cadenceOptions as ReadonlyArray<Cadence>).map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={hasVault || ((rebalanceSaving[s.id]?.cadence || 0) > 0)}
                    aria-disabled={hasVault || ((rebalanceSaving[s.id]?.cadence || 0) > 0)}
                    onClick={async () => {
                      if (hasVault || ((rebalanceSaving[s.id]?.cadence || 0) > 0)) return;
                      setRebalanceSets((prev) => prev.map((r) => (r.id === s.id ? { ...r, cadence: c } : r)));
                      optimisticRebalanceRef.current[s.id] = { ...(optimisticRebalanceRef.current[s.id] || {}), cadence: c };
                      await persistRebalancePart(s.id, { cadence: c });
                    }}
                    className={
                      "px-3 py-1.5 rounded-xl border text-sm " +
                      (cadence === c ? "border-brandPink bg-brandPink/20" : "border-white/10 hover:border-white/20") +
                      ((hasVault || ((rebalanceSaving[s.id]?.cadence || 0) > 0)) ? " opacity-50 cursor-not-allowed" : "")
                    }
                  >
                    {(() => { const n = Number(String(c).replace(/h$/,"")); return Number.isFinite(n) ? `${n} ${n === 1 ? "Hour" : "Hours"}` : String(c); })()}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Inline vault panel or Create Vault */}
          <div className="mt-3">
            {vId ? (
              <RebalanceInlinePanel
                setId={s.id}
                walletShim={panelWalletShimStable as any}
                vaultAddress={vId || undefined}
                mints={rowMints}
                cadence={cadence}
                createdAt={created}
                showLoadingPlaceholders={equityCommittedUsd == null}
                onResolvedSymbols={(map) => setDexSymbolMap((prev) => ({ ...prev, ...map }))}
                onState={(info) => {
                  // IMPORTANT (Android WebView stability):
                  // Rebalance panel can pass through transient "loading" states after deposit/withdraw where
                  // its totals are temporarily undefined/zero while RPC catches up. If we forward those 0s to
                  // the hub, the card can momentarily reorder/vanish (looks like an unmount/flicker).
                  // Mirror VaultInlinePanel behavior by:
                  //  - keeping last-known totals while balances are not ready
                  //  - only bumping the hub tick if something materially changed
                  const prev = aggregatesRef.current[s.id];
                  const balancesReady = info?.balancesReady;

                  const nextVaultUsdTotal = (() => {
                    const v = (info as any)?.vaultUsdTotal;
                    if (typeof v === "number" && Number.isFinite(v)) return v;
                    // Hold last known value during refresh windows to prevent "0" pulses.
                    return typeof prev?.vaultUsdTotal === "number" ? prev.vaultUsdTotal : 0;
                  })();
                  const nextVaultUiSum = (() => {
                    const v = (info as any)?.vaultUiSum;
                    if (typeof v === "number" && Number.isFinite(v)) return v;
                    return typeof prev?.vaultUiSum === "number" ? prev.vaultUiSum : 0;
                  })();

                  const next = {
                    running: (info as any)?.status === "running" ? true : ((info as any)?.status === "stopped" ? false : (prev?.running ?? false)),
                    vaultUsdTotal: (balancesReady === false) ? (prev?.vaultUsdTotal ?? nextVaultUsdTotal) : nextVaultUsdTotal,
                    vaultUiSum: (balancesReady === false) ? (prev?.vaultUiSum ?? nextVaultUiSum) : nextVaultUiSum,
                    equityReady: (info as any)?.equityReady,
                    balancesReady,
                    hasVault: true,
                    ts: Date.now(),
                  };
                  aggregatesRef.current[s.id] = next;

                  let changed = true;
                  if (prev) {
                    changed = !(
                      prev.running === next.running &&
                      Object.is(prev.vaultUsdTotal, next.vaultUsdTotal) &&
                      Object.is((prev.vaultUiSum ?? null), (next.vaultUiSum ?? null)) &&
                      (prev.equityReady ?? null) === (next.equityReady ?? null) &&
                      (prev.balancesReady ?? null) === (next.balancesReady ?? null) &&
                      (prev.hasVault ?? null) === (next.hasVault ?? null)
                    );
                  }
                  if (changed) bumpEquityTick();
                }}
              />
            ) : (
              <div className="flex flex-col items-stretch gap-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-white/60">Create a vault and fund with SOL to enable rebalancing.</div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-full border border-brandPurple/20 bg-brandPurple/15 hover:border-brandPurple/30 transition-colors"
                    type="button"
                    style={{ touchAction: "manipulation", WebkitTransform: "translateZ(0)" }}
                    onClick={async (ev) => {
                      // iOS 12/13 double-fire guard
                      try {
                        const __t: any = (ev && (ev as any).currentTarget) || null;
                        if (__t) {
                          const now = Date.now();
                          if (typeof (__t as any).__mmClickRanAt === "number" && now - ( __t as any ).__mmClickRanAt < 700) {
                            return;
                          }
                          try { (__t as any).__mmClickRanAt = now; } catch {}
                        }
                      } catch {}
                      setRebalanceCreateErr((prev) => ({ ...prev, [s.id]: "" }));
                      try {
                        const res = await createVaultForSet(
                          { publicKey, sendTransaction, signTransaction } as any,
                          s.id,
                          rowMints[0],
                          rowMints[1] || MINT_USDC,
                          // Prewarm ALL vault-authority ATAs for the rebalance basket (user pays once).
                          // This prevents the relayer from later paying rent when a new mint enters the basket.
                          rowMints
                        );
                        const vault = (res && (res as any).vault) ? String((res as any).vault) : "";
                        if (!vault) {
                          setRebalanceCreateErr((prev) => ({ ...prev, [s.id]: "Vault creation returned no vault address." }));
                          return;
                        }
                        try {
                          
                        // Collect the exact picker logos for this set (sticky across refresh)
                        const __mmLogos = (() => {
                          try {
                            const g: any = (window as any);
                            const mmPick = (g && g.mmPickerLogos) || {};
                            const mmTok  = (g && g.mmTokenLogos) || {};
                            let ls: any = {};
                            try { ls = JSON.parse(localStorage.getItem("mmPickerLogos") || "{}"); } catch {}
                            const out: Record<string, string> = {};
                            const reqMints = [rowMints[0], rowMints[1] || MINT_USDC].filter(Boolean);
                            for (const m of reqMints) {
                              const u = (mmPick && mmPick[m]) || (mmTok && mmTok[m]) || (ls && ls[m]) || "";
                              if (u && /^https?:\/\//i.test(String(u))) out[m] = String(u);
                            }
                            return out;
                          } catch { return {}; }
                        })();
const r2 = await fetch(`/api/rebalance/vault/create`, {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              "x-wallet": wallet,
                              "x-idempotency-key": `${s.id}-vault-create`,
                            },
                            body: JSON.stringify({ id: s.id, setId: s.id, wallet, vault, logos: __mmLogos }),
                          });
                          const j2 = await r2.json().catch(() => ({} as any));
                          const returnedVault = String(j2?.vaultId || j2?.vaultAddress || j2?.vault || vault);
                          setVaultMap((prev) => ({ ...prev, [s.id]: returnedVault }));
                          setRebalanceSets((prev) =>
                            prev.map((row) =>
                              row.id === s.id ? { ...row, vaultId: returnedVault, frozen: true } : row
                            )
                          );
                        } catch (err) {
                          setVaultMap((prev) => ({ ...prev, [s.id]: vault }));
                          setRebalanceSets((prev) =>
                            prev.map((row) => (row.id === s.id ? { ...row, vaultId: vault, frozen: true } : row))
                          );
                        }
                        loadAll().catch(() => {});
                      } catch (e: any) {
                        console.error("createVault (rebalance) error", e);
                        setRebalanceCreateErr((prev) => ({ ...prev, [s.id]: (e && e.message) ? String(e.message) : "Vault creation failed." }));
                      }
                    }}
                  >
                    Create Vault
                  </Button>
                </div>
                <div className="mt-0.5 text-[10px] leading-3 text-red-400 min-h-[0.8rem]">
                  {rebalanceCreateErr[s.id] ? `Error: ${rebalanceCreateErr[s.id]}` : ""}
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 flex flex-col items-start gap-1 text-[11px] text-white/60">
            <div><span className="text-white/40">set id:</span> <span className="font-mono">{String(s.id || "").replace(/-/g, "")}</span></div>
            <div><span className="text-white/40">vault id:</span> <span className="font-mono">{vId || "—"}</span></div>
            <div><span className="text-white/40">created on:</span> <span className="font-mono">{fmtCreated(s.createdAt)}</span></div>
          </div>
        </div>
      );
    }
  }

  // -------------------------------
  // UI
  // -------------------------------
  if (!wallet) {
    return (
    <div className="min-h-screen w-full bg-black" style={{ backgroundColor: "#000000", backgroundImage: "none", ...(__mmIsIOS ? { minHeight: "var(--mm-vh, 100vh)" } : {}) }}>
        <main className="mx-auto w-full max-w-5xl px-4 py-8 relative overflow-hidden" style={{ backgroundImage: "none" }}>
<section className="mb-8">
          <div className="rounded-2xl border border-white/10 bg-[#1D1D1D] p-8 text-center">
            <div className="mb-3 text-2xl font-extrabold md:text-3xl">
              <span className="bg-gradient-to-r from-brandPink to-brandPurple bg-clip-text text-transparent align-middle">
                Application
              </span>
            </div>
            <p className="mb-6 text-sm text-slate-300">
              Connect your wallet to view and manage your bots.
            </p>
            <div className="mt-2 flex items-center justify-center">
              <button
                type="button"
                onClick={() => {
                  try {
                    if (typeof window !== "undefined") {
                      const headerConnect = (window as any).__mmHeaderConnectWallet;
                      if (typeof headerConnect === "function") {
                        headerConnect();
                        return;
                      }
                    }

                    if (!connecting && selectedWallet) {
                      try {
                        const p = connect();
                        void p.catch(() => {});
                      } catch {}
                      return;
                    }

                    markPendingUserConnect();
                    if (typeof setVisible === "function") setVisible(true);
                  } catch {}
                }}
                className="rounded-full border border-brandPurple/30 bg-brandPurple/15 px-5 py-2 text-sm font-medium tracking-wide hover:bg-brandPurple/20 hover:border-brandPurple/40 transition-colors md:px-6 md:py-2.5 md:text-base"
              >
                Connect Wallet
              </button>
            </div>
            {mwaConnectStatus ? (
              <div className="mt-3 mx-auto max-w-md rounded-xl border border-white/10 bg-white/5 p-3 text-left text-xs text-white/75">
                <div className="font-semibold text-white">{mwaConnectBusy ? "Opening wallet…" : "Wallet connection status"}</div>
                <div className="mt-1">{mwaConnectStatus}</div>
              </div>
            ) : null}
          </div>
        </section>
      </main>
      </div>
    );
  }

  if (!humanOK) {
    return <div className="min-h-screen w-full bg-black" style={{ backgroundColor: "#000000", backgroundImage: "none", ...(__mmIsIOS ? { minHeight: "var(--mm-vh, 100vh)" } : {}) }}><HumanCheckGate
      onVerified={(ttlMs) => {
        try {
          const until = Date.now() + (typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : 6 * 60 * 60 * 1000);
          if (typeof window !== "undefined") localStorage.setItem("mm_turnstile_ok_ts", String(until));
        } catch { /* ignore */ }
        setHumanOK(true);
      }}
    /></div>;
  }

  return (
    <div className="min-h-screen w-full bg-black" style={{ backgroundColor: "#000000", backgroundImage: "none", ...(__mmIsIOS ? { minHeight: "var(--mm-vh, 100vh)" } : {}) }}>
      <main className="mx-auto w-full max-w-5xl px-4 py-8 relative overflow-hidden" style={{ backgroundImage: "none" }}>
      <DisclaimerModal walletAddress={publicKey?.toBase58()} />

      <section className="mb-8">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="min-w-0 truncate whitespace-nowrap text-[10px] sm:text-xs md:text-sm text-white/70">
            <span className="text-white/50">Wallet: </span>
            <span className="font-mono">{walletDisplay}</span>
          </div>

          <div className="flex flex-col items-center justify-center">
            {canCreate ? (
              <Button
                onClick={async () => { await ensureWalletSession(); setOpenCreate(true); }}
                variant="ghost"
                className="group flex flex-col items-center justify-center bg-transparent p-0 shadow-none hover:bg-transparent focus-visible:ring-0"
              >
                <span
                  className="relative flex h-20 w-20 items-center justify-center rounded-full bg-[rgba(10,42,34,0.92)] ring-1 ring-[rgba(27,253,178,0.22)] shadow-[0_0_0_1px_rgba(27,253,178,0.08),0_18px_40px_rgba(0,0,0,0.55),0_0_26px_rgba(27,253,178,0.10)] transition-[box-shadow,background-color,transform] duration-200 will-change-transform group-hover:bg-[rgba(12,56,44,0.92)] group-hover:shadow-[0_0_0_1px_rgba(27,253,178,0.12),0_22px_48px_rgba(0,0,0,0.58),0_0_34px_rgba(27,253,178,0.16)] group-active:scale-[0.98] md:h-24 md:w-24"
                  aria-hidden
                >
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 44 44"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className="drop-shadow-[0_0_12px_rgba(27,253,178,0.20)]"
                  >
                    <path
                      d="M22 10V34"
                      stroke="#1BFDB2"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                    <path
                      d="M10 22H34"
                      stroke="#1BFDB2"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                <span className="mt-3 text-sm font-medium tracking-wide text-brandWhite/90 md:text-base">

                </span>
              </Button>
            ) : (
              <Button
                variant="ghost"
                disabled
                className="group flex flex-col items-center justify-center bg-transparent p-0 opacity-50 shadow-none hover:bg-transparent focus-visible:ring-0"
                title="bot limit reached"
              >
                <span
                  className="relative flex h-20 w-20 items-center justify-center rounded-full bg-[rgba(10,42,34,0.65)] ring-1 ring-white/10 md:h-24 md:w-24"
                  aria-hidden
                >
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 44 44"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M22 10V34"
                      stroke="#FAFAFA"
                      strokeWidth="4"
                      strokeLinecap="round"
                      opacity="0.55"
                    />
                    <path
                      d="M10 22H34"
                      stroke="#FAFAFA"
                      strokeWidth="4"
                      strokeLinecap="round"
                      opacity="0.55"
                    />
                  </svg>
                </span>
              </Button>
            )}
            {/* Centered Total Equity pill under Create Bot */}
            <div className="mt-4 flex justify-center sm:mt-4">
              <div className="inline-flex items-baseline gap-2 rounded-full border border-brandPink/25 bg-brandPink/10 px-3 py-1 shadow-[0_0_0_1px_rgba(253,27,119,0.14),0_0_12px_rgba(253,27,119,0.16)]">
                <span className="text-[10px] sm:text-xs text-brandPink/90">Total Equity</span>
                <span className="font-mono text-[12px] sm:text-sm text-white/95">{totalEquityLabel}</span>
              </div>
            </div>
          </div>

          <div className="min-w-0 text-right text-[10px] sm:text-xs md:text-sm text-white/60">
            {/* Desktop: keep everything on one line (truncate if needed) */}
            <div className="sm:truncate sm:whitespace-nowrap">
              Total Bots: {aggregated.length} / {BOT_LIMIT}
</div>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <div className="mb-3 text-sm text-slate-300">  </div>
        {loading && aggregated.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-6 text-sm text-slate-300">
            Loading…
          </div>
        ) : (
          aggregated.slice(0, renderCount).map((row) => renderInline(row))
        )}
      </section>

      <section className="mb-16">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="mb-2 text-sm text-white/80">metrics</div>
            {showMetrics ? <MetricsPanel key={metricsPanelKey} /> : (
              <div className="text-sm text-slate-400">Loading metrics…</div>
            )}
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="mb-2 text-sm text-white/80">activity</div>
            <ActivityPanel />
          </div>
        </div>
      </section>

      <CreateBotModal
        open={openCreate}
        wallet={wallet}
        onClose={() => setOpenCreate(false)}
        onCreated={(kind, set) => {
          if (!set) return;
          if (kind === "webhook") {
            const s: WebhookSet = {
              setId: String(set?.setId || set?.id || ""),
              wallet,
              prefs: typeof set?.prefs === "object" ? set.prefs : {},
              buyId: typeof set?.buyId === "string" ? set.buyId : undefined,
              sellId: typeof set?.sellId === "string" ? set.sellId : undefined,
              urls: set?.urls && typeof set.urls === "object" ? { buy: String(set.urls.buy || ""), sell: String(set.urls.sell || "") } : undefined,
              createdAt: tsFromCreated(set),
              createdOn: typeof set?.createdOn === "string" ? set.createdOn : undefined,
            };
            setWebhookSets((prev) => {
              const seen = new Set(prev.map((p) => p.setId));
              return seen.has(s.setId) ? prev : [s, ...prev];
            });
            try {
              void saveWebhookPrefs(
                s.setId,
                { mintIn: MINT_SOL, mintOut: MINT_USDC },
                { address: MINT_USDC, symbol: "USDC", logoURI: fallbackLogoUri(MINT_USDC) }
              );
            } catch {}
          } else if (kind === "rebalance") {
            const r: RebalanceSet = {
              id: String(set?.id || set?.setId || ""),
              wallet,
              mints: Array.isArray(set?.mints) ? set.mints : [],
              cadence: normalizeCadence(set?.cadence),
              createdAt: tsFromCreated(set),
              vaultId: typeof set?.vaultId === "string" ? set.vaultId : null,
              frozen: !!set?.frozen,
            };
            setRebalanceSets((prev) => {
              const seen = new Set(prev.map((p) => p.id));
              return seen.has(r.id) ? prev : [r, ...prev];
            });
          }
          setTimeout(() => { loadAll().catch(() => {}); }, 10);
        }}
      />
    </main>
    </div>
  );
}

// -------------------------------
// Tiny helpers (keep in sync with server)
// -------------------------------
function normalizeCadence(v: any): Cadence {
  const k = String(v || "").toLowerCase();
  if (k === "1h" || k === "2h" || k === "6h" || k === "12h" || k === "24h") return k as Cadence;
  return "6h";
}
