// filepath: src/app/api/token-logos/[mint]/route.ts
/**
 * Token logo proxy with Upstash-backed metadata cache + robust discovery and TokenPicker backfill.
 * Treats ALL tokens equally (no brand fallbacks).
 *
 * Resolution order:
 *  1) Upstash JSON (mm:cache:v1:token:meta:<mint>) → meta.logoURI/icon/logoUri
 *  2) Jupiter Lite token meta (exact by mint → search) → persist
 *  3) Jupiter Icons (multiple paths) → persist
 *  4) DexScreener token API (baseToken/quoteToken logo/icon/imageUrl **matching the mint** & URL path contains the mint) → persist
 *  5) Birdeye CDN  (https://cdn.birdeye.so/icon/<mint>?size=64) → persist
 *  6) TrustWallet (https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains/solana/assets/<mint>/logo.png) → persist
 *  7) TokenPicker backfill: call /api/tokens?mints=<mint>, wait for JSON, re-read cache, redirect if found
 *  8) Last resort: return 1×1 transparent PNG with **no-store** so it won’t stick after we later discover a logo
 *
 * Successful redirects add a one-time cache-busting query `mmv=<epochMinute>` to avoid stale blank artifacts.
 *
 * NOTE: DexScreener integration is **mint-strict**: we will only ever accept a logo from DexScreener
 * if it is attached to a token object (baseToken/quoteToken) whose address exactly matches the mint,
 * and the returned URL's pathname contains the mint string (to avoid pair-level/other-token images).
 * We intentionally ignore generic pair-level images (pairs[].info.imageUrl), as those can belong to
 * the wrong side of the pair and cause obviously incorrect logos in the UI.
 *
 * Node runtime to match Upstash client usage.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { cacheKey, cacheGetJSON, cacheSetJSON } from "@/lib/cache.server";
import { redis } from "@/lib/redis";
import { isIP } from "node:net";

type AnyObj = Record<string, any>;

const TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const STALE_SEC = 60 * 60 * 24 * 7; // 7 days

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (!/^https?:\/\//i.test(s)) return false;
  return isSafeExternalHttpUrl(s);
}

function isSafeExternalHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const host = (url.hostname || "").toLowerCase();
    if (!host) return false;

    // Block obvious local/internal hosts.
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (host === "0.0.0.0") return false;

    const ipVer = isIP(host);
    if (ipVer === 4) {
      const parts = host.split(".").map((x) => Number(x));
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
      const [a, b] = parts;
      if (a === 10) return false;
      if (a === 127) return false;
      if (a === 169 && b === 254) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
    }
    if (ipVer === 6) {
      // loopback / link-local / unique-local
      if (host === "::1") return false;
      if (host.startsWith("fe80:")) return false;
      if (host.startsWith("fc") || host.startsWith("fd")) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function getClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  if (first) return first;
  const xrip = req.headers.get("x-real-ip");
  return xrip ? xrip.trim() : null;
}

function hasInternalBypass(req: Request): boolean {
  const keys = [
    "X_MM_INTERNAL_TOKEN",
    "MM_INTERNAL_TOKEN",
    "MOJOMAXI_INTERNAL_TOKEN",
    "INTERNAL_SHARED_SECRET",
    "INTERNAL_GATEWAY_SECRET",
    "INTERNAL_FETCH_TOKEN",
  ] as const;
  let expected = "";
  for (const k of keys) {
    const v = (process.env as any)?.[k];
    if (typeof v === "string" && v.trim()) { expected = v.trim(); break; }
  }
  if (!expected) return false;
  const auth = (req.headers.get("authorization") || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerToken = (req.headers.get("x-mm-internal-token") || "").trim();
  return (bearer && bearer === expected) || (headerToken && headerToken === expected);
}

function normalizeMint(s: string | null | undefined): string {
  return (s || "").trim();
}


function urlPathIncludesMint(u: string, mint: string): boolean {
  try {
    const path = new URL(u).pathname.toLowerCase();
    const needle = String(mint || "").toLowerCase();
    return !!needle && path.includes(needle);
  } catch {
    return false;
  }
}
function transparentPng(): Uint8Array {
  // 1×1 transparent PNG
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YdqhC0AAAAASUVORK5CYII=";
  return Buffer.from(b64, "base64");
}

/** Create a brand-new ArrayBuffer (avoids SAB typing & view offset pitfalls) */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

async function urlOk(u: string): Promise<boolean> {
  try {
    if (!isSafeExternalHttpUrl(u)) return false;
    const r = await fetch(u, {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow" as RequestRedirect,
    });
    if (r.ok) return true;
  } catch {
    // ignore
  }
  try {
    const r2 = await fetch(u, {
      method: "GET",
      cache: "no-store",
      redirect: "follow" as RequestRedirect,
    });
    if (r2.ok) return true;
  } catch {
    // ignore
  }
  return false;
}

/**
 * Jupiter Lite token meta (exact by mint → search).
 */
async function fetchLiteTokenMeta(mint: string): Promise<AnyObj | null> {
  const needle = normalizeMint(mint);
  if (!needle) return null;

  // Exact token lookup
  try {
    const r = await fetch(
      `https://api.jup.ag/tokens/v2/token/${encodeURIComponent(needle)}`,
      { cache: "no-store" }
    );
    if (r.ok) {
      const j = (await r.json().catch(() => null)) as AnyObj | null;
      if (j && (j as any).address && normalizeMint((j as any).address) === needle) return j as AnyObj;
    }
  } catch {
    // ignore
  }

  // Search as fallback
  try {
    const r2 = await fetch(
      `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(
        needle
      )}`,
      { cache: "no-store" }
    );
    if (!r2.ok) return null;

    const j2: any = await r2.json().catch(() => ({}));
    const arr: any[] = Array.isArray(j2?.data)
      ? j2.data
      : Array.isArray(j2?.tokens)
      ? j2.tokens
      : Array.isArray(j2?.items)
      ? j2.items
      : [];

    const hit =
      arr.find(
        (t) =>
          normalizeMint(t?.address || t?.mint || "") === needle
      ) || null;

    return (hit || null) as AnyObj | null;
  } catch {
    // ignore
  }

  return null;
}

/**
 * Resolve a logo URL for `mint`, using (optional) cached `meta` to avoid redundant lookups.
 *
 * IMPORTANT: This function must only ever return a fully-qualified HTTP(S) URL or null.
 */
async function discoverLogoUrl(
  mint: string,
  meta?: AnyObj | null
): Promise<string | null> {
  const needle = normalizeMint(mint);
  if (!needle) return null;

  // 1) Directly from cached meta (if it already has a usable logo).
  {
    const m = (meta && (meta.logoURI || meta.logoUri || meta.icon)) as
      | string
      | undefined;
    if (isHttpUrl(m)) {
      return String(m);
    }
  }

  // 2) Jupiter icons (common CDN paths).
  {
    const candidates = [
      `https://icons.jup.ag/token/${encodeURIComponent(needle)}`,
      `https://icons.jup.ag/tokens/${encodeURIComponent(needle)}.png`,
      `https://icons.jup.ag/tokens/${encodeURIComponent(needle)}.svg`,
      `https://icons.jup.ag/assets/${encodeURIComponent(needle)}.png`,
      `https://icons.jup.ag/assets/${encodeURIComponent(needle)}.svg`,
    ];

    for (const u of candidates) {
      if (await urlOk(u)) return u;
    }
  }

  // 3) DexScreener — mint-strict token logos only.
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(
        needle
      )}`,
      { cache: "no-store" }
    );
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const arr: any[] = Array.isArray(j?.pairs) ? j.pairs : [];

      // Highest-liquidity pairs first so we prefer the "main" market.
      arr.sort(
        (a, b) =>
          Number(b?.liquidity?.usd || 0) -
          Number(a?.liquidity?.usd || 0)
      );

      const pickTokenLogo = (t: any): string | null => {
        if (!t) return null;
        const addr = normalizeMint(
          t?.address || t?.mint || t?.id || ""
        );
        if (!addr || addr !== needle) return null;

        const u =
          t.logo ||
          t.icon ||
          t.imageUrl ||
          t.logoURI ||
          t.logoUri;
        return isHttpUrl(u) && urlPathIncludesMint(String(u), needle) ? String(u) : null;
      };

      for (const p of arr) {
        const uBase = pickTokenLogo(p?.baseToken);
        if (uBase) return uBase;

        const uQuote = pickTokenLogo(p?.quoteToken);
        if (uQuote) return uQuote;
      }

      // NOTE: we intentionally DO NOT fall back to p.info.imageUrl here.
      // Those images are pair-level and can correspond to the *other* token
      // in the pair, which is exactly what causes incorrect logos in the UI.
    }
  } catch {
    // ignore DexScreener errors silently
  }

  // 4) Birdeye CDN
  {
    const u = `https://cdn.birdeye.so/icon/${encodeURIComponent(
      needle
    )}?size=64`;
    if (await urlOk(u)) return u;
  }

  // 5) TrustWallet assets CDN
  {
    const u = `https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains/solana/assets/${encodeURIComponent(
      needle
    )}/logo.png`;
    if (await urlOk(u)) return u;
  }

  // 6) Nothing else worked.
  return null;
}

function addOneTimeCacheBuster(u: string): string {
  try {
    const url = new URL(u);
    const epochMin = Math.floor(Date.now() / 60000);
    if (!url.searchParams.has("mmv")) {
      url.searchParams.set("mmv", String(epochMin));
    }
    return url.toString();
  } catch {
    // If URL parsing fails, just return the original.
    return u;
  }
}

/**
 * GET /api/token-logos/[mint]
 *
 * Returns a 302 redirect to a best-effort logo URL, or a 1×1 transparent PNG.
 */
export async function GET(
  req: NextRequest,
  ctx: any
) {
  try {
    const mint = normalizeMint(ctx.params?.mint);
    if (!mint) {
      const bytes = transparentPng();
      return new Response(toArrayBuffer(bytes), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store, max-age=0, must-revalidate",
          "x-mm-logo-mint": "",
          "x-mm-logo-src": "none",
        },
      });
    }


    // Rate-limit (this endpoint can trigger multiple upstream fetches).
    if (!hasInternalBypass(req)) {
      try {
        const windowSec = 60;
        const limit = Number(process.env.MM_TOKEN_LOGO_LIMIT_PER_MIN || 120);
        const ip = getClientIp(req) || "unknown";
        const slot = Math.floor(Date.now() / 1000 / windowSec);
        const rlKey = `mm:ratelimit:tokenlogo:${ip}:${slot}`;
        const n = await (redis as any).incr(rlKey);
        if (n === 1) await (redis as any).expire(rlKey, windowSec);
        if (n > limit) {
          const bytes = transparentPng();
          return new Response(toArrayBuffer(bytes), {
            status: 429,
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "no-store, max-age=0, must-revalidate",
              "x-mm-logo-mint": mint,
              "x-mm-logo-src": "rate_limited",
            },
          });
        }
      } catch {
        // ignore (fail-open)
      }
    }
    const key = cacheKey("token", "meta", mint);
    let meta = await cacheGetJSON<AnyObj>(key);

    // Prime meta from Jupiter if we have nothing cached yet.
    if (!meta) {
      const fresh = await fetchLiteTokenMeta(mint);
      if (fresh) {
        meta = fresh;
        try {
          await cacheSetJSON(key, meta, TTL_SEC);
        } catch {
          // ignore cache errors
        }
      }
    }

    // Discover and persist a logo if we don't already have one.
    let logo = await discoverLogoUrl(mint, meta);
    if (logo && !isHttpUrl(logo)) {
      logo = null;
    }

    if (
      logo &&
      (!meta ||
        !isHttpUrl(
          (meta as any).logoURI ||
            (meta as any).logoUri ||
            (meta as any).icon
        ))
    ) {
      const merged: AnyObj = {
        ...(meta || {}),
        address: String(
          ((meta as any)?.address ||
            (meta as any)?.mint ||
            mint) ?? mint
        ),
        logoURI: logo,
      };
      try {
        await cacheSetJSON(key, merged, TTL_SEC);
        meta = merged;
      } catch {
        // ignore cache errors
      }
    }

    const pick = (meta &&
      ((meta as any).logoURI ||
        (meta as any).logoUri ||
        (meta as any).icon)) as string | undefined;

    if (isHttpUrl(pick)) {
      const href = addOneTimeCacheBuster(pick);
      const res = NextResponse.redirect(href, 302);
      res.headers.set(
        "Cache-Control",
        `public, max-age=86400, s-maxage=${TTL_SEC}, stale-while-revalidate=${STALE_SEC}`
      );
      res.headers.set("x-mm-logo-mint", mint);
      res.headers.set("x-mm-logo-src", "meta");
      return res;
    }

    // TokenPicker backfill: hit /api/tokens?mints=<mint>, then re-check cache.
    try {
      const host =
        req.headers.get("x-forwarded-host") ||
        req.headers.get("host");
      const proto =
        req.headers.get("x-forwarded-proto") || "https";
      const origin = host ? `${proto}://${host}` : null;

      if (origin) {
        const r = await fetch(
          `${origin}/api/tokens?mints=${encodeURIComponent(
            mint
          )}`,
          { cache: "no-store" }
        );
        // We don't care about the body; we just want whatever
        // server-side token meta writing happens as a side-effect.
        await r.json().catch(() => null);

        const after = await cacheGetJSON<AnyObj>(key);
        const pick2 = (after &&
          ((after as any).logoURI ||
            (after as any).logoUri ||
            (after as any).icon)) as string | undefined;

        if (isHttpUrl(pick2)) {
          const href = addOneTimeCacheBuster(pick2);
          const res = NextResponse.redirect(href, 302);
          res.headers.set(
            "Cache-Control",
            `public, max-age=86400, s-maxage=${TTL_SEC}, stale-while-revalidate=${STALE_SEC}`
          );
          res.headers.set("x-mm-logo-mint", mint);
          res.headers.set("x-mm-logo-src", "picker");
          return res;
        }
      }
    } catch {
      // fall through to transparent PNG
    }

    // Last resort: tiny transparent PNG, but **no-store** so a later hit can pick up a new logo.
    const bytes = transparentPng();
    return new Response(toArrayBuffer(bytes), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store, max-age=0, must-revalidate",
        "x-mm-logo-mint": mint,
        "x-mm-logo-src": "transparent-fallback",
      },
    });
  } catch {
    const bytes = transparentPng();
    return new Response(toArrayBuffer(bytes), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store, max-age=0, must-revalidate",
        "x-mm-logo-src": "error-fallback",
      },
    });
  }
}
