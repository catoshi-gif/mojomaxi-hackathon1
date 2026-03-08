// filepath: src/app/api/tokens/search/route.ts
// FULL FILE REPLACEMENT for: src/app/api/tokens/search/route.ts
// Fix: robust `limit` parsing so blank/zero/invalid `limit` defaults to 10 (not 1).
// Keep: multi-source fetch, caching, inflight coalescing, verified-first ordering,
//       live-search + toptraded fallbacks, response shape.
//
// Response shape preserved: { ok, tokens, items }

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JUP_API_KEY = (process.env.JUP_API_KEY || process.env.JUPITER_API_KEY || "").trim();
function jupHeadersForUrl(url: string): Record<string, string> {
  // Preserve existing behavior (user-agent) and add x-api-key ONLY when hitting api.jup.ag endpoints.
  const h: Record<string, string> = { "user-agent": "mojomaxi/1.0 (+token-search)" };
  if (JUP_API_KEY && /^https?:\/\/api\.jup\.ag\b/i.test(url)) {
    h["x-api-key"] = JUP_API_KEY;
    h["accept"] = "application/json";
  }
  return h;
}


type AnyObj = Record<string, any>;
type Token = {
  address: string;
  mint?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  verified?: boolean;
  tags?: string[];
};

// --- Upstream sources (order matters; we stop on the first healthy, non-trivial list) ---
const SOURCES = [
  // Jupiter Lite v2 token meta
  "https://api.jup.ag/tokens/v2",
  // Jupiter canonical token list
  "https://token.jup.ag/all",
  // Legacy mirror that some setups still use
  "https://tokens.jup.ag/tokens",
];

// Lite v2 base, used for live search + toptraded fallback
const LITE_BASE = "https://api.jup.ag/tokens/v2";

// --- Module-scoped caches (per Lambda instance) ---
const TOKENS_TTL_MS = 10 * 60 * 1000; // 10 minutes
let TOKENS_CACHE: { at: number; list: Token[] } | null = null;
const INFLIGHT_BY_KEY = new Map<string, Promise<Response>>();

// local utils
function now() { return Date.now(); }
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function normalizeMint(addr?: string | null): string { return String(addr || "").trim(); }

function isVerified(t: AnyObj): boolean {
  const v = t?.verified ?? t?.isVerified ?? t?.jupVerified;
  if (typeof v === "boolean") return v;
  const tags: string[] = Array.isArray(t?.tags) ? t.tags : [];
  if (tags.some((x) => typeof x === "string" && x.toLowerCase().includes("verified"))) return true;
  return false;
}

function normalizeToken(raw: AnyObj): Token | null {
  const address = normalizeMint(raw?.mint ?? raw?.address ?? raw?.id ?? raw?.tokenAddress);
  if (!address) return null;
  const tok: Token = {
    address,
    mint: address,
    symbol: typeof raw?.symbol === "string" ? raw.symbol : undefined,
    name: typeof raw?.name === "string" ? raw.name : (typeof raw?.symbol === "string" ? raw.symbol : undefined),
    decimals: typeof raw?.decimals === "number" ? raw.decimals : undefined,
    logoURI: String(raw?.logoURI ?? raw?.logoUri ?? raw?.icon ?? raw?.logo ?? "").trim() || undefined,
    verified: isVerified(raw),
    tags: Array.isArray(raw?.tags) ? raw.tags : undefined,
  };
  return tok;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => { try { ctrl.abort(); } catch {} }, clamp((ms as number)|0, 2000, 15000));
  try {
    return await fetch(url, {
      headers: jupHeadersForUrl(url),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(id);
  }
}

// ---- Full token list retrieval + caching ----
async function fetchAllTokens(): Promise<Token[]> {
  if (TOKENS_CACHE && now() - TOKENS_CACHE.at < TOKENS_TTL_MS) {
    return TOKENS_CACHE.list;
  }

  let list: Token[] = [];

  // Try sources in order until we get a reasonably sized list
  for (const src of SOURCES) {
    try {
      const r = await fetchWithTimeout(src, 12000);
      const text = await r.text();
      let json: any;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      // Accept arrays and maps
      let rows: AnyObj[] | null = null;
      if (Array.isArray(json)) rows = json;
      else if (Array.isArray(json?.data)) rows = json.data;
      else if (Array.isArray(json?.tokens)) rows = json.tokens;
      else if (json && typeof json === "object") {
        // Sometimes tokens are served as a map keyed by mint address
        const vals = Object.values(json);
        if (vals.length && typeof vals[0] === "object") rows = vals as AnyObj[];
      }

      const byMint = new Map<string, Token>();
      for (const row of rows || []) {
        const tok = normalizeToken(row);
        if (tok && !byMint.has(tok.address)) byMint.set(tok.address, tok);
      }
      list = Array.from(byMint.values());

      // Require a non-trivial list (many tokens). If tiny, continue to next source.
      if (list.length >= 500) break;
    } catch {
      // Try the next source
      continue;
    }
  }

  // Cache even if list is small but non-empty to avoid hammering upstream.
  if (list.length === 0) {
    // As a last fallback, keep the cache empty but short-lived.
    TOKENS_CACHE = { at: now() - (TOKENS_TTL_MS - 30_000), list: [] };
  } else {
    TOKENS_CACHE = { at: now(), list };
  }
  return list;
}

// ---- Local filter ----
function filterTokens(list: Token[], q: string, limit: number): Token[] {
  const query = q.trim();
  if (!query) return [];
  const ql = query.toLowerCase();
  const byMint = new Map<string, Token>();

  // If query looks like a mint address, prefer exact/equal matches and contains
  if (query.length >= 24) {
    for (const t of list) {
      const mint = normalizeMint(t.address || t.mint);
      if (!mint) continue;
      const lm = mint.toLowerCase();
      if (lm === ql) { byMint.set(mint, t); continue; }
      if (lm.includes(ql)) byMint.set(mint, t);
      if (byMint.size >= limit * 3) break; // early stop to keep CPU light
    }
  }

  // Match on symbol/name
  for (const t of list) {
    const mint = normalizeMint(t.address || t.mint);
    if (!mint) continue;
    const sym = String(t.symbol || "").toLowerCase();
    const name = String(t.name || "").toLowerCase();
    if (sym.includes(ql) || name.includes(ql)) byMint.set(mint, t);
    if (byMint.size >= limit * 5) break; // early stop
  }

  // stable order: verified first, then others — cap to `limit` to keep it light on mobile
  const vals = Array.from(byMint.values());
  const tokens = [
    ...vals.filter((t) => t.verified === true),
    ...vals.filter((t) => t.verified !== true),
  ].slice(0, limit);
  return tokens;
}

// ---- Fallbacks ----
async function liteSearch(q: string, limit: number): Promise<Token[]> {
  const query = q.trim();
  if (!query) return [];
  const encoded = encodeURIComponent(query);
  // Keep upstream small but allow a bit more than `limit` to rank/verify
  const remoteLimit = Math.min(100, Math.max(limit, limit * 3));
  const urls = [
    `${LITE_BASE}/search?query=${encoded}&limit=${remoteLimit}`,
    `${LITE_BASE}?q=${encoded}&limit=${remoteLimit}`, // observed alt shape on some mirrors
  ];

  const byMint = new Map<string, Token>();

  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, 12000);
      if (!r.ok) continue;
      const text = await r.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      let rows: AnyObj[] = [];
      if (Array.isArray(json)) rows = json;
      else if (Array.isArray(json?.items)) rows = json.items;
      else if (Array.isArray(json?.data)) rows = json.data;
      else if (json && typeof json === "object") {
        const vals = Object.values(json);
        if (vals.length && typeof vals[0] === "object") rows = vals as AnyObj[];
      }
      for (const row of rows) {
        const tok = normalizeToken(row);
        if (tok && tok.mint) byMint.set(tok.mint, tok);
        if (byMint.size >= limit * 4) break;
      }
      if (byMint.size > 0) break; // got results from one of the endpoints
    } catch {
      // try next url
    }
  }

  const vals = Array.from(byMint.values());
  const tokens = [
    ...vals.filter((t) => t.verified === true),
    ...vals.filter((t) => t.verified !== true),
  ].slice(0, limit);
  return tokens;
}

async function topTradedFilter(q: string, limit: number): Promise<Token[]> {
  const query = q.trim();
  if (!query) return [];
  const ql = query.toLowerCase();
  // Bound upstream to a moderate size; default 10 -> 100 rows
  const remoteLimit = Math.min(200, Math.max(50, limit * 10));
  try {
    const r = await fetchWithTimeout(`${LITE_BASE}/toptraded/24h?limit=${remoteLimit}`, 12000);
    if (!r.ok) return [];
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    const arr: AnyObj[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    const byMint = new Map<string, Token>();
    for (const row of arr || []) {
      const tok = normalizeToken(row);
      if (!tok) continue;
      const hay = `${tok.symbol || ""} ${tok.name || ""} ${tok.mint || tok.address || ""}`.toLowerCase();
      if (hay.includes(ql)) byMint.set(tok.mint || tok.address!, tok);
      if (byMint.size >= limit * 4) break;
    }
    const vals = Array.from(byMint.values());
    const tokens = [
      ...vals.filter((t) => t.verified === true),
      ...vals.filter((t) => t.verified !== true),
    ].slice(0, limit);
    return tokens;
  } catch {
    return [];
  }
}

function jsonResponse(body: any): Response {
  const res = NextResponse.json(body);
  // Let browsers/CDNs cache briefly; UI also debounces requests
  res.headers.set("Cache-Control", "public, max-age=5, s-maxage=30, stale-while-revalidate=300");
  return res;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Accept both q and query for maximum compatibility
  const qRaw = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
  // Hard clamp to prevent abuse / huge cache keys
  const q = qRaw.length > 64 ? qRaw.slice(0, 64) : qRaw;

  // Robust `limit` parsing: only use client-provided limit if it's a positive integer;
  // otherwise fall back to 10. This avoids the "" -> 0 case that previously clamped to 1.
  const rawLimit = url.searchParams.get("limit");
  let limit = 10;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    const n = parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n > 0) {
      limit = clamp(n, 1, 100);
    }
  }

  const key = `q=${q.toLowerCase() || "-"}&limit=${limit}`;

  // Coalesce duplicate inflight queries
  const inflight = INFLIGHT_BY_KEY.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      // 1) Use cached full token list and do local filtering (fast path)
      const list = await fetchAllTokens();
      let tokens = filterTokens(list, q, limit);

      // 2) If nothing matched locally, hit Lite v2 live search (network light)
      if (tokens.length === 0) {
        tokens = await liteSearch(q, limit);
      }

      // 3) As a last resort, pull top-traded and filter locally (still bounded and cached upstream)
      if (tokens.length === 0) {
        tokens = await topTradedFilter(q, limit);
      }

      return jsonResponse({ ok: true, tokens, items: tokens });
    } catch {
      return jsonResponse({ ok: true, tokens: [], items: [] });
    } finally {
      INFLIGHT_BY_KEY.delete(key);
    }
  })();

  INFLIGHT_BY_KEY.set(key, p);
  return p;
}
