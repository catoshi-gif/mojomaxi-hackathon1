// src/lib/store.ts
// Single-source-of-truth storage for webhook sets + id index.
// Uses @upstash/redis REST client via UPSTASH_REDIS_REST_URL/TOKEN.

import { redis } from "@/lib/redis";

/** Upstash Redis ONLY (per your requirement) */
const KV_URL   = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** Runtime check used by the create route (and others) */
export function kvConfigured(): { url: boolean; token: boolean } {
  return { url: !!KV_URL, token: !!KV_TOKEN };
}

// --- Types ---

export type Tier = "free" | "paid" | "pro";

export const TIER_LIMITS: Record<Tier, number> = {
  free: 1,
  paid: 5,
  pro: 10,
};

export type SetPrefs = {
  /** Preferred slippage in basis points */
  slippageBps?: number;
  /** Modern: explicit Token A / Token B semantics */
  mintA?: string; // Token A (the "asset" you want to own after BUY)
  mintB?: string; // Token B (the "quote" you fund with; typically USDC)
  /** Legacy fields (treated as A/B, see resolveMintsFor) */
  mintIn?: string;
  mintOut?: string;
};

export type WebhookSet = {
  /** 32-char lowercase hex (exactly 16 bytes / 128 bits) */
  setId: string;
  wallet: string;
  label?: string;
  prefs?: SetPrefs;
  /** Short tokens used for pretty ingest URLs */
  buyId: string;
  sellId: string;
  createdAt: number;
  updatedAt: number;
};

export type IdIndex = {
  setId: string;
  kind: "buy" | "sell";
};

// --- Key helpers ---

const K = {
  setDoc: (setId: string) => `mm:set:${setId}`,                // HASH of WebhookSet
  walletSetIds: (wallet: string) => `mm:wallet:${wallet}:sets`, // SET of setIds
  idIndex: (id: string) => `mm:id:${id}`,                       // HASH -> {setId, kind}
  recentEvents: (setId: string) => `mm:set:${setId}:recent`,    // LIST of JSON entries
  globalEvents: () => `mm:events:recent`,            // LIST of JSON entries (global activity)

  // legacy candidates (we'll probe these)
  legacyWalletBlobA: (wallet: string) => `mm:wallet:${wallet}`,
  legacyWalletBlobB: (wallet: string) => `mm:wallet:${wallet}:record`,
  legacyWalletBlobC: (wallet: string) => `mm:webhooks:${wallet}`,
};

// --- Utils ---

function bytes16Hex(): string {
  // Produce 16 random bytes -> 32-char hex
  const arr = new Uint8Array(16);
  if (typeof crypto !== "undefined" && (crypto as any).getRandomValues) {
    (crypto as any).getRandomValues(arr);
  } else {
    // Node fallback
    const nodeCrypto = require("crypto");
    return nodeCrypto.randomBytes(16).toString("hex");
  }
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s;
}

// strip nullish (Upstash HSET rejects null args)
function stripNulls<T extends Record<string, any>>(obj: T): T {
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined);
  return Object.fromEntries(entries) as T;
}

// Common Solana mints (mainnet)
const MINT_SOL = "So11111111111111111111111111111111111111112";
const MINT_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// --- KV Health ---

export async function kvRoundtrip(): Promise<{ ok: boolean; detail?: string }> {
  try {
    if (!KV_URL || !KV_TOKEN) return { ok: false, detail: "KV env missing" };
    const key = `mm:health:${Date.now()}:${Math.random()}`;
    const res = await redis.set(key, "1", { ex: 30 });
    const got = await redis.get<string | number | null>(key);
    const gotStr = got == null ? "" : String(got);
    const ok = (res === "OK" || res === "ok") && (gotStr === "1");
    return { ok, detail: `set=${String(res)} get=${gotStr}` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

// --- Public API ---

export async function getTierForWallet(_wallet: string): Promise<Tier> {
  return "free";
}

export async function createSet(
  wallet: string,
  prefs?: SetPrefs,
  label?: string
): Promise<WebhookSet> {
  const now = Date.now();
  const setId = bytes16Hex();             // 16 bytes (32 hex chars)
  const buyId = bytes16Hex().slice(0, 16);  // short tokens for URLs
  const sellId = bytes16Hex().slice(0, 16);

  const doc: WebhookSet = {
    setId,
    wallet,
    ...(label ? { label } : {}),
    ...(prefs ? { prefs } : {}),
    buyId,
    sellId,
    createdAt: now,
    updatedAt: now,
  };

  // Pipeline to minimize Upstash requests
  const p = (redis as any).pipeline();
  p.hset(K.setDoc(setId), stripNulls(doc) as any);
  p.sadd(K.walletSetIds(wallet), setId);
  p.hset(K.idIndex(buyId), { setId, kind: "buy" } as IdIndex);
  p.hset(K.idIndex(sellId), { setId, kind: "sell" } as IdIndex);
  await p.exec();

  return doc;
}

export async function getSetsByWallet(wallet: string): Promise<WebhookSet[]> {
  const setIds = await redis.smembers<string[]>(K.walletSetIds(wallet) as any);
  if (!setIds || setIds.length === 0) return [];
  // Pipeline: fetch all set docs in a single round-trip instead of N calls
  const p = (redis as any).pipeline();
  for (const id of setIds) p.hgetall(K.setDoc(id));
  const rows: (WebhookSet | null)[] = await p.exec();
  return rows
    .filter((r): r is WebhookSet => !!r && typeof r === 'object' && Object.keys(r).length > 0)
    .map((doc) => ({
      ...doc,
      createdAt: Number((doc as any).createdAt ?? 0),
      updatedAt: Number((doc as any).updatedAt ?? 0),
    }));
}

export async function getSetById(setId: string): Promise<WebhookSet | null> {
  const doc = await redis.hgetall<WebhookSet>(K.setDoc(setId));
  if (!doc || !Object.keys(doc).length) return null;
  (doc as any).createdAt = Number((doc as any).createdAt ?? 0);
  (doc as any).updatedAt = Number((doc as any).updatedAt ?? 0);
  return doc;
}

export async function getWebhookRecordById(id: string): Promise<{ set: WebhookSet; kind: "buy" | "sell" } | null> {
  const idx = await redis.hgetall<IdIndex>(K.idIndex(id));
  if (!idx || !idx.setId || !idx.kind) return null;
  const set = await getSetById(idx.setId);
  if (!set) return null;
  return { set, kind: idx.kind };
}

export async function deleteSet(wallet: string, setId: string) {
  const set = await getSetById(setId);
  if (!set) return;
  const p = (redis as any).pipeline();
  p.del(K.setDoc(setId));
  p.srem(K.walletSetIds(wallet), setId);
  if (set.buyId) p.del(K.idIndex(set.buyId));
  if (set.sellId) p.del(K.idIndex(set.sellId));
  await p.exec();
}

export async function rotateIds(wallet: string, setId: string): Promise<WebhookSet | null> {
  const set = await getSetById(setId);
  if (!set || set.wallet !== wallet) return null;

  const p1 = (redis as any).pipeline();
  if (set.buyId) p1.del(K.idIndex(set.buyId));
  if (set.sellId) p1.del(K.idIndex(set.sellId));
  await p1.exec();

  set.buyId = bytes16Hex().slice(0, 16);
  set.sellId = bytes16Hex().slice(0, 16);
  set.updatedAt = Date.now();

  const p2 = (redis as any).pipeline();
  p2.hset(K.setDoc(setId), stripNulls(set) as any);
  p2.hset(K.idIndex(set.buyId), { setId, kind: "buy" } as IdIndex);
  p2.hset(K.idIndex(set.sellId), { setId, kind: "sell" } as IdIndex);
  await p2.exec();

  return set;
}

export async function updatePrefs(
  wallet: string,
  setId: string,
  prefs: SetPrefs
): Promise<WebhookSet | null> {
  const set = await getSetById(setId);
  if (!set || set.wallet !== wallet) return null;

  set.prefs = { ...(set.prefs || {}), ...(prefs || {}) };
  set.updatedAt = Date.now();

  await redis.hset(K.setDoc(setId), stripNulls(set) as any);
  return set;
}

// ---- events ----
export async function pushRecentEvent(
  setId: string,
  message: string,
  extra?: Record<string, any>
) {
  const cap = Number(process.env.MM_SET_EVENTS_MAX ?? 200);
  const key = K.recentEvents(setId);
  const row = { ts: Date.now(), setId, message, ...(extra || {}) };
  await redis.lpush(key, JSON.stringify(row));
  await redis.ltrim(key, 0, cap - 1);
  // Mirror to global activity list for homepage volume & admin overviews
  try {
    const gKey = K.globalEvents();
    await redis.lpush(gKey, JSON.stringify(row));
    await redis.ltrim(gKey, 0, 499);
  } catch { /* noop */ }

}

/**
 * resolveMintsFor
 *
 * Semantics we want for automation:
 *  - BUY  = Token B -> Token A  (spend quote to acquire asset)
 *  - SELL = Token A -> Token B  (sell asset back to quote)
 *
 * Source of truth (in order):
 *  1) prefs.mintA/mintB (modern, explicit A/B)
 *  2) prefs.mintIn/mintOut (legacy, captured as A/B in UI; we treat `mintIn` as A, `mintOut` as B)
 *  3) defaults (USDC<->SOL)
 */
export function resolveMintsFor(set: WebhookSet, kind: "buy" | "sell"): { inMint: string; outMint: string } {
  const p = set.prefs || {};

  // 1) Modern explicit A/B
  if (p.mintA && p.mintB) {
    if (kind === "buy") return { inMint: p.mintB, outMint: p.mintA };
    return { inMint: p.mintA, outMint: p.mintB };
  }

  // 2) Legacy (assume UI stored A in mintIn and B in mintOut)
  if (p.mintIn && p.mintOut) {
    const mintA = p.mintIn;
    const mintB = p.mintOut;
    if (kind === "buy") return { inMint: mintB, outMint: mintA };
    return { inMint: mintA, outMint: mintB };
  }

  // 3) Defaults
  if (kind === "buy") return { inMint: MINT_USDC, outMint: MINT_SOL };
  return { inMint: MINT_SOL, outMint: MINT_USDC };
}

/* ---------------------------
   HEALING & MIGRATION HELPERS
----------------------------*/

export async function ensureSetHasIds(doc: WebhookSet): Promise<WebhookSet> {
  let changed = false;
  // Normalize setId to 16-byte hex
  if (!/^[0-9a-f]{32}$/.test(doc.setId || "")) { doc.setId = bytes16Hex(); changed = true; }
  if (!doc.buyId) { doc.buyId = bytes16Hex().slice(0, 16); changed = true; }
  if (!doc.sellId) { doc.sellId = bytes16Hex().slice(0, 16); changed = true; }
  if (changed) {
    doc.updatedAt = Date.now();
    await redis.hset(K.setDoc(doc.setId), stripNulls(doc) as any);
  }
  const [buyIdx, sellIdx] = await Promise.all([
    redis.hgetall<IdIndex>(K.idIndex(doc.buyId)),
    redis.hgetall<IdIndex>(K.idIndex(doc.sellId)),
  ]);
  let queued = false;
  const p = (redis as any).pipeline();
  if (!buyIdx || !buyIdx.setId) { p.hset(K.idIndex(doc.buyId), { setId: doc.setId, kind: "buy" } as IdIndex); queued = true; }
  if (!sellIdx || !sellIdx.setId) { p.hset(K.idIndex(doc.sellId), { setId: doc.setId, kind: "sell" } as IdIndex); queued = true; }
  if (queued) await p.exec();
  return doc;
}

async function ensureWalletIndex(wallet: string, setId: string) {
  await redis.sadd(K.walletSetIds(wallet), setId);
}

export async function migrateFromLegacy(wallet: string): Promise<number> {
  const candidates = [
    K.legacyWalletBlobA(wallet),
    K.legacyWalletBlobB(wallet),
    K.legacyWalletBlobC(wallet),
  ];

  let imported = 0;

  for (const key of candidates) {
    try {
      const raw = await redis.get<string | null>(key);
      let obj: any = null;
      if (typeof raw === "string" && raw.length > 0) {
        try { obj = JSON.parse(raw); } catch {}
      }
      if (!obj) {
        const h = await redis.hgetall<Record<string, any>>(key);
        if (h && Object.keys(h).length) obj = h;
      }
      if (!obj) continue;

      const legacySets: any[] =
        Array.isArray(obj?.sets) ? obj.sets :
        Array.isArray(obj?.data?.sets) ? obj.data.sets :
        [];

      for (const ls of legacySets) {
        let setId = (ls?.setId && String(ls.setId)) || bytes16Hex();
        if (!/^[0-9a-f]{32}$/.test(setId)) setId = bytes16Hex();

        // Heal A/B from legacy fields if present
        const prefs: SetPrefs = {};
        if (ls?.prefs?.mintA || ls?.prefs?.mintB) {
          if (ls.prefs.mintA) prefs.mintA = ls.prefs.mintA;
          if (ls.prefs.mintB) prefs.mintB = ls.prefs.mintB;
        } else if (ls?.prefs?.mintIn || ls?.prefs?.mintOut) {
          if (ls.prefs.mintIn) prefs.mintA = ls.prefs.mintIn;
          if (ls.prefs.mintOut) prefs.mintB = ls.prefs.mintOut;
        }

        const doc: WebhookSet = {
          setId,
          wallet,
          ...(ls?.label || ls?.name ? { label: ls.label || ls.name } : {}),
          ...(Object.keys(prefs).length ? { prefs } : {}),
          buyId: String(ls?.buyId || bytes16Hex().slice(0, 16)),
          sellId: String(ls?.sellId || bytes16Hex().slice(0, 16)),
          createdAt: Number(ls?.createdAt ?? Date.now()),
          updatedAt: Number(ls?.updatedAt ?? Date.now()),
        };

        const healed = await ensureSetHasIds(doc);
        const p = (redis as any).pipeline();
        p.hset(K.setDoc(healed.setId), stripNulls(healed) as any);
        p.sadd(K.walletSetIds(wallet), healed.setId);
        await p.exec();
        imported++;
      }
    } catch { /* keep going */ }
  }

  return imported;
}

export async function recoverFromScan(wallet: string, maxKeys = 5000): Promise<number> {
  const keys: string[] = await scanAll(`mm:set:*`, maxKeys);
  let added = 0;

  for (const key of keys) {
    try {
      const doc = await redis.hgetall<WebhookSet>(key);
      if (!doc || !doc.wallet) continue;
      if (doc.wallet !== wallet) continue;

      let setId = (doc as any).setId || key.slice("mm:set:".length);
      setId = String(setId || "");
      if (!/^[0-9a-f]{32}$/.test(setId)) setId = bytes16Hex();

      const normalized: WebhookSet = {
        setId,
        wallet: String((doc as any).wallet),
        ...( (doc as any).label ? { label: (doc as any).label } : {} ),
        ...( (doc as any).prefs ? { prefs: (doc as any).prefs } : {} ),
        buyId: (doc as any).buyId || bytes16Hex().slice(0, 16),
        sellId: (doc as any).sellId || bytes16Hex().slice(0, 16),
        createdAt: Number((doc as any).createdAt ?? Date.now()),
        updatedAt: Number((doc as any).updatedAt ?? Date.now()),
      };

      const healed = await ensureSetHasIds(normalized);
      await ensureWalletIndex(wallet, healed.setId);
      added++;
    } catch { /* ignore this key */ }
  }

  return added;
}

/** Exported so debug route can scan */
export async function scanAll(match: string, cap = 2000): Promise<string[]> {
  let cursor: any = 0;
  const keys: string[] = [];
  for (let i = 0; i < 100; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await (redis as any).scan(cursor, { match, count: 200 });
    const nextCursor = typeof res?.[0] !== "undefined" ? Number(res[0]) : Number(res?.cursor ?? 0);
    const batch: string[] = res?.[1] ?? res?.keys ?? res?.members ?? [];
    if (Array.isArray(batch)) keys.push(...batch);
    cursor = nextCursor;
    if (!cursor || cursor === 0 || keys.length >= cap) break;
  }
  return keys.slice(0, cap);
}
