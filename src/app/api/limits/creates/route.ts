// src/app/api/limits/creates/route.ts
// Read-only endpoint exposing the per-wallet daily create limit status.
// Returns: { ok, wallet, limit, count, remaining, windowSeconds, resetAt? }

import type { NextRequest } from "next/server";
import { redis } from "@/lib/redis";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const WINDOW_SEC = Number.parseInt(process.env.MM_CREATES_WINDOW_SEC || "", 10) || 86400;
const DEFAULT_LIMIT = Number.parseInt(process.env.MM_MAX_CREATES_PER_24H || process.env.NEXT_PUBLIC_MM_MAX_CREATES_PER_24H || "", 10) || 12;
const keyCreates = (w: string) => `mm:wallet:${(w || "").toLowerCase()}:creates`;

export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const wallet = (u.searchParams.get("wallet") || req.headers.get("x-wallet") || "").trim();
    if (!wallet) return NextResponse.json({ ok: false, error: "missing wallet" }, { status: 400 });

    const key = keyCreates(wallet);
    const now = Date.now();
    const windowMs = WINDOW_SEC * 1000;

    try { await redis.zremrangebyscore(key as any, 0, now - windowMs); } catch {}

    let count = 0;
    try { count = Number(await redis.zcard(key as any) as any) || 0; } catch {}

    // Earliest event in window to compute resetAt (parse member 'ts.random')
    let resetAt: number | undefined = undefined;
    try {
      const arr = (await (redis as any).zrange(key, 0, 0)) as string[]; // earliest
      const member = Array.isArray(arr) && arr.length ? String(arr[0]) : "";
      const ts = member && /^(\d+)\./.test(member) ? Number(member.split(".")[0]) : 0;
      if (ts > 0) resetAt = ts + windowMs;
    } catch {}

    const limit = DEFAULT_LIMIT;
    const remaining = Math.max(0, limit - count);
    return NextResponse.json({ ok: true, wallet, limit, count, remaining, windowSeconds: WINDOW_SEC, resetAt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
