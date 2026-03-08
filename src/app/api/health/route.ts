// filepath: src/app/api/health/route.ts
// Lightweight liveness check — intentionally zero external I/O.
//
// PURPOSE: Keep-warm ping target for Vercel cron and CF Worker heartbeats.
//          Must never block on Redis, RPC, or any network call so it stays
//          cheap regardless of warm/cold state.
//
// For a deep Redis connectivity check (manual diagnostics only), use:
//   GET /api/health/deep
//
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, t: Date.now() });
}
