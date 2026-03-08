// filepath: src/app/api/token-logos/registry/[mint]/route.ts
// Global token logo registry read/backfill endpoint.
// GET /api/token-logos/registry/[mint] → { ok: boolean, url: string | null }
//
// Resolution:
//   1) Read from mm:v1:logos registry.
//   2) If missing, backfill from Jupiter Lite ONLY (v2/token + search), write into registry.
//   3) Return discovered URL (or null if truly unknown).
import { NextRequest, NextResponse } from "next/server";
import { getOrBackfillGlobalTokenLogo } from "@/lib/tokenLogoRegistry.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: any) {
  try {
    const mint = String(ctx?.params?.mint || "").trim();
    if (!mint) {
      return NextResponse.json({ ok: false, url: null, error: "missing mint" }, { status: 400 });
    }
    const url = await getOrBackfillGlobalTokenLogo(mint);
    return NextResponse.json({ ok: true, url: url || null });
  } catch (e: any) {
    const msg = (e && (e.message || String(e))) || "error";
    return NextResponse.json({ ok: false, url: null, error: msg }, { status: 500 });
  }
}
