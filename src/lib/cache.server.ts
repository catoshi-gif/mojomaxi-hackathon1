// filepath: src/lib/cache.server.ts
// Lightweight Upstash Redis wrapper for JSON/string caching with TTL and singleflight.
// Node-only module (used from Route Handlers). Safe for Next.js 14.2.5.
//
// OPTIMISATION: Added cacheGetManyJSON() which fetches multiple keys in a single
// Upstash MGET round-trip instead of N sequential GET calls. Used by /api/prices
// to parallelise per-mint cache lookups. All existing exports are unchanged.

import { redis as _redis } from "@/lib/redis";

const NS = "mm:cache:v1";

export function cacheKey(...parts: (string | number | null | undefined)[]): string {
  const p = parts.map((x) => (x == null ? "" : String(x))).join(":");
  return `${NS}:${p}`;
}

export async function cacheGetJSON<T>(key: string): Promise<T | null> {
  try { const v = await _redis.get<T | null>(key); return (v ?? null) as T | null; } catch { return null; }
}

export async function cacheSetJSON<T>(key: string, val: T, ttlSec: number): Promise<void> {
  try { await _redis.set(key, val as any, { ex: ttlSec }); } catch {}
}

export async function cacheGetString(key: string): Promise<string | null> {
  try { const v = await _redis.get<string | null>(key); return v ?? null; } catch { return null; }
}

export async function cacheSetString(key: string, val: string, ttlSec: number): Promise<void> {
  try { await _redis.set(key, val, { ex: ttlSec }); } catch {}
}

/**
 * Fetch multiple cache keys in a single MGET round-trip.
 * Returns an array of values in the same order as the input keys.
 * Missing or errored keys return null at that index — never throws.
 *
 * This is a drop-in parallel replacement for:
 *   await Promise.all(keys.map(k => cacheGetJSON<T>(k)))
 * but uses one network round-trip instead of N.
 */
export async function cacheGetManyJSON<T>(keys: string[]): Promise<(T | null)[]> {
  if (!keys.length) return [];
  try {
    // Upstash REST client exposes mget; cast through any for type safety.
    const results = await (_redis as any).mget(...keys) as (T | null)[];
    if (!Array.isArray(results)) {
      // Unexpected response shape — fall back to individual GETs
      return Promise.all(keys.map((k) => cacheGetJSON<T>(k)));
    }
    return results.map((v) => (v === undefined ? null : (v ?? null)));
  } catch {
    // On any error fall back to parallel individual GETs (still faster than sequential)
    return Promise.all(keys.map((k) => cacheGetJSON<T>(k)));
  }
}

/** simple singleflight (per-module) */
const _inflight = new Map<string, Promise<any>>();

export async function singleflight<T>(key: string, job: () => Promise<T>): Promise<T> {
  if (_inflight.has(key)) return _inflight.get(key) as Promise<T>;
  const p = job().finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}

/**
 * Distributed singleflight: Redis cache check + in-memory dedup.
 * Prevents thundering herd across multiple Vercel instances for expensive ops
 * (e.g. price fetching). Falls back to local singleflight if Redis is unavailable.
 *
 * @param key   - unique operation key
 * @param ttlSec - how long to cache the result in Redis
 * @param job   - the expensive async work to deduplicate
 */
export async function singleflightDistributed<T>(
  key: string,
  ttlSec: number,
  job: () => Promise<T>,
): Promise<T> {
  // 1. Check Redis cache first (cross-instance dedup)
  const rk = cacheKey("sf", key);
  const cached = await cacheGetJSON<T>(rk);
  if (cached !== null) return cached;

  // 2. In-memory singleflight (per-instance dedup)
  if (_inflight.has(key)) return _inflight.get(key) as Promise<T>;

  const p = job()
    .then((result) => {
      // Store in Redis for other instances
      cacheSetJSON(rk, result, ttlSec).catch(() => {});
      return result;
    })
    .finally(() => { _inflight.delete(key); });

  _inflight.set(key, p);
  return p;
}
