// filepath: src/app/api/vault/attach/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * No-op shim to preserve golden behavior. The golden UI writes vault mapping elsewhere.
 * Keeping this route avoids build failures if some client calls still exist.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ ok: true, noop: true, received: body });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 500 });
  }
}
