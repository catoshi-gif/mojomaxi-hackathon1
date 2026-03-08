// filepath: src/app/api/sets/[setId]/status/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VAULT_BACKEND_URL = process.env.VAULT_BACKEND_URL || "";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

// Proxies to the vault backend's status endpoint.
// Accepts path param :setId or ?setId=...; prefers the path param.
export async function GET(req: Request, { params }: any) {
  try {
    const url = new URL(req.url);
    const setId = (params?.setId || url.searchParams.get("setId") || "").trim();
    if (!setId) {
      return NextResponse.json({ ok: false, error: "missing_setId" }, { status: 400 });
    }
    if (!VAULT_BACKEND_URL) {
      return NextResponse.json({ ok: false, error: "VAULT_BACKEND_URL not set" }, { status: 500 });
    }
    const res = await fetch(`${VAULT_BACKEND_URL}/api/vaults/status?setId=${encodeURIComponent(setId)}`, {
      headers: INTERNAL_API_KEY ? { "x-internal-key": INTERNAL_API_KEY } : undefined,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "status_error" }, { status: 500 });
  }
}
