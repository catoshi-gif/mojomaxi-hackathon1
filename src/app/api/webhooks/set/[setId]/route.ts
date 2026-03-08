// filepath: src/app/api/webhooks/set/[setId]/route.ts
// Hardened: returns full set doc only to the wallet owner (via session cookie). Otherwise, sensitive
// fields (buyId/sellId/urls) are sanitized while preserving shape. UI/UX unchanged.

import 'server-only';
import { redis } from "@/lib/redis";
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionWalletFromRequest } from '@/lib/auth/session.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AnyObj = Record<string, any>;

function lw(s: string): string { return (s || ''); } // preserve casing

function normalize(v: AnyObj): AnyObj {
  if (v && typeof v === 'object' && v.set && typeof v.set === 'object') return v.set as AnyObj;
  return v;
}

async function readSet(setId: string): Promise<AnyObj | null> {
  const raw = await redis.get<AnyObj>(`mm:set:${setId}:doc`).catch(() => null);
  if (!raw) return null;
  const doc = normalize(raw);
  return doc;
}

async function writeSet(setId: string, doc: AnyObj): Promise<void> {
  await redis.set(`mm:set:${setId}:doc`, JSON.stringify(doc));
}

function sanitize(doc: AnyObj): AnyObj {
  const base = {
    ...doc,
    buyId: undefined,
    sellId: undefined,
  } as AnyObj;
  if (base.urls && typeof base.urls === 'object') {
    base.urls = { buy: undefined, sell: undefined };
  }
  return base;
}

export async function PATCH(req: NextRequest, { params }: any) {
  const setId = String(params.setId || '').trim();
  if (!setId) return NextResponse.json({ ok: false, error: 'missing setId' }, { status: 400 });

  const existing = await readSet(setId);
  if (!existing) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as AnyObj;

  const next = { ...existing };
  if (typeof body.label === 'string') next.label = body.label;
  if (body && typeof body.prefs === 'object' && body.prefs) {
    next.prefs = { ...(existing.prefs || {}), ...body.prefs };
  }

  // guard: preserve identity fields
  next.setId = existing.setId;
  next.wallet = lw(String(existing.wallet));
  next.buyId = existing.buyId;
  next.sellId = existing.sellId;

  await writeSet(setId, next);
  return NextResponse.json({ ok: true, set: next });
}

export async function POST(req: NextRequest, ctx: any) {
  // allow POST-as-PATCH
  return PATCH(req, ctx);
}

export async function GET(req: NextRequest, { params }: any) {
  const setId = String(params.setId || '').trim();
  const doc = setId ? await readSet(setId) : null;
  if (!doc) return NextResponse.json({ ok: false, set: null }, { status: 200 });

  const sessionWallet = await getSessionWalletFromRequest(req);
  const isOwner = !!sessionWallet && sessionWallet === String(doc.wallet || '');

  const payload = isOwner ? doc : sanitize(doc);
  return NextResponse.json({ ok: true, set: payload }, { status: 200 });
}
