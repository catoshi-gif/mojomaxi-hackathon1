// Path: src/app/api/auth/nonce/route.ts
// Purpose: Issue nonce + signable message (5 min TTL).
// Enhancement: If a valid mm_wallet_session cookie already exists for this
// wallet, short‑circuit with { ok: true, already: true } so the client
// doesn’t ask the wallet to sign again.

import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { issueNonce, getSessionWalletFromRequest } from '@/lib/auth/session.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getClientIp(req: NextRequest): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();

  return '';
}

function noStoreHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, private, must-revalidate',
    Pragma: 'no-cache',
    Vary: 'Cookie',
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const wallet = String(body?.wallet || '').trim();
    if (!wallet) {
      return NextResponse.json({ ok: false, error: 'missing_wallet' }, { status: 400, headers: noStoreHeaders() });
    }

    // If we already have a valid mm_wallet_session for this wallet, no need to sign again.
    const sessionWallet = await getSessionWalletFromRequest(req as any);
    if (sessionWallet && sessionWallet === wallet) {
      return NextResponse.json({ ok: true, already: true }, { status: 200, headers: noStoreHeaders() });
    }

    const ip = getClientIp(req);
    const out = await issueNonce(wallet, { ip });
    const status = out.ok ? 200 : out.error === 'rate_limited' ? 429 : 400;
    return NextResponse.json(out, { status, headers: noStoreHeaders() });
  } catch {
    return NextResponse.json({ ok: false, error: 'unexpected' }, { status: 500, headers: noStoreHeaders() });
  }
}
