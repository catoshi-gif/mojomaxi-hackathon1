// FULL FILE REPLACEMENT for: src/app/api/tokens/route.ts
// filepath: src/app/api/tokens/route.ts
/**
 * Per-mint token metadata endpoint with Upstash cache and robust logo backfill.
 * GET /api/tokens?mints=a,b,c  (also supports ids,id)
 * Returns: { ok: true, map: { [mint]: {address,mint,symbol,name,logoURI,decimals,verified} }, items: [...] }
 *
 * - Reads Upstash (mm:cache:v1:token:meta:<mint>).
 * - On miss, pulls Jupiter Lite token meta (exact → search) and persists.
 * - If logoURI is empty, attempts discovery: Jupiter Icons → DexScreener → Birdeye → TrustWallet.
 * - Persists discovered logoURI (30d) and advertises CDN TTL (60s).
 */
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { cacheKey, cacheGetJSON, cacheSetJSON } from "@/lib/cache.server";

type AnyObj = Record<string, any>;
const TTL_META_SEC = 60 * 60 * 24 * 30;
const TTL_HTTP_SEC = 60;

function uniqCsv(input: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const raw = (input || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const s of raw) { if (!s || seen.has(s)) continue; seen.add(s); out.push(s); }
  return out;
}
function isHttpUrl(s: unknown): s is string { return typeof s === "string" && /^https?:\/\//i.test(s); }
async function urlOk(u: string): Promise<boolean> {
  try { const r = await fetch(u, { method: "HEAD", cache: "no-store", redirect: "follow" as RequestRedirect }); if (r.ok) return true; } catch {}
  try { const r2 = await fetch(u, { method: "GET", cache: "no-store", redirect: "follow" as RequestRedirect }); if (r2.ok) return true; } catch {}
  return false;
}
async function discoverLogoUrl(mint: string, meta?: AnyObj | null): Promise<string | null> {
  const fromMeta = meta?.logoURI || meta?.icon || meta?.logoUri;
  if (isHttpUrl(fromMeta)) return String(fromMeta);
  const jup = [
    `https://icons.jup.ag/token/${encodeURIComponent(mint)}`,
    `https://icons.jup.ag/tokens/${encodeURIComponent(mint)}.png`,
    `https://icons.jup.ag/tokens/${encodeURIComponent(mint)}.svg`,
    `https://icons.jup.ag/assets/${encodeURIComponent(mint)}.png`,
    `https://icons.jup.ag/assets/${encodeURIComponent(mint)}.svg`,
  ];
  for (const u of jup) { if (await urlOk(u)) return u; }
  
  // DexScreener — mint-strict token logos only (ignore pair-level images).
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, { cache: "no-store" });
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const pairs: any[] = Array.isArray(j?.pairs) ? j.pairs : [];
      pairs.sort((a, b) => (Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0)));

      const urlContainsMint = (u: unknown, needle: string): boolean => {
        try {
          if (!u) return false;
          const url = new URL(String(u));
          return url.pathname.toLowerCase().includes(needle.toLowerCase());
        } catch {
          return false;
        }
      };

      const pickTokenLogo = (t: any): string | null => {
        if (!t) return null;
        const addr = String(t?.address || t?.mint || t?.id || "").trim();
        if (!addr || addr !== mint) return null;
        const u = t.logo || t.icon || t.imageUrl || t.logoURI || t.logoUri || t?.img?.url;
        if (!u || !/^https?:\/\//i.test(String(u))) return null;
        // Ensure the dexscreener URL we accept encodes the mint in the path to avoid mismatches.
        if (!urlContainsMint(u, mint)) return null;
        return String(u);
      };

      for (const p of pairs) {
        const uBase = pickTokenLogo(p?.baseToken);
        if (uBase) return uBase;

        const uQuote = pickTokenLogo(p?.quoteToken);
        if (uQuote) return uQuote;
      }
    }
  } catch {}
{ const u = `https://cdn.birdeye.so/icon/${encodeURIComponent(mint)}?size=64`; if (await urlOk(u)) return u; }
  { const u = `https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains/solana/assets/${encodeURIComponent(mint)}/logo.png`; if (await urlOk(u)) return u; }
  return null;
}
async function fetchLiteTokenMeta(mint: string): Promise<AnyObj | null> {
  try {
    const r = await fetch(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, { cache: "no-store" });
    if (r.ok) { const j = (await r.json().catch(()=>null)) as AnyObj | null; if (j && (j as any).address) return j; }
  } catch {}
  try {
    const r = await fetch(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const js:any = await r.json().catch(()=>({}));
    const arr:any[] = Array.isArray(js?.data) ? js.data : Array.isArray(js?.tokens) ? js.tokens : Array.isArray(js?.items) ? js.items : [];
    const hit = arr.find((t)=> (t?.address || t?.mint) === mint) || arr[0] || null;
    return (hit || null) as AnyObj | null;
  } catch {}
  return null;
}
function shapeItem(mint: string, meta: AnyObj | null, logoURI?: string | null) {
  const address = String(meta?.address || meta?.mint || mint);
  return {
    address, mint: address,
    symbol: String(meta?.symbol || meta?.ticker || ""),
    name: String(meta?.name || ""),
    logoURI: String(logoURI || meta?.logoURI || meta?.logoUri || meta?.icon || ""),
    decimals: Number(meta?.decimals ?? 0),
    verified: Boolean(meta?.verified ?? meta?.jupVerified ?? meta?.isVerified ?? false),
  };
}
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("mints") || url.searchParams.get("ids") || url.searchParams.get("id") || "").trim();
  if (raw) {
    const mints = uniqCsv(raw).slice(0, 60);
    const map: Record<string, AnyObj> = {};
    const misses: string[] = [];
    const needLogo: string[] = [];
    for (const m of mints) {
      const key = cacheKey("token","meta",m);
      const cached = await cacheGetJSON<AnyObj>(key);
      if (cached) {
        map[m] = shapeItem(m, cached);
        const hasLogo = isHttpUrl((cached as any)?.logoURI || (cached as any)?.logoUri || (cached as any)?.icon);
        if (!hasLogo) needLogo.push(m);
      } else {
        misses.push(m);
      }
    }
    if (misses.length) {
      const CONC = 4; let i = 0;
      await Promise.all(Array.from({length: Math.min(CONC, misses.length)}, async () => {
        while (i < misses.length) {
          const m = misses[i++];
          const meta = await fetchLiteTokenMeta(m);
          if (meta) {
            const key = cacheKey("token","meta",m);
            try { await cacheSetJSON(key, meta, TTL_META_SEC); } catch {}
            map[m] = shapeItem(m, meta);
            const hasLogo = isHttpUrl((meta as any)?.logoURI || (meta as any)?.logoUri || (meta as any)?.icon);
            if (!hasLogo) needLogo.push(m);
          } else {
            map[m] = shapeItem(m, null);
            needLogo.push(m);
          }
        }
      }));
    }
    if (needLogo.length) {
      const CONC2 = 4; let j = 0;
      await Promise.all(Array.from({length: Math.min(CONC2, needLogo.length)}, async () => {
        while (j < needLogo.length) {
          const m = needLogo[j++];
          const key = cacheKey("token","meta",m);
          const cached = (await cacheGetJSON<AnyObj>(key)) || null;
          const logo = await discoverLogoUrl(m, cached);
          if (logo && isHttpUrl(logo)) {
            const merged = { ...(cached || {}), address: String(cached?.address || cached?.mint || m), logoURI: logo };
            try { await cacheSetJSON(key, merged, TTL_META_SEC); } catch {}
            map[m] = shapeItem(m, merged, logo);
          }
        }
      }));
    }
    const items = mints.map((m) => map[m] || shapeItem(m, null));
    return NextResponse.json({ ok: true, map, items, updatedAt: Date.now() }, {
      headers: { "Cache-Control": `public, s-maxage=${TTL_HTTP_SEC}, stale-while-revalidate=30` }
    });
  }
  // Back-compat: /api/tokens/top passthrough when no mints provided
  try {
    const origin = url.origin;
    const res = await fetch(`${origin}/api/tokens/top`, { cache: "force-cache" });
    const j = await res.json().catch(() => ({ ok: true, tokens: [], items: [] }));
    return NextResponse.json(j, {
      headers: { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=3600" },
    });
  } catch {
    return NextResponse.json({ ok: true, tokens: [], items: [] }, {
      headers: { "Cache-Control": "public, s-maxage=300" },
    });
  }
}
