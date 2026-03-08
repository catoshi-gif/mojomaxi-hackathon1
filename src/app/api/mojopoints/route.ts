// filepath: src/app/api/mojopoints/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getMojoPoints, getCurrentSeason } from "@/lib/mojopoints.server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const wallet = (searchParams.get("wallet") || "").trim();
    const seasonParam = (searchParams.get("season") || "current").trim(); // "current" | "lifetime" | "<id>"
    if (!wallet) {
      return NextResponse.json({ ok: false, error: "missing_wallet" }, { status: 400 });
    }
    const { points, season } = await getMojoPoints(wallet, { seasonId: seasonParam as any });
    const current = await getCurrentSeason().catch(() => null);
    return NextResponse.json({
      ok: true,
      wallet,
      points: Math.max(0, Math.floor(Number(points || 0))),
      seasonId: season?.id ?? null,
      seasonStart: season?.start ?? null,
      seasonEnd: season?.end ?? null,
      currentSeasonId: current?.id ?? null,
    }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "failed", detail: String(e?.message || e) }, { status: 500 });
  }
}
