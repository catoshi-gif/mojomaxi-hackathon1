// filepath: src/app/api/share/resolve-set/cached/[setId]/route.ts
/* 
 * Cached wrapper around `/api/share/resolve-set?setId=...`
 * - Uses Upstash Redis for 1-hour "freshness" (serves cached if <= 3600s old)
 * - Keeps a 24-hour stale copy to avoid stampedes
 * - Uses a short NX lock (20s) to singleflight refreshes
 * - Does NOT change the shape of the underlying JSON
 * 
 * Headers:
 *   - x-cache: HIT | MISS | STALE | HIT-AFTER-WAIT | BYPASS
 *   - age: <seconds since cached>
 *   - x-cache-key: <redis-key>
 * 
 * Runtime: edge (works with @upstash/redis REST client)
 * Next.js: 14.2.x (App Router)
 */

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { redis } from "@/lib/redis";

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

type Any = Record<string, any>;


// New namespace so we don't collide with any older caches
const NS = 'mm:share:resolve-set:v3';

// Freshness window (1 hour), serve cached within this window
const FRESH_TTL_SEC = 3600;

// Keep a stale copy for 24h to avoid recomputation if upstream is flaky
const STALE_TTL_SEC = 86400;

// Short NX lock to singleflight the refresh
const LOCK_TTL_SEC = 20;

function keyFor(setId: string) {
  return `${NS}:${setId}:data`;
}

function lockKeyFor(setId: string) {
  return `${NS}:${setId}:lock`;
}

function nowMs() {
  return Date.now();
}

function ageSeconds(sinceMs: number) {
  const age = Math.max(0, Math.floor((nowMs() - sinceMs) / 1000));
  return age;
}

function buildOrigin(req: NextRequest): string {
  const { origin } = new URL(req.url);
  return origin;
}

function headers(base: Record<string, string>, extras?: Record<string, string>) {
  return new Headers({ ...base, ...(extras ?? {}) });
}

async function readCached(setId: string): Promise<{ cached: Any | null, age: number, key: string }> {
  const key = keyFor(setId);
  try {
    const val = await redis.get<Any>(key);
    if (!val || typeof val !== 'object') return { cached: null, age: 0, key };
    const ts = Number((val as any)?.cacheTimeMs ?? 0);
    const age = Number.isFinite(ts) ? ageSeconds(ts) : 0;
    return { cached: val, age, key };
  } catch {
    return { cached: null, age: 0, key };
  }
}

async function writeCached(setId: string, payload: Any): Promise<void> {
  const key = keyFor(setId);
  const toStore = { cacheTimeMs: nowMs(), payload };
  try {
    await redis.set(key, toStore, { ex: STALE_TTL_SEC });
  } catch {}
}

async function acquireLock(setId: string): Promise<boolean> {
  const key = lockKeyFor(setId);
  try {
    const ok = await redis.set(key, '1', { nx: true, ex: LOCK_TTL_SEC });
    // Upstash returns 'OK' on success
    return ok === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(setId: string): Promise<void> {
  // We let the lock expire naturally (20s). No explicit del to avoid races.
  return;
}

async function fetchUnderlying(req: NextRequest, setId: string): Promise<{ ok: boolean, json: Any | null, status: number }> {
  const origin = buildOrigin(req);
  const url = `${origin}/api/share/resolve-set?setId=${encodeURIComponent(setId)}`;
  try {
    const r = await fetch(url, { cache: 'no-store', headers: { 'x-mm-cache-proxy': '1' } });
    const ok = r.ok;
    let json: Any | null = null;
    try { json = await r.json(); } catch {}
    return { ok, json, status: r.status };
  } catch {
    return { ok: false, json: null, status: 502 };
  }
}

export async function GET(req: NextRequest, ctx: any) {
  const setId = ctx?.params?.setId ?? '';
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1'; // optional manual refresh

  if (!setId) {
    return NextResponse.json({ ok: false, error: 'missing setId' }, { status: 400, headers: headers({ 'cache-control': 'no-store' }) });
  }

  // Try cache first
  const { cached, age, key } = await readCached(setId);

  // If not forcing and cache is fresh (<= 1h), serve it
  if (!force && cached && age <= FRESH_TTL_SEC) {
    const payload = (cached as any).payload ?? cached;
    return new NextResponse(JSON.stringify(payload), {
      status: 200,
      headers: headers(
        { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        { 'x-cache': 'HIT', 'age': String(age), 'x-cache-key': key },
      ),
    });
  }

  // If stale or missing, try to acquire lock and refresh
  const gotLock = await acquireLock(setId);
  if (gotLock) {
    try {
      const r = await fetchUnderlying(req, setId);
      if (r.ok && r.json) {
        await writeCached(setId, r.json);
        return new NextResponse(JSON.stringify(r.json), {
          status: 200,
          headers: headers(
            { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            { 'x-cache': cached ? 'HIT-AFTER-WAIT' : 'MISS', 'age': '0', 'x-cache-key': key },
          ),
        });
      }
      // Upstream failed; if we have stale, serve it
      if (cached) {
        const payload = (cached as any).payload ?? cached;
        return new NextResponse(JSON.stringify(payload), {
          status: 200,
          headers: headers(
            { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            { 'x-cache': 'STALE', 'age': String(age), 'x-cache-key': key },
          ),
        });
      }
      // No cache at all
      return NextResponse.json({ ok: false, error: 'upstream unavailable' }, { status: r.status || 502, headers: headers({ 'cache-control': 'no-store' }) });
    } finally {
      await releaseLock(setId);
    }
  } else {
    // Another refresh is in flight: return stale if present, otherwise try a direct fetch without caching.
    if (cached) {
      const payload = (cached as any).payload ?? cached;
      return new NextResponse(JSON.stringify(payload), {
        status: 200,
        headers: headers(
          { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          { 'x-cache': 'STALE', 'age': String(age), 'x-cache-key': key },
        ),
      });
    }
    // No cache; attempt a single underlying fetch as a fallback (do not store to avoid stampede)
    const r = await fetchUnderlying(req, setId);
    if (r.ok && r.json) {
      return new NextResponse(JSON.stringify(r.json), {
        status: 200,
        headers: headers(
          { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          { 'x-cache': 'BYPASS', 'age': '0', 'x-cache-key': key },
        ),
      });
    }
    return NextResponse.json({ ok: false, error: 'upstream unavailable' }, { status: r.status || 502, headers: headers({ 'cache-control': 'no-store' }) });
  }
}
