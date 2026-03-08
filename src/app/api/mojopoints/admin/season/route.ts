// filepath: src/app/api/mojopoints/admin/season/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { adminSetSeason, adminCloseSeason } from "@/lib/mojopoints.server";

function auth(req: NextRequest): boolean {
  const hdr = req.headers.get("x-internal-api-key") || req.headers.get("x-api-key") || "";
  const qs = new URL(req.url).searchParams.get("key") || "";
  const key = process.env.INTERNAL_API_KEY || process.env.MOJOMAXI_INTERNAL_API_KEY || "";
  if (!key) return false;
  return hdr === key || qs === key;
}

export async function POST(req: NextRequest) {
  if (!auth(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body?.id || "").trim();
    const start = body?.start != null ? Number(body.start) : Date.now();
    const end = body?.end != null ? Number(body.end) : undefined;
    const label = (body?.label || "").trim() || undefined;
    if (!id) return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
    const res = await adminSetSeason({ id, label, start, end });
    return NextResponse.json({ ok: true, ...res }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "failed", detail: String(e?.message || e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!auth(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body: any = await req.json().catch(() => ({}));
    const id = String(body?.id || "").trim();
    const end = body?.end != null ? Number(body.end) : Date.now();
    if (!id) return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });
    const res = await adminCloseSeason(id, end);
    return NextResponse.json({ ok: true, ...res }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "failed", detail: String(e?.message || e) }, { status: 500 });
  }
}
