// filepath: src/lib/rebalance-store.ts
// Rebalancing store (Upstash Redis via \"@/lib/redis\") — unified mm:* keys
// - Canonical set doc:    mm:rebal:set:{setId}   (JSON or hash fallback)
// - Canonical wallet idx: mm:rebal:wallet:{wallet}:sets (SET; supports legacy LIST/STRING upgrade)
// - Also reads legacy keys REBAL_SET:* and WALLET_REBAL_SETS:* for backward compatibility.

import { redis } from "@/lib/redis";

export type Cadence = "2h" | "6h" | "12h" | "24h";

export type RebalanceSet = {
  id: string;
  wallet: string;
  mints: string[];           // [SOL, ...]
  cadence?: Cadence;         // undefined means not set yet
  createdAt: number;
  vaultId: string | null;
};

export const SOL_MINT = "So11111111111111111111111111111111111111112";

const walletIndexKey = (wallet: string) => `mm:rebal:wallet:${wallet}:sets`;
const walletIndexLegacy = (wallet: string) => `WALLET_REBAL_SETS:${wallet}`;
const setKey = (setId: string) => `mm:rebal:set:${setId}`;
const setKeyLegacy = (setId: string) => `REBAL_SET:${setId}`;

// ---- helpers ----

function parseSetHash(h: Record<string, any> | null): RebalanceSet | null {
  if (!h) return null;
  const id = String(h.id ?? "").trim();
  if (!id) return null;
  const wallet = String(h.wallet ?? "").trim();
  const mintsRaw = String(h.mints ?? "[]");
  let mints: string[] = [];
  try { mints = JSON.parse(mintsRaw) as string[]; } catch { mints = []; }
  const cadStr = String(h.cadence ?? "").trim();
  const cadence = (cadStr === "" ? undefined : (cadStr as Cadence));
  const createdAt = Number(h.createdAt ?? 0) || 0;
  const vaultId = String(h.vaultId ?? "").trim() || null;
  return { id, wallet, mints, cadence, createdAt, vaultId };
}

function normalizeMints(incoming: string[]): string[] {
  const arr = (incoming || []).map(s => String(s || "").trim()).filter(Boolean);
  const uniq = Array.from(new Set(arr));
  // Ensure SOL is present and first
  const withoutSol = uniq.filter(a => a !== SOL_MINT);
  const result = [SOL_MINT, ...withoutSol];
  // Constrain between 2 and 6
  if (result.length < 2) throw new Error("invalid mints length (need 2–6)");
  if (result.length > 6) return result.slice(0, 6);
  return result;
}

// ---- API ----

export async function createRebalanceSet(wallet: string): Promise<RebalanceSet> {
  if (!wallet) throw new Error("wallet required");
  const id = (globalThis.crypto?.randomUUID?.() ?? `rb_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);
  const createdAt = Date.now();
  const set: RebalanceSet = {
    id,
    wallet,
    mints: [SOL_MINT /* second slot chosen later via PATCH */],
    cadence: undefined,
    createdAt,
    vaultId: null,
  };
  // persist
  await redis.hset(setKey(id), {
    id: set.id,
    wallet: set.wallet,
    mints: JSON.stringify(set.mints),
    cadence: "",
    createdAt: String(set.createdAt),
    vaultId: "",
  });
  await redis.sadd(walletIndexKey(wallet), id);
  // mirror to legacy index (best-effort)
  try { await (redis as any).sadd(walletIndexLegacy(wallet), id); } catch {}
  return set;
}

export async function getSet(setId: string): Promise<RebalanceSet | null> {
  if (!setId) return null;
  // JSON or hash from canonical key
  try {
    const j = await (redis as any).json?.get(setKey(setId));
    if (j && (j as any).id) {
      const row = j as any;
      return {
        id: String(row.id),
        wallet: String(row.wallet || ""),
        mints: Array.isArray(row.mints) ? row.mints : [],
        cadence: (row.cadence || undefined) as Cadence | undefined,
        createdAt: Number(row.createdAt || 0) || 0,
        vaultId: String(row.vaultId || "") || null,
      };
    }
  } catch {}
  const h = await redis.hgetall<Record<string, any>>(setKey(setId)).catch(() => null as any);
  if (h && h.id) return parseSetHash(h);
  // Legacy fallback
  try {
    const j = await (redis as any).json?.get(setKeyLegacy(setId));
    if (j && (j as any).id) return j as RebalanceSet;
  } catch {}
  const h2 = await redis.hgetall<Record<string, any>>(setKeyLegacy(setId)).catch(() => null as any);
  if (h2 && h2.id) return parseSetHash(h2);
  return null;
}

export async function getSetsForWallet(wallet: string): Promise<RebalanceSet[]> {
  if (!wallet) return [];
  const outIds = new Set<string>();
  const pushIds = (arr: any) => {
    if (Array.isArray(arr)) for (const v of arr) {
      const id = String(v || "").trim();
      if (id) outIds.add(id);
    }
  };
  // canonical set
  try { pushIds(await redis.smembers(walletIndexKey(wallet))); } catch {}
  // legacy set
  try { pushIds(await redis.smembers(walletIndexLegacy(wallet))); } catch {}
  // legacy list
  try { pushIds(await redis.lrange(walletIndexKey(wallet) as any, 0, -1)); } catch {}
  try { pushIds(await redis.lrange(walletIndexLegacy(wallet) as any, 0, -1)); } catch {}

  if (outIds.size === 0) return [];
  // Parallel fetch instead of sequential N+1
  const fetched = await Promise.all(Array.from(outIds).map((id) => getSet(id)));
  const rows: RebalanceSet[] = fetched.filter((r): r is RebalanceSet => !!r && !!r.id);
  // newest first
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

export async function updateSet(
  setId: string,
  updates: { mints?: string[]; cadence?: Cadence; vaultId?: string | null }
): Promise<RebalanceSet> {
  const current = await getSet(setId);
  if (!current) throw new Error("set not found");
  let nextMints = current.mints;
  let nextCadence = current.cadence;
  let nextVaultId = current.vaultId;

  // If a vault already exists, freeze tokens & cadence
  const frozen = !!current.vaultId;

  if (typeof updates.vaultId !== "undefined") {
    nextVaultId = (updates.vaultId && String(updates.vaultId).trim()) || null;
  }
  if (!frozen && Array.isArray(updates.mints)) {
    nextMints = normalizeMints(updates.mints);
  }
  if (!frozen && typeof updates.cadence !== "undefined") {
    const c = updates.cadence;
    if (c && !["2h", "6h", "12h", "24h"].includes(c)) {
      throw new Error("invalid cadence");
    }
    nextCadence = c;
  }

  await redis.hset(setKey(setId), {
    mints: JSON.stringify(nextMints),
    cadence: nextCadence ?? "",
    vaultId: nextVaultId ?? "",
  });

  const out = await getSet(setId);
  if (!out) throw new Error("failed to update set");
  return out;
}

export async function deleteSet(setId: string): Promise<{ ok: true }> {
  const row = await getSet(setId);
  if (!row) return { ok: true };
  // remove from wallet indexes
  await redis.srem(walletIndexKey(row.wallet), setId).catch(() => {});
  await (redis as any).srem(walletIndexLegacy(row.wallet), setId).catch(() => {});
  // delete set hash/json
  await redis.del(setKey(setId)).catch(() => {});
  await redis.del(setKeyLegacy(setId)).catch(() => {});
  return { ok: true };
}

/**
 * Delete-and-clean wrapper compatible with legacy callers.
 * Accepts either (setId) or (wallet, setId). The wallet argument is optional and ignored;
 * we derive the wallet from the set when removing index membership.
 */
export async function deleteRebalanceSetAndEvents(arg1: string, arg2?: string): Promise<{ ok: true }> {
  const setId = arg2 ? arg2 : arg1; // support (wallet,setId) or (setId)
  // First delete the set (removes wallet index & set hash)
  await deleteSet(setId);

  // Best-effort: scan for related keys mentioning the setId and delete them.
  try {
    const patterns = [
      `*${setId}*`,
      `mm:activity:*:${setId}*`,
      `mm:events:*:${setId}*`,
      `mm:rebal:set:${setId}`,
      `mm:rebalance:set:${setId}`, // very old typo
      `REBAL_SET:${setId}`,
    ];
    for (const pattern of patterns) {
      let cursor = 0;
      do {
        const [nextCursor, keys] = (await (redis as any).scan(cursor, { match: pattern, count: 200 })) as any;
        const ks: string[] = Array.isArray(keys) ? keys : [];
        if (ks.length) {
          try { await (redis as any).del(...ks); } catch {
            for (const k of ks) { try { await redis.del(k as any); } catch {} }
          }
        }
        cursor = Number(nextCursor || 0);
      } while (cursor !== 0);
    }
  } catch {
    // ignore scan failures
  }
  return { ok: true };
}
