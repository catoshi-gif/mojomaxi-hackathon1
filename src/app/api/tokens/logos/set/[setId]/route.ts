// filepath: src/app/api/tokens/logos/set/[setId]/route.ts
/**
 * Per-set token logo map storage.
 * - GET  → { ok: true, logos: { [mint]: url } }
 * - POST → merge { logos } into Upstash under key mm:v1:set:<setId>:logos
 *
 * Purpose: lock in the exact token images the user saw in the TokenPicker at vault creation time,
 * so VaultInlinePanel / RebalanceInlinePanel render the same icons even if third-party sources change.
 *
 * No UI changes. Minimal, surgical server-only addition.
 */
import 'server-only';
import { redis } from "@/lib/redis";
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type LogoMap = Record<string, string>;

function keyForSet(setId: string): string {
  return `mm:v1:set:${setId}:logos`;
}

function sanitizeLogos(input: unknown): LogoMap {
  const out: LogoMap = {};
  if (!input || typeof input !== 'object') return out;
  for (const [mint, urlAny] of Object.entries(input as any)) {
    const m = String(mint || '').trim();
    const u = String((urlAny as any) || '').trim();
    if (!m || !u) continue;
    // Only allow http(s) to avoid 'data:' or JS URLs
    if (!/^https?:\/\//i.test(u)) continue;
    out[m] = u;
  }
  return out;
}


export async function GET(_req: NextRequest, ctx: any) {
  try {
    const setId = String(ctx?.params?.setId || '').trim();
    if (!setId) return NextResponse.json({ ok: false, logos: {} }, { status: 400 });
    const key = keyForSet(setId);
    const logos = (await redis.get<LogoMap>(key)) || {};
    return NextResponse.json({ ok: true, logos }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, logos: {}, error: (e as Error)?.message || 'error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: any) {
  try {
    const setId = String(ctx?.params?.setId || '').trim();
    if (!setId) return NextResponse.json({ ok: false, error: 'missing setId' }, { status: 400 });
    const body = await req.json().catch(() => ({}));
    const incoming = sanitizeLogos((body as any)?.logos);
    if (!Object.keys(incoming).length) {
      return NextResponse.json({ ok: true, logos: {} });
    }
    const key = keyForSet(setId);
    const prev = (await redis.get<LogoMap>(key)) || {};
    const next: LogoMap = { ...prev };
    for (const [m, u] of Object.entries(incoming)) {
      next[m] = u;
    }
    await redis.set(key, next);
    return NextResponse.json({ ok: true, saved: Object.keys(incoming).length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error)?.message || 'error' }, { status: 500 });
  }
}
