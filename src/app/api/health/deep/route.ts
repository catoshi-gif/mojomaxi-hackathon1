// filepath: src/app/api/health/deep/route.ts
// Deep Redis health check — run manually to verify connectivity.
// NOT intended as a keep-warm target (it makes 3 sequential Redis round-trips).
// Use GET /api/health for cron/heartbeat pings instead.

import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  const t0 = Date.now();
  try {
    const ping = await redis.ping();
    const key = `mm:health:${Date.now()}`;
    await redis.set(key, "1", { ex: 30 });
    const got = await redis.get<string>(key);

    const ok = (ping === "PONG" || ping === "pong") && got === "1";

    return NextResponse.json({
      ok,
      using: "upstash-redis",
      latencyMs: Date.now() - t0,
      detail: { ping, set: "OK", get: got ?? null },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        using: "upstash-redis",
        latencyMs: Date.now() - t0,
        error: err?.message || String(err),
      },
      { status: 500 }
    );
  }
}
