// filepath: src/app/api/prices/[mint]/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export async function GET(_req: NextRequest, { params }: any) {
  const mint = (params.mint || "").trim();
  if (!mint) return NextResponse.json({ ok: false, error: "missing mint" }, { status: 400 });

  if (mint === USDC) {
    return NextResponse.json({ ok: true, mint, price: 1.0, source: "static" });
  }

  try {
    const url = new URL("https://price.jup.ag/v6/price");
    url.searchParams.set("ids", mint);
    url.searchParams.set("idType", "mint");
    url.searchParams.set("vsToken", "USDC");
    const r = await fetch(url.toString(), { cache: "no-store" });
    if (!r.ok) return NextResponse.json({ ok: false, error: `price fetch failed ${r.status}` }, { status: 502 });
    const j: any = await r.json().catch(() => ({}));
    const p = j?.data?.[mint]?.price ?? j?.data?.[mint]?.priceUsd ?? null;
    if (p == null) return NextResponse.json({ ok: false, error: "no price found" }, { status: 404 });
    return NextResponse.json({ ok: true, mint, price: Number(p), source: "jupiter" });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "price error" }, { status: 500 });
  }
}
