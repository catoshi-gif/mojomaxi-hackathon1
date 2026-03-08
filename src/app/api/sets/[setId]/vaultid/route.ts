// filepath: src/app/api/sets/[setId]/vaultid/route.ts
export const runtime = "edge";

import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";

function canonicalSetId(raw: string): string {
  const s = String(raw || "").trim();
  const m = s.match(/^set[_-](.+)$/i);
  return m ? m[1] : s;
}

async function readVaultIdFromDb(setId: string): Promise<string | null> {
  if (!redis) return null;

  // Preferred keys
  const candidates = [
    `mm:set:${setId}:vault`,
    `mm:vault:${setId}`,
    `mm:vaultid:${setId}`,
  ];

  for (const key of candidates) {
    try {
      const v = await redis.get(key);
      if (typeof v === "string" && v.length >= 32) return v;
      if (v && typeof v === "object" && typeof (v as any).vault === "string" && (v as any).vault.length >= 32) {
        return (v as any).vault;
      }
    } catch {
      // ignore and continue
    }
  }

  // Hash form `mm:set:<id>`
  try {
    const h = (await redis.hgetall(`mm:set:${setId}`)) as Record<string, string> | null;
    if (h && typeof h.vault === "string" && h.vault.length >= 32) return h.vault;
  } catch {
    // ignore
  }

  return null;
}

export async function GET(_req: NextRequest, ctx: any) {
  const setId = canonicalSetId(ctx?.params?.setId || "");
  if (!setId) return NextResponse.json({ ok: false, error: "missing_setId" }, { status: 400 });

  const vault = await readVaultIdFromDb(setId);
  return NextResponse.json({ ok: true, setId, vault });
}
