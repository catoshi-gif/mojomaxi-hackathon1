// FULL FILE REPLACEMENT for: src/app/api/tokens/meta/route.ts
// filepath: src/app/api/tokens/meta/route.ts
// Immutable token metadata with long-lived cache (Upstash Redis) + CDN headers.
// Input:  GET /api/tokens/meta?mints=a,b,c
// Output: { ok: true, items: [{ mint,address,symbol,name,logoURI,decimals }] }
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AnyObj = Record<string, any>;

import { cacheKey, cacheGetJSON, cacheSetJSON } from "@/lib/cache.server";
import { redis } from "@/lib/redis";

const TTL_META_SEC = 60 * 60 * 24 * 30; // 30 days


function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  try {
    const ok = await (redis as any).set(key, "1", { nx: true, px: ttlMs });
    return !!ok;
  } catch {
    return false;
  }
}

async function releaseLock(key: string) {
  try {
    await redis.del(key);
  } catch {}
}


function jupBase() {
  const raw =
    (process.env.JUPITER_PRO_BASE ||
      process.env.JUPITER_API_BASE ||
      "https://api.jup.ag") + "";
  let s = raw.trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s || "https://api.jup.ag";
}

function jupHeaders(): Record<string, string> {
  const key = (process.env.JUP_API_KEY || process.env.JUPITER_API_KEY || "").trim();
  const h: Record<string, string> = { accept: "application/json" };
  if (key) h["x-api-key"] = key;
  return h;
}

// Back-compat alias: older drafts referred to SEARCH_BY_MINT. Keep the name to avoid regressions.
const TOKEN_SEARCH_BY_MINT = (mint: string) =>
  `${jupBase()}/tokens/v2/search?query=${encodeURIComponent(mint)}&limit=20`;
const SEARCH_BY_MINT = TOKEN_SEARCH_BY_MINT;

function isHttpUrl(s: unknown): s is string {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function urlContainsMint(url: string, mint: string): boolean {
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

async function urlOk(u: string): Promise<boolean> {
  try {
    const r = await fetch(u, { method: "HEAD", cache: "no-store", redirect: "follow" as RequestRedirect });
    if (r.ok) return true;
  } catch {}
  try {
    const r2 = await fetch(u, { method: "GET", cache: "no-store", redirect: "follow" as RequestRedirect });
    if (r2.ok) return true;
  } catch {}
  return false;
}

async function discoverLogoUrl(mint: string, meta?: AnyObj | null): Promise<string | null> {
  const fromMeta = meta?.logoURI || meta?.icon || meta?.logoUri;
  if (isHttpUrl(fromMeta)) return String(fromMeta);

  const jupCandidates = [
    `https://icons.jup.ag/token/${encodeURIComponent(mint)}`,
    `https://icons.jup.ag/tokens/${encodeURIComponent(mint)}.png`,
    `https://icons.jup.ag/tokens/${encodeURIComponent(mint)}.svg`,
    `https://icons.jup.ag/assets/${encodeURIComponent(mint)}.png`,
    `https://icons.jup.ag/assets/${encodeURIComponent(mint)}.svg`,
  ];
  for (const u of jupCandidates) {
    try {
      if (await urlOk(u)) return u;
    } catch {}
  }

  // Optional fallback: DexScreener logo discovery (kept from original behavior)
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { cache: "no-store" }
    );
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const pairs: any[] = Array.isArray(j?.pairs) ? j.pairs : [];

      const pickTokenLogo = (t: any): string | null => {
        const u = t?.icon || t?.logoURI || t?.logoUri || t?.imageUrl || t?.image || null;
        if (!u || typeof u !== "string") return null;
        if (!isHttpUrl(u)) return null;
        if (!urlContainsMint(u, mint)) return null;
        return String(u);
      };

      const mintNeedle = String(mint || "").trim();

      const tokenAddress = (t: any): string => {
        try {
          return String(t?.address || t?.mint || t?.id || "").trim();
        } catch {
          return "";
        }
      };

      for (const p of pairs) {
        const base = p?.baseToken || null;
        const quote = p?.quoteToken || null;

        const baseAddr = tokenAddress(base);
        const quoteAddr = tokenAddress(quote);

        // IMPORTANT: Only accept the logo for the token whose address matches the requested mint.
        // DexScreener frequently returns pair metadata where the "other side" has a valid logo,
        // which can cause wrong-token icons if we accept the first available logo.
        if (baseAddr && baseAddr === mintNeedle) {
          const uBase = pickTokenLogo(base);
          if (uBase) return uBase;
        }

        if (quoteAddr && quoteAddr === mintNeedle) {
          const uQuote = pickTokenLogo(quote);
          if (uQuote) return uQuote;
        }
      }
    }
  } catch {}

  return null;
}

function extractSearchArray(js: any): any[] {
  if (Array.isArray(js)) return js;
  if (Array.isArray(js?.tokens)) return js.tokens;
  if (Array.isArray(js?.items)) return js.items;
  if (Array.isArray(js?.data)) return js.data;
  return [];
}

function normalizeMetaFromTokenObj(mint: string, t: any): AnyObj {
  const address = String(t?.id || t?.address || t?.mint || mint);
  return {
    address,
    mint: address,
    symbol: t?.symbol ?? t?.ticker ?? "",
    name: t?.name ?? "",
    decimals: typeof t?.decimals === "number" ? t.decimals : Number(t?.decimals ?? 0),
    logoURI: t?.icon ?? t?.logoURI ?? t?.logoUri ?? "",
    tokenProgram: t?.tokenProgram ?? undefined,
    isVerified: typeof t?.isVerified === "boolean" ? t.isVerified : undefined,
    tags: Array.isArray(t?.tags) ? t.tags : undefined,
  };
}

async function fetchSingleMeta(mint: string): Promise<AnyObj | null> {
  // Jupiter Pro Tokens V2: “by mint” is done via /tokens/v2/search?query=<mint> + exact id match.
  try {
    const rs = await fetch(SEARCH_BY_MINT(mint), { cache: "no-store", headers: jupHeaders() });
    if (rs.ok) {
      const js: any = await rs.json().catch(() => ({}));
      const arr: any[] = extractSearchArray(js);
      const hit =
        arr.find((t: any) => String(t?.id || t?.address || t?.mint || "").trim() === mint) ||
        arr.find((t: any) => String(t?.id || t?.address || t?.mint || "").trim() === mint.trim()) ||
        null;
      if (hit) return normalizeMetaFromTokenObj(mint, hit);
      // If not found, return a minimal record (decimals 0) only if the API returned something;
      // better to return null and let callers handle unknown tokens.
      return null;
    }
  } catch {}

  return null;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const cacheOnly =
      url.searchParams.get("mode") === "cache-only" || url.searchParams.get("cacheOnly") === "1";

    const raw = String(url.searchParams.get("mints") || "").trim();
    if (!raw) return NextResponse.json({ ok: true, items: [] });

    const mints = Array.from(new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))).slice(0, 60);

    const items: AnyObj[] = [];
    const misses: string[] = [];
    const needLogo: string[] = [];

    // Read cache first
    for (const m of mints) {
      const key = cacheKey("token", "meta", m);
      const cached = await cacheGetJSON<AnyObj>(key);
      if (cached) {
        items.push({
          mint: String(cached.address || cached.mint || m),
          address: String(cached.address || cached.mint || m),
          symbol: String(cached.symbol || cached.ticker || ""),
          name: String(cached.name || ""),
          logoURI: String(cached.logoURI || cached.logoUri || cached.icon || ""),
          decimals: Number(cached.decimals ?? 0),
        });
        if (!isHttpUrl((cached as any)?.logoURI || (cached as any)?.logoUri || (cached as any)?.icon)) {
          needLogo.push(m);
        }
      } else {
        misses.push(m);
      }
    }

    // Fetch misses (unless cache-only)
    if (misses.length && !cacheOnly) {
      const CONC = 4;
      let idx = 0;
      async function worker() {
        while (idx < misses.length) {
          const m = misses[idx++];
          // Singleflight on cache-miss fetch to prevent stampedes under burst traffic.
          const lockKey = `mm:tokenmeta:lock:${m}`;
          const got = await acquireLock(lockKey, 15_000);
          if (!got) {
            // Someone else is computing this mint right now — wait briefly and re-read cache.
            for (let k = 0; k < 3; k++) {
              await sleep(150);
              const key2 = cacheKey("token", "meta", m);
              const cached2 = await cacheGetJSON<AnyObj>(key2);
              if (cached2) {
                items.push({
                  mint: String(cached2.address || cached2.mint || m),
                  address: String(cached2.address || cached2.mint || m),
                  symbol: String(cached2.symbol || cached2.ticker || ""),
                  name: String(cached2.name || ""),
                  logoURI: String(cached2.logoURI || cached2.logoUri || cached2.icon || ""),
                  decimals: Number(cached2.decimals ?? 0),
                });
                if (!isHttpUrl((cached2 as any)?.logoURI || (cached2 as any)?.logoUri || (cached2 as any)?.icon)) {
                  needLogo.push(m);
                }
                break;
              }
            }
            continue;
          }

          try {
            const j = await fetchSingleMeta(m);
            if (j) {
              const key = cacheKey("token", "meta", m);
              await cacheSetJSON(key, j, TTL_META_SEC);
              items.push({
                mint: String(j.address || j.mint || m),
                address: String(j.address || j.mint || m),
                symbol: String(j.symbol || j.ticker || ""),
                name: String(j.name || ""),
                logoURI: String(j.logoURI || j.logoUri || j.icon || ""),
                decimals: Number(j.decimals ?? 0),
              });
              if (!isHttpUrl((j as any)?.logoURI || (j as any)?.logoUri || (j as any)?.icon)) {
                needLogo.push(m);
              }
            }
          } finally {
            releaseLock(lockKey).catch(() => {});
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONC, misses.length) }, () => worker()));
    }

    // Backfill missing logoURI (additive; done only when not cacheOnly)
    if (needLogo.length && !cacheOnly) {
      const CONC2 = 4;
      let idx2 = 0;
      async function worker2() {
        while (idx2 < needLogo.length) {
          const m = needLogo[idx2++];
          const lockKey = `mm:tokenlogo:lock:${m}`;
          const got = await acquireLock(lockKey, 20_000);
          if (!got) continue;

          try {
            const key = cacheKey("token", "meta", m);
            const cached = await cacheGetJSON<AnyObj>(key);
            const logo = await discoverLogoUrl(m, cached);
            if (logo && isHttpUrl(logo)) {
              const merged = { ...(cached || {}), address: String(cached?.address || cached?.mint || m), logoURI: logo };
              try {
                await cacheSetJSON(key, merged, TTL_META_SEC);
              } catch {}
            }
          } finally {
            releaseLock(lockKey).catch(() => {});
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONC2, needLogo.length) }, () => worker2()));
    }

    // Preserve requested order
    const byMint: Record<string, AnyObj> = {};
    for (const it of items) byMint[it.address] = it;
    const ordered = mints.map((m) => byMint[m]).filter(Boolean);

    return NextResponse.json(
      { ok: true, items: ordered },
      { headers: { "Cache-Control": "public, s-maxage=2592000, stale-while-revalidate=604800" } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "meta_error" }, { status: 500 });
  }
}
