// filepath: src/lib/strategy.store.ts
// Mojo Pro strategy store (universal subscription product) — Node-safe ID generation.
// This version is a strict additive overlay for your 0436pm GOLDEN repo.
// - Uses Node 'crypto' randomBytes for setId (avoids getRandomValues TS issues on Vercel build)
// - Keeps universal subscription product 'mojo-pro' (one sub covers all mojo-pro-* slugs)
// - Writes generic set metadata keys so other surfaces can enrich events without coupling.

import { redis } from "@/lib/redis";

// Re-export for any callers that import { redis } from strategy.store
export { redis };

export type StrategySlug = "mojo-pro-sol" | "mojo-pro-eth" | "mojo-pro-btc" | string;

export type MojoSetDoc = {
  setId: string;
  wallet: string;
  strategyId: StrategySlug;
  type: "mojo-pro";
  createdAt: number;
  updatedAt: number;
  prefs: {
    tokenA: { mint: string; symbol?: string; decimals?: number } | null;
    tokenB: { mint: string; symbol?: string; decimals?: number } | null;
  };
  vault?: string | null;
  vaultAuthority?: string | null;
};

const K = {
  setDoc: (setId: string) => `mm:mp:set:${setId}`,
  byType: (type: string) => `mm:sets:byType:${type}`,
  byStrategy: (slug: string) => `mm:sets:byStrategy:${slug}`,
  walletSetsByStrategy: (wallet: string, slug: string) => `mm:wallet:${wallet}:sets:strategy:${slug}`,
  walletSetsAll: (wallet: string) => `mm:wallet:${wallet}:sets:all`,
  walletSetsByType: (wallet: string, type: string) => `mm:wallet:${wallet}:sets:type:${type}`,
  setStatus: (setId: string) => `mm:set:${setId}:status`,
  setType: (setId: string) => `mm:set:${setId}:type`,
  setStrategy: (setId: string) => `mm:set:${setId}:strategy`,
};

function now() { return Date.now(); }

// ID generation that is safe on Vercel Node runtime and TS-friendly.
export function randomSetIdHex32(): string {
  try {
    // Prefer Node crypto for cryptographically-strong randomness
    // Dynamic require avoids bundlers complaining on non-Node targets.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
    return randomBytes(16).toString("hex"); // 32 hex chars
  } catch {
    // Very rare fallback (non-crypto), still returns 32 hex chars.
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)];
    return out;
  }
}

export function productForSlug(slug: StrategySlug): string {
  // Any "mojo-pro*" shares the same universal product "mojo-pro"
  return String(slug || "").startsWith("mojo-pro") ? "mojo-pro" : String(slug || "");
}

export async function createMojoProSet(wallet: string, strategyId: StrategySlug, opts?: {
  tokenAMint?: string;
  tokenBMint?: string;
  symbolA?: string;
  symbolB?: string;
}): Promise<MojoSetDoc> {
  const setId = randomSetIdHex32();
  const nowMs = now();
  const tokenA = { mint: opts?.tokenAMint || "So11111111111111111111111111111111111111112", symbol: opts?.symbolA || "SOL" };
  const tokenB = { mint: opts?.tokenBMint || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: opts?.symbolB || "USDC" };
  const doc: MojoSetDoc = {
    setId,
    wallet,
    strategyId,
    type: "mojo-pro",
    createdAt: nowMs,
    updatedAt: nowMs,
    prefs: { tokenA, tokenB },
  };
  // Pipeline: write all set data in a single round-trip instead of 9 calls
  const p = (redis as any).pipeline();
  p.hset(K.setDoc(setId), doc as any);
  p.sadd(K.byType("mojo-pro"), setId);
  p.sadd(K.byStrategy(strategyId), setId);
  p.sadd(K.walletSetsByStrategy(wallet, strategyId), setId);
  p.sadd(K.walletSetsAll(wallet), setId);
  p.sadd(K.walletSetsByType(wallet, "mojo-pro"), setId);
  // Generic metadata for other surfaces (analytics / event enrichment)
  p.set(K.setType(setId), "mojo-pro");
  p.set(K.setStrategy(setId), strategyId);
  // Seed status = stopped
  p.hset(K.setStatus(setId), { state: "stopped", updatedAt: nowMs });
  await p.exec();
  return doc;
}

export async function getMojoProSetsByWallet(wallet: string, strategyId?: StrategySlug): Promise<MojoSetDoc[]> {
  let ids: string[] = [];
  if (strategyId) {
    ids = await redis.smembers<string[]>(K.walletSetsByStrategy(wallet, strategyId) as any);
  } else {
    ids = await redis.smembers<string[]>(K.walletSetsByType(wallet, "mojo-pro") as any);
  }
  if (!ids || !ids.length) return [];
  // Pipeline: fetch all set docs in a single round-trip instead of N calls
  const p = (redis as any).pipeline();
  for (const id of ids) p.hgetall(K.setDoc(id));
  const rows: (MojoSetDoc | null)[] = await p.exec();
  return rows
    .filter((r): r is MojoSetDoc => !!r && typeof r === 'object' && Object.keys(r).length > 0)
    .map((r) => ({
      ...r,
      createdAt: Number((r as any).createdAt || 0),
      updatedAt: Number((r as any).updatedAt || 0),
    }));
}

export async function getMojoProSet(setId: string): Promise<MojoSetDoc | null> {
  const row = await redis.hgetall<MojoSetDoc>(K.setDoc(setId));
  return row && Object.keys(row).length
    ? ({
        ...row,
        createdAt: Number((row as any).createdAt || 0),
        updatedAt: Number((row as any).updatedAt || 0),
      })
    : null;
}

// ---------------- Universal Subscriptions ("mojo-pro") ----------------

export type SubRow = {
  expiresAt: number;
  creditedUsd?: number;
  totalPaidUsd?: number;
  createdAt: number;
  lastPaidSig?: string;
};

const KS = {
  sub: (product: string, wallet: string) => `mm:subs:${product}:${wallet}`,
  active: (product: string) => `mm:subs:${product}:active`,
};

export async function getSubscription(slugOrProduct: string, wallet: string): Promise<SubRow | null> {
  const prod = slugOrProduct === "mojo-pro" ? "mojo-pro" : productForSlug(slugOrProduct as any);
  const r = await redis.get<SubRow>(KS.sub(prod, wallet));
  if (!r) return null;
  return {
    expiresAt: Number((r as any).expiresAt || 0),
    creditedUsd: Number((r as any).creditedUsd || 0) || 0,
    totalPaidUsd: Number((r as any).totalPaidUsd || 0) || 0,
    createdAt: Number((r as any).createdAt || 0) || now(),
    lastPaidSig: (r as any).lastPaidSig || undefined,
  };
}

export async function upsertSubscription(slugOrProduct: string, wallet: string, deltaUsd: number, txSig: string): Promise<SubRow> {
  const prod = slugOrProduct === "mojo-pro" ? "mojo-pro" : productForSlug(slugOrProduct as any);
  const cur = await getSubscription(prod, wallet);
  const price = 20; // USD per 30d
  const blocks = Math.floor(Math.max(0, deltaUsd) / price);
  const days = blocks * 30;
  const addMs = days * 24 * 60 * 60 * 1000;
  const nowMs = now();
  const nextExpires = (cur && cur.expiresAt && cur.expiresAt > nowMs) ? (cur.expiresAt + addMs) : (nowMs + addMs);
  const creditedUsd = (cur?.creditedUsd || 0) + (deltaUsd % price);
  const total = (cur?.totalPaidUsd || 0) + deltaUsd;
  const row: SubRow = { expiresAt: nextExpires, creditedUsd, totalPaidUsd: total, createdAt: cur?.createdAt || nowMs, lastPaidSig: txSig };
  await redis.set(KS.sub(prod, wallet), row);
  await redis.sadd(KS.active(prod), wallet);
  return row;
}

export async function listActiveWallets(slugOrProduct: string): Promise<string[]> {
  const prod = slugOrProduct === "mojo-pro" ? "mojo-pro" : productForSlug(slugOrProduct as any);
  const s = await redis.smembers<string[]>(KS.active(prod) as any);
  if (!s || !s.length) return [];
  const nowMs = now();
  const alive: string[] = [];
  for (const w of s) {
    const r = await getSubscription(prod, w);
    if (r && r.expiresAt > nowMs) alive.push(w);
    else await redis.srem(KS.active(prod), w).catch(()=>{});
  }
  return alive;
}

export async function isActive(slugOrProduct: string, wallet: string): Promise<boolean> {
  const r = await getSubscription(slugOrProduct, wallet);
  return !!r && r.expiresAt > now();
}

export const Keys = { K, KS, productForSlug };
