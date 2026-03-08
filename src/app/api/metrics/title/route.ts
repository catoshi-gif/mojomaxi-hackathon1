// filepath: src/app/api/metrics/title/route.ts
import { NextResponse } from 'next/server';
import { redis } from "@/lib/redis";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Any = Record<string, any>;

const NS = 'mm:v1';

function kWalletSetTitle(wallet: string, setId: string) {
  return `${NS}:metrics:wallet:${wallet}:set:${setId}:title`;
}

function isPlaceholderTitle(s?: string | null): boolean {
  const raw = String(s || '').trim();
  if (!raw) return true;
  const t = raw.toLowerCase();
  if (t === 'mojomaxi bot') return true;
  if (/^set\s+[0-9a-f]{6,}$/.test(t)) return true;
  if (/^webhooks:\s*buy\s+(base)\s+sell\s+for\s+(quote)\s*$/i.test(raw)) return true;
  if (/^rebalance:\s*[-–—]?\s*$/.test(t)) return true;
  return false;
}

export async function POST(req: Request) {
  try {
    let body: Any = {};
    try { body = await req.json(); } catch { body = {}; }

    const wallet = String(body?.wallet || '').trim();    // NEVER lowercase
    const setId  = String(body?.setId  || '').trim();
    const title  = String(body?.title  || '').trim();
    const type   = String(body?.type   || '').trim().toLowerCase();

    if (!wallet || !setId || !title) {
      return NextResponse.json({ ok: false, error: 'missing wallet/setId/title' }, { status: 400 });
    }

    // Best-effort storage (no crash if Redis is misconfigured)

    const key = kWalletSetTitle(wallet, setId);
    let existing: Any | null = null;
    try { existing = await redis.get<Any | null>(key); } catch { existing = null; }

    // Only write if nothing exists OR we are upgrading from a placeholder to a real title.
    if (!existing || (isPlaceholderTitle(existing?.title) && !isPlaceholderTitle(title))) {
      const payload = { title, type: (type === 'rebalance' ? 'rebalance' : 'webhooks'), ts: Date.now() };
      try { await redis.set(key, payload); } catch { /* ignore */ }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('metrics/title error', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
