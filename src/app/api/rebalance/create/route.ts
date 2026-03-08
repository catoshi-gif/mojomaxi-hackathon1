// filepath: src/app/api/rebalance/create/route.ts
// FULL FILE REPLACEMENT — keep proxy behavior; also stamp kind/type='rebalance' after success.

import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { requireOwnerSession } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const KEY_SET_NEW = (id: string) => `REBAL_SET:${id}`; // tolerate typo variants too
const KEY_SET_NEW_ALT = (id: string) => `REBAL_SET:${id}`;
const KEY_SET_LEGACY = (id: string) => `mm:rebal:set:${id}`;

export async function POST(req: NextRequest) {
  const guard = await requireOwnerSession(req as any);
  if (guard.ok === false) return guard.res;

  try {
    const wallet = (req.headers.get("x-wallet") || "").trim();
    if (!wallet) return NextResponse.json({ ok: false, error: "missing wallet" }, { status: 400 });

    // Proxy to JSON-based creator
    const res = await fetch(new URL("/api/rebalance/set", req.url).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet }),
      cache: "no-store",
    });

    const j = await res.json().catch(() => ({ ok: false }));
    const status = res.status || (j?.ok ? 200 : 500);

    // Best-effort: stamp kind/type on both known key families
    try {
      const setId = String(j?.id || j?.set?.id || "");
      if (setId) {
        await redis.hset(KEY_SET_LEGACY(setId), { kind: "rebalance", type: "rebalance" });
        await redis.hset(KEY_SET_NEW(setId), { kind: "rebalance", type: "rebalance", id: setId, wallet });
        await redis.hset(KEY_SET_NEW_ALT(setId), { kind: "rebalance", type: "rebalance", id: setId, wallet });
      }
    } catch {}

    return NextResponse.json(j, { status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "internal error" }, { status: 500 });
  }
}
