// filepath: src/app/api/prices/[mint]/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { cacheKey, cacheGetJSON, cacheSetJSON } from "@/lib/cache.server";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const TTL_SEC = 60;

async function jupiterV3Single(mint: string): Promise<number | null> {
  const key = (process.env.JUP_API_KEY || process.env.JUP_PRO_API_KEY || "").trim();
  const base = key ? "https://api.jup.ag/price/v3" : "https://api.jup.ag/price/v3";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-api-key"] = key;
  const url = `${base}?ids=${encodeURIComponent(mint)}`;
  try {
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => ({}));
    const node = j?.[mint];
    const p = Number(node?.usdPrice ?? node?.price ?? node);
    return Number.isFinite(p) ? p : null;
  } catch { return null; }
}

async function dexSingle(mint: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({} as any));
    const pairs: any[] = Array.isArray(j?.pairs) ? j.pairs : [];
    let best = 0, price = Number.NaN;
    for (const p of pairs) {
      const liq = Number(p?.liquidity?.usd || 0);
      const pu = Number(p?.priceUsd);
      if (liq > best && Number.isFinite(pu)) { best = liq; price = pu; }
    }
    return Number.isFinite(price) ? price : null;
  } catch { return null; }
}

export async function GET(_req: NextRequest, { params }: any) {
  const mint = (params.mint || "").trim();
  if (!mint) return NextResponse.json({ ok: false, error: "missing mint" }, { status: 400 });

  if (mint === USDC) return NextResponse.json({ ok: true, mint, price: 1.0, source: "static" });
  if (mint === USDT) return NextResponse.json({ ok: true, mint, price: 1.0, source: "static" });

  // cache
  const key = cacheKey("prices","mint", mint);
  const cached = await cacheGetJSON<number>(key);
  if (Number.isFinite(cached as any)) {
    return NextResponse.json({ ok: true, mint, price: Number(cached), source: "cache" }, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
    });
  }

  let price: number | null = await jupiterV3Single(mint);
  if (!Number.isFinite(price as any)) price = await dexSingle(mint);

  if (!Number.isFinite(price as any)) {
    return NextResponse.json({ ok: false, error: "no price found" }, { status: 404 });
  }

  await cacheSetJSON(key, price!, TTL_SEC);
  return NextResponse.json({ ok: true, mint, price: price!, source: "fresh" }, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" },
  });
}
