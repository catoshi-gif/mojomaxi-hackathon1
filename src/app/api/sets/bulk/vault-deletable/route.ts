/**
 * /api/sets/bulk/vault-deletable
 * Batch resolve vaultId and deletable flags for many setIds in one request.
 * Reads from Upstash keys only; no RPC. Keeps UI unchanged while preventing per-id storms.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { redis } from "@/lib/redis";
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



const SET_VAULT_ID = (setId: string) => `mm:set:${setId}:vaultId`;
const SET_DELETABLE = (setId: string) => `mm:set:${setId}:deletable`;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const raw = String(url.searchParams.get('ids') || '').trim();
    if (!raw) return NextResponse.json({ ok: false, error: 'ids_required' }, { status: 400 });
    const ids = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return NextResponse.json({ ok: false, error: 'no_ids' }, { status: 400 });

    const vaultKeys = ids.map(SET_VAULT_ID);
    const deletableKeys = ids.map(SET_DELETABLE);
    const [vArr, dArr] = await Promise.all([
      (redis as any).mget(vaultKeys as any).catch(() => null) as Promise<any>,
      (redis as any).mget(deletableKeys as any).catch(() => null) as Promise<any>,
    ]);

    const vaultMap: Record<string, string | null> = {};
    const deletableMap: Record<string, boolean> = {};
    ids.forEach((id, i) => {
      const v = vArr && Array.isArray(vArr) ? (vArr[i] as any) : null;
      vaultMap[id] = (typeof v === 'string' && v) ? v : null;
      const d = dArr && Array.isArray(dArr) ? (dArr[i] as any) : null;
      deletableMap[id] = !!(d === true || d === '1' || d === 1);
    });

    return NextResponse.json({ ok: true, vaultMap, deletableMap }, { headers: { 'Cache-Control': 'private, max-age=5' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'bulk_error' }, { status: 500 });
  }
}
