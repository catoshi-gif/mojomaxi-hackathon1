// filepath: src/app/api/sets/by-wallet/[wallet]/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deprecated shim: the golden code uses /api/webhooks/for/[wallet].
 * This route remains only to avoid build-time import errors from older codepaths.
 * It proxies nothing and simply tells clients to use the canonical endpoint.
 */
export async function GET(_req: NextRequest, { params }: any) {
  try {
    const wallet = params?.wallet || "";
    return NextResponse.json(
      { ok: false, error: "Deprecated. Use /api/webhooks/for/[wallet] instead.", wallet },
      { status: 410 }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 500 });
  }
}
