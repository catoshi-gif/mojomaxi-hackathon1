// Path: src/app/api/auth/whoami/route.ts
// Purpose: Returns the wallet bound to the current httpOnly session cookie, if any.
// Notes: Node runtime; sets no-store and Vary: Cookie to avoid CDN caching issues.

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionWalletFromRequest } from '@/lib/auth/session.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const wallet = await getSessionWalletFromRequest(req as any);
  const res = NextResponse.json({ ok: true, wallet: wallet || null }, { status: 200 });
  res.headers.set('Cache-Control', 'no-store, private, must-revalidate');
  res.headers.set('Pragma', 'no-cache');
  res.headers.set('Vary', 'Cookie');
  return res;
}
