// src/app/api/hook/[kind]/[token]/route.ts
// Legacy path kept for compatibility. Treats the call as a trigger based on token (id).
// Accepts optional JSON body (forwarded as payload). Responds with { ok: boolean }.

import { NextResponse } from "next/server";
import { executeTrade } from "@/lib/trade";
import { getWebhookRecordById, pushRecentEvent } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request, token: string, expectedKind?: string) {
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing token" }, { status: 400 });
  }

  const rec = await getWebhookRecordById(token);
  if (!rec) {
    return NextResponse.json({ ok: false, error: "unknown token" }, { status: 404 });
  }
  if (expectedKind && rec.kind !== expectedKind) {
    return NextResponse.json(
      { ok: false, error: `kind mismatch: expected ${expectedKind}, got ${rec.kind}` },
      { status: 409 }
    );
  }

  // best-effort body parse; GET may not have one
  const payload = await req.json().catch(() => ({}));

  // lightweight activity breadcrumb (legacy stream)
  await pushRecentEvent(rec.set.setId, `trigger-legacy:${rec.kind}`, { token });

  try {
    // executeTrade expects setId string, not the full WebhookSet
    const res = await executeTrade({ set: rec.set.setId, kind: rec.kind, payload });
    return NextResponse.json({ ok: !!(res as any)?.ok });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}

export async function POST(req: Request, ctx: any) {
  const token = (ctx.params.token || "").trim();
  const kind = (ctx.params.kind || "").trim();
  return handle(req, token, kind);
}

// Optional GET for quick tests (forwards empty payload)
export async function GET(req: Request, ctx: any) {
  const token = (ctx.params.token || "").trim();
  const kind = (ctx.params.kind || "").trim();
  return handle(req, token, kind);
}
