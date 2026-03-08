// filepath: src/app/api/mojo/points/route.ts
import { NextRequest, NextResponse } from "next/server";

// Keep build perf + edge safety
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Season-aware points reader used by the header badge.
// The front-end calls this with ?owner=<WALLET>. We also accept ?wallet= for flexibility.
import { getMojoPoints, getCurrentSeason } from "@/lib/mojopoints.server";

/**
 * GET /api/mojo/points?owner=<WALLET>[&season=current|lifetime|<id>]
 * Response: { ok: boolean, points?: number, error?: string }
 *
 * - Defaults to current season if one is configured.
 * - If no active season exists, falls back to lifetime so the badge isn't stuck at 0.
 * - Returns an integer (floor) number of points.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const owner = (searchParams.get("owner") || searchParams.get("wallet") || "").trim();
    if (!owner) {
      return NextResponse.json({ ok: false, error: "missing_owner" }, { status: 400 });
    }
    const seasonParam = (searchParams.get("season") || "current").trim();

    // Try requested/current season first
    let { points, season } = await getMojoPoints(owner, { seasonId: seasonParam as any });

    // If no active season configured, fall back to lifetime so users still see progress
    if ((seasonParam === "current" || !seasonParam) && !season) {
      const life = await getMojoPoints(owner, { seasonId: "lifetime" as any });
      points = life.points;
    }

    const value = Math.max(0, Math.floor(Number(points || 0)));
    return NextResponse.json({ ok: true, points: value }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "failed", detail: String(e?.message || e) }, { status: 500 });
  }
}
