// filepath: src/app/api/vaults/record/route.ts
// Records vault id for a set **and pins canonical mints** (immutable mapping) to mm:vaultmints:{vault}.
// IMPORTANT:
//  - We must NEVER lose set->vault mapping.
//  - Some endpoints read legacy key mm:set:{setId}:vault, others read mm:set:{setId}:vaultId.
//  - This route writes BOTH (and mirrors into the mm:set:{setId} hash) so refreshes cannot "drop" the vault.

import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { normalizeWebhookMintsFromDoc, pinVaultMints } from "@/lib/immutability.guard";


export async function POST(req: NextRequest) {
  try {
    const j = await req.json().catch(() => ({}));
    const setId = String(j.setId || "").trim();
    const vault = String(j.vault || "").trim();
    const admin = String(j.admin || "").trim();

    if (!setId || !vault) {
      return NextResponse.json({ ok: false, error: "setId and vault required" }, { status: 400 });
    }

    // Persist set->vault mapping (dual-key; DO NOT BREAK legacy readers)
    //  - legacy: mm:set:{setId}:vault
    //  - newer:  mm:set:{setId}:vaultId
    await redis.set(`mm:set:${setId}:vault`, vault);
    await redis.set(`mm:set:${setId}:vaultId`, vault);

    // Mirror into hash doc (best-effort; helps endpoints that only read mm:set:{id})
    try {
      const patch: Record<string, any> = { vault, vaultId: vault };
      if (admin) patch.admin = admin;
      await redis.hset(`mm:set:${setId}`, patch);
    } catch {}

    // Best‑effort: read the current set doc and pin its mints to mm:vaultmints:{vault}
    try {
      const doc = (await redis.hgetall<Record<string, any>>(`mm:set:${setId}`).catch(() => null as any)) || {};
      const { mintA, mintB, mintIn, mintOut } = normalizeWebhookMintsFromDoc(doc);
      if (mintA || mintB || mintIn || mintOut) {
        await pinVaultMints(vault, { type: "webhook", setId, mintA, mintB, mintIn, mintOut });
      }
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "record_error" }, { status: 500 });
  }
}
