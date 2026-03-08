// filepath: src/app/api/rebalance/for/[wallet]/route.ts
import 'server-only';
import { redis } from "@/lib/redis";
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


// --- Key helpers (support both the canonical mm:* layout and the older REBAL_* layout) ---
const KEY_MM_IDX = (wallet: string) => `mm:rebal:wallet:${wallet}:sets`;
const KEY_OLD_IDX = (wallet: string) => `WALLET_REBAL_SETS:${wallet}`;
const KEY_MM_SET = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_OLD_SET = (setId: string) => `REBAL_SET:${setId}`;

async function readIndex(key: string): Promise<string[]> {
  // Probe without relying on TYPE (Upstash may not support it consistently)
  // Try SET (SMEMBERS)
  try {
    const out = await (redis as any).smembers(key as any);
    if (Array.isArray(out) && out.length) {
      return out.map((v:any)=>String(v||'').trim()).filter(Boolean);
    }
  } catch {}
  // Try LIST (LRANGE)
  try {
    const out = await (redis as any).lrange(key as any, 0, -1);
    if (Array.isArray(out) && out.length) {
      return out.map((v:any)=>String(v||'').trim()).filter(Boolean);
    }
  } catch {}
  // Try STRING (JSON array)
  try {
    const raw = await (redis as any).get(key as any);
    if (typeof raw === 'string' && raw.length) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          return arr.map((v:any)=>String(v||'').trim()).filter(Boolean);
        }
      } catch {}
    }
  } catch {}
  return [];
}

async function loadDocByKey(key: string): Promise<any | null> {
  // Try JSON first
  try {
    const j = await (redis as any).json?.get(key);
    if (j && typeof j === 'object') return j;
  } catch {}
  // Try GET string (some older code stored JSON via SET)
  try {
    const s = await redis.get(key as any);
    if (typeof s === 'string' && s.trim().startsWith('{')) {
      try { return JSON.parse(s); } catch {}
    }
  } catch {}
  // Fallback to hash
  try {
    const h = await redis.hgetall(key as any);
    if (h && Object.keys(h).length) {
      const mints: string[] = (() => {
        if (Array.isArray((h as any).mints)) return (h as any).mints as string[];
        const raw = String((h as any).mints ?? '[]');
        try { return JSON.parse(raw); } catch { return []; }
      })();
      const cadence = (() => {
        const c = String((h as any).cadence ?? '').trim();
        return c || undefined;
      })();
      const createdAt = Number((h as any).createdAt ?? 0) || undefined;
      const wallet = String((h as any).wallet ?? '').trim();
      const id = String((h as any).id ?? '').trim();
      const vaultId = String((h as any).vaultId ?? '').trim() || null;
      if (!id) return null;
      return { id, wallet, mints, cadence, createdAt, vaultId, type: (h as any).type ?? 'rebalance' };
    }
  } catch {}
  return null;
}

async function loadDoc(setId: string): Promise<any | null> {
  const id = String(setId || '').trim();
  if (!id) return null;
  // Prefer canonical mm:* key
  const mm = await loadDocByKey(KEY_MM_SET(id));
  if (mm) return mm;
  // Fallback to old storage location
  const old = await loadDocByKey(KEY_OLD_SET(id));
  if (old) return old;
  return null;
}

export async function GET(_: NextRequest, ctx: any) {
  try {
    const wallet = String(ctx?.params?.wallet || '').trim();
    if (!wallet) return NextResponse.json({ ok: true, sets: [] });

    // Merge ids from both index styles
    const idsA = await readIndex(KEY_MM_IDX(wallet));
    const idsB = await readIndex(KEY_OLD_IDX(wallet));
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const v of [...idsA, ...idsB]) {
      const id = String(v || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }

    // Load documents & drop missing
    const docs: any[] = [];
    for (const id of merged) {
      const d = await loadDoc(id);
      if (d && d.id) {
        // Ensure the kind is rebalance for dashboard separation
        if (!('type' in d) || !d.type) (d as any).type = 'rebalance';
        docs.push(d);
      }
    }

    // Sort newest first (createdAt falling back to 0 if unknown)
    docs.sort((a, b) => (Number(b?.createdAt || 0) - Number(a?.createdAt || 0)));

    return NextResponse.json({ ok: true, sets: docs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 });
  }
}
