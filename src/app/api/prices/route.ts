// filepath: src/app/api/prices/route.ts
// Batch price lookup with Redis caching + singleflight.
// GET /api/prices?mints=a,b,c  → { ok:true, data: { [mint]: usd } }
// Sources: Jupiter V3 (PRO key if present, else Lite) → DexScreener fallback → stable $1 hints

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { cacheKey, cacheGetJSON, cacheGetManyJSON, cacheSetJSON, singleflight } from "@/lib/cache.server";

type PriceMap = Record<string, number>;

function _stableJson(obj: any): string {
  // Stable stringify for small objects with primitive values
  const keys = Object.keys(obj || {}).sort();
  const parts: string[] = [];
  for (const k of keys) parts.push(`${k}:${String((obj as any)[k])}`);
  return `{${parts.join(",")}}`;
}

function _etagForPrices(idsSorted: string[], data: PriceMap): string {
  const base = `ids=${idsSorted.join(",")}|data=${_stableJson(data)}`;
  const h = crypto.createHash("sha1").update(base).digest("base64url");
  return `W/"${h}"`;
}

function _maybe304(req: NextRequest, etag: string, cacheControl: string) {
  const inm = req.headers.get("if-none-match");
  if (inm && inm === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }
  return null;
}

function uniqCsv(input: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (input || "").split(/[\s,]+/)) {
    const m = raw.trim();
    if (!m) continue;
    if (!seen.has(m)) { seen.add(m); out.push(m); }
  }
  return out;
}

const STABLE_HINT: Record<string, number> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 1.0, // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 1.0, // USDT
};

async function jupiterV3(ids: string[]): Promise<PriceMap> {
  const out: PriceMap = {};
  if (!ids.length) return out;
  const key = (process.env.JUP_API_KEY || process.env.JUP_PRO_API_KEY || "").trim();
  const base = key ? "https://api.jup.ag/price/v3" : "https://api.jup.ag/price/v3";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-api-key"] = key;

  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const url = `${base}?ids=${encodeURIComponent(chunk.join(","))}`;
    try {
      const r = await fetch(url, { headers, cache: "no-store" });
      if (!r.ok) continue;
      const text = await r.text();
      let j: any = {};
      try { j = JSON.parse(text); } catch {}
      for (const k of Object.keys(j || {})) {
        const node = (j as any)[k];
        const usd = Number(node?.usdPrice ?? node?.price ?? node);
        if (Number.isFinite(usd)) out[k] = usd;
      }
    } catch {}
  }
  return out;
}

async function dexFallback(ids: string[]): Promise<PriceMap> {
  const out: PriceMap = {};
  const queue = [...ids];
  const CONC = 4;
  async function worker() {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!r.ok) continue;
        const j = await r.json().catch(() => ({} as any));
        const pairs: any[] = Array.isArray(j?.pairs) ? j.pairs : [];
        let best = 0, price = Number.NaN;
        for (const p of pairs) {
          const liq = Number(p?.liquidity?.usd || 0);
          const pu = Number(p?.priceUsd);
          if (liq > best && Number.isFinite(pu)) { best = liq; price = pu; }
        }
        if (Number.isFinite(price)) out[id] = price;
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, () => worker()));
  return out;
}

const TTL_SEC = 60; // 1 minute

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const ids = uniqCsv(url.searchParams.get("mints") || url.searchParams.get("ids") || url.searchParams.get("id")).slice(0, 200);
  if (!ids.length) {
    return NextResponse.json({ ok: true, data: {} as PriceMap }, { headers: { "Cache-Control": "no-store" } });
  }

  // Try cached batch first
  const batchKey = cacheKey("prices","batch", ids.slice().sort().join(","));
  const cached = await cacheGetJSON<PriceMap>(batchKey);
  if (cached && Object.keys(cached).length) {
    const idsSorted = ids.slice().sort();
    const etag = _etagForPrices(idsSorted, cached);
    // Include a small browser max-age so client polling can be served from cache + ETag revalidation.
    const maybe = _maybe304(req, etag, "public, max-age=5, s-maxage=60, stale-while-revalidate=30");
    if (maybe) return maybe;
    return NextResponse.json({ ok: true, data: cached }, {
      headers: { "Cache-Control": "public, max-age=5, s-maxage=60, stale-while-revalidate=30", ETag: etag },
    });
  }

  // Coalesce concurrent work on same key
  const result = await singleflight(batchKey, async () => {
    // Reuse per-mint cached entries — single MGET round-trip instead of N sequential GETs
    const pre: PriceMap = {};
    const missing: string[] = [];
    const pmKeys = ids.map((m) => cacheKey("prices", "mint", m));
    const pmValues = await cacheGetManyJSON<number>(pmKeys);
    ids.forEach((m, i) => {
      const v = pmValues[i];
      if (Number.isFinite(v as any)) pre[m] = Number(v);
      else missing.push(m);
    });

    // Fetch missing via Jupiter
    let got = await jupiterV3(missing);

    // Fill remaining via Dex
    const still = missing.filter((m) => !Number.isFinite(got[m] as any));
    if (still.length) {
      const dex = await dexFallback(still);
      for (const [k, v] of Object.entries(dex)) {
        if (Number.isFinite(v as any)) got[k] = Number(v);
      }
    }

    // Stable hints as absolute last resort
    for (const id of missing) {
      if (!Number.isFinite(got[id] as any) && Number.isFinite(STABLE_HINT[id] as any)) got[id] = STABLE_HINT[id];
    }

    // Compose final + write per-mint cache
    const final: PriceMap = { ...pre, ...got };
    await Promise.all(Object.entries(final).map(([k, v]) => cacheSetJSON(cacheKey("prices","mint",k), v, TTL_SEC)));
    await cacheSetJSON(batchKey, final, TTL_SEC);
    return final;
  });

  const idsSorted = ids.slice().sort();
  const etag = _etagForPrices(idsSorted, result);
  const maybe = _maybe304(req, etag, "public, max-age=5, s-maxage=60, stale-while-revalidate=30");
  if (maybe) return maybe;

  return NextResponse.json({ ok: true, data: result }, {
    headers: { "Cache-Control": "public, max-age=5, s-maxage=60, stale-while-revalidate=30", ETag: etag },
  });
}
