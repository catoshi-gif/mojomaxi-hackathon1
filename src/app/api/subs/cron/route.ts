// filepath: src/app/api/subs/cron/route.ts
import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";




async function acquireCronLock(): Promise<boolean> {
  try {
    const ok = await (redis as any).set("mm:cron:subs:lock", String(Date.now()), { nx: true, px: 110000 });
    return !!ok;
  } catch {
    return false;
  }
}

const PRODUCT = "mojo-pro";

export async function POST(_req: NextRequest) {
  try {
    const gotLock = await acquireCronLock();
    if (!gotLock) return NextResponse.json({ ok: true, skipped: true });

    const now = Date.now();
    const actKey = `mm:subs:${PRODUCT}:active`;
    const wallets = await redis.smembers<string[]>(actKey as any);
    if (!wallets?.length) return NextResponse.json({ ok: true, stopped: 0 });

    // Batch-fetch all subscription records in one pipeline instead of N sequential GETs.
    const subPipe = redis.pipeline();
    for (const w of wallets) subPipe.get(`mm:subs:${PRODUCT}:${w}`);
    const subs = await subPipe.exec();

    // Identify expired wallets
    const expired: string[] = [];
    for (let i = 0; i < wallets.length; i++) {
      const sub = subs[i] as any;
      const alive = sub && Number(sub?.expiresAt || 0) > now;
      if (!alive) expired.push(wallets[i]);
    }
    if (!expired.length) return NextResponse.json({ ok: true, stopped: 0 });

    // Process expired wallets in batches of 50 to avoid Vercel timeout
    let stopped = 0;
    const BATCH = 50;
    for (let i = 0; i < expired.length; i += BATCH) {
      const batch = expired.slice(i, i + BATCH);

      // Fetch set IDs for this batch
      const setsPipe = redis.pipeline();
      for (const w of batch) setsPipe.smembers(`mm:wallet:${w}:sets:type:mojo-pro` as any);
      const setsResults = await setsPipe.exec();

      // Stop all sets for expired wallets + remove from active set
      const stopPipe = redis.pipeline();
      for (let j = 0; j < batch.length; j++) {
        stopPipe.srem(actKey, batch[j]);
        const setIds = (setsResults[j] as string[]) || [];
        for (const setId of setIds) {
          stopPipe.hset(`mm:set:${setId}:status`, { state: "stopped", updatedAt: now });
          stopped++;
        }
      }
      await stopPipe.exec();
    }

    return NextResponse.json({ ok: true, stopped });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "internal_error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return POST(req); }
