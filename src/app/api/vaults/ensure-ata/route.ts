
// filepath: src/app/api/vaults/ensure-ata/route.ts
// Runtime: nodejs
// PURPOSE: Server route to idempotently create ATAs for the **vault authority** PDA
//          for one or more mints. This is a convenience endpoint used by UI or tests.
// Request JSON: { setId: string, mints: string[] }
// Response: { ok: true, authority: string, created: string[], existed: string[] }
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { ensureVaultAuthorityAtas } from '@/lib/vault-atas.server';

type AnyObj = Record<string, any>;
function json(s: number, b: AnyObj) { return NextResponse.json(b, { status: s }); }

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => ({} as AnyObj));
    const setId = String(b?.setId || b?.set || '').trim();
    const mints: string[] = Array.isArray(b?.mints) ? (b.mints as string[]).map(s => String(s)) : [];
    if (!setId || !mints.length) return json(400, { ok: false, error: 'missing_fields' });

    const res = await ensureVaultAuthorityAtas({ setId, mints });
    return json(200, { ok: true, ...res });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || 'internal_error' });
  }
}
