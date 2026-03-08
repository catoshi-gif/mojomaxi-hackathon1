// filepath: src/app/api/rebalance/set/[setId]/route.ts
import 'server-only';
import { redis } from "@/lib/redis";
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


const KEY_MM_SET = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_OLD_SET = (setId: string) => `REBAL_SET:${setId}`;

async function loadDocByKey(key: string): Promise<any | null> {
  // JSON
  try {
    const j = await (redis as any).json?.get(key);
    if (j && typeof j === 'object') return j;
  } catch {}
  // GET
  try {
    const s = await redis.get<string>(key as any);
    if (typeof s === 'string' && s.trim().startsWith('{')) {
      try { return JSON.parse(s); } catch {}
    }
  } catch {}
  // HASH
  try {
    const h = await redis.hgetall<Record<string, any>>(key as any);
    if (h && Object.keys(h).length) {
      const id = String((h as any).id ?? '').trim();
      if (!id) return null;
      const wallet = String((h as any).wallet ?? '').trim();
      const createdAt = Number((h as any).createdAt ?? 0) || 0;
      const mints = (() => {
        const raw = String((h as any).mints ?? '[]');
        try { return JSON.parse(raw); } catch { return []; }
      })();
      const cadence = String((h as any).cadence ?? '').trim() || undefined;
      const vaultId = String((h as any).vaultId ?? '').trim() || null;
      return { id, wallet, createdAt, mints, cadence, vaultId, type: (h as any).type ?? 'rebalance' };
    }
  } catch {}
  return null;
}

export async function GET(_: NextRequest, ctx: any) {
  try {
    const setId = String(ctx?.params?.setId || '').trim();
    if (!setId) return NextResponse.json({ ok: false, error: 'missing setId' }, { status: 400 });

    const doc = (await loadDocByKey(KEY_MM_SET(setId))) || (await loadDocByKey(KEY_OLD_SET(setId)));
    if (!doc) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

    if (!('type' in doc) || !doc.type) (doc as any).type = 'rebalance';
    return NextResponse.json({ ok: true, set: doc });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 });
  }
}
