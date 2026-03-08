// src/app/api/webhooks/reindex/route.ts
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const kWalletSetsSET  = (w: string) => `mm:wallet:${w}:sets`;
const kWalletSetsLIST = (w: string) => `mm:wh:sets:${w}:list`;
const kSetDoc         = (id: string) => `mm:set:${id}`;

// Minimal SCAN helper (avoids KEYS and type generics)
async function scanAll(match: string, cap = 5000): Promise<string[]> {
  let cursor: any = 0;
  const keys: string[] = [];
  for (let i = 0; i < 100; i++) {
    // Upstash client exposes scan on the low-level client; types are loose
    const res: any = await (redis as any).scan(cursor, { match, count: 200 }).catch(() => null);
    if (!res) break;
    const nextCursor = typeof res?.[0] !== "undefined" ? Number(res[0]) : Number(res?.cursor ?? 0);
    const batch: any[] = res?.[1] ?? res?.keys ?? res?.members ?? [];
    if (Array.isArray(batch)) {
      for (const k of batch) {
        if (typeof k === "string") keys.push(k);
      }
    }
    cursor = nextCursor;
    if (!cursor || cursor === 0 || keys.length >= cap) break;
  }
  return keys.slice(0, cap);
}

export async function POST(req: Request) {
  try {
    const j = await req.json().catch(() => ({}));
    const wallet = String(j.wallet || "").trim().toLowerCase();
    if (!wallet) return NextResponse.json({ ok: false, error: "wallet required" }, { status: 400 });

    // Find all mm:set:* docs and select the ones for this wallet
    const keys = await scanAll("mm:set:*", 5000);
    const setIds: string[] = [];

    for (const key of keys) {
      const id = key.split(":")[2];
      if (!id) continue;
      const doc = (await redis.hgetall<any>(kSetDoc(id)).catch(() => null)) as any;
      const w = String(doc?.wallet || "").toLowerCase();
      if (w === wallet) setIds.push(id);
    }

    const uniq = Array.from(new Set(setIds));

    // Persist membership in both shapes (SET + LIST) for compatibility
    await redis.del(kWalletSetsSET(wallet)).catch(() => {});
    await redis.del(kWalletSetsLIST(wallet)).catch(() => {});
    for (const sid of uniq) {
      await redis.sadd(kWalletSetsSET(wallet), sid);
      await redis.rpush(kWalletSetsLIST(wallet), sid);
    }

    return NextResponse.json({ ok: true, wallet, count: uniq.length, setIds: uniq });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "internal error" }, { status: 500 });
  }
}
