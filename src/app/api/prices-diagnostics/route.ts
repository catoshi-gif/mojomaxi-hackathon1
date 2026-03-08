// src/app/api/prices-diagnostics/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JUP_LITE = "https://api.jup.ag/price/v3";
const TOKENS_SEARCH = "https://price.jup.ag/v6/prices?ids=So11111111111111111111111111111111111111112";

export async function GET() {
  const out: Record<string, any> = {};
  try {
    const u = new URL(JUP_LITE);
    u.searchParams.set("ids", "So11111111111111111111111111111111111111112");
    u.searchParams.set("vsToken", "USDC");
    const jr = await fetch(u.toString(), { cache: "no-store" });
    out.jupLite = { ok: jr.ok, status: jr.status, body: await jr.text() };
  } catch (e: any) {
    out.jupLite = { ok: false, error: String(e) };
  }

  try {
    const r2 = await fetch(TOKENS_SEARCH, { cache: "no-store" });
    out.jupV6 = { ok: r2.ok, status: r2.status, body: await r2.text() };
  } catch (e: any) {
    out.jupV6 = { ok: false, error: String(e) };
  }

  return NextResponse.json({ ok: true, results: out });
}
