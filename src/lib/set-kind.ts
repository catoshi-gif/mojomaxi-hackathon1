// filepath: src/lib/set-kind.ts
// Minimal, build-safe helpers to tag a set's "kind" without probing non-existent `kv` exports.
// Uses only Upstash `redis` client.
// We write to both a generic meta hash and (if present) the rebalance set hash for convenience.

import { redis } from "@/lib/redis";

const META = (setId: string) => `mm:set:${setId}`;
const RB_HSET = (setId: string) => `mm:rebalance:set:${setId}`;

/** Writes { kind } under a generic meta key and also under the rebalance-set hash. */
export async function markSetKind(setId: string, kind: string) {
  if (!setId || !kind) return { ok: false };
  await redis.hset(META(setId), { kind });
  // Also mirror on the rebalance hash so tooling that reads that map can see it.
  await redis.hset(RB_HSET(setId), { kind });
  return { ok: true, setId, kind };
}

/** Optional getter: returns the kind if present in either location (prefers generic meta). */
export async function getSetKind(setId: string): Promise<string | null> {
  if (!setId) return null;
  const meta = await redis.hget<string>(META(setId), "kind").catch(() => null as any);
  if (meta) return meta;
  const rb = await redis.hget<string>(RB_HSET(setId), "kind").catch(() => null as any);
  return rb ?? null;
}
