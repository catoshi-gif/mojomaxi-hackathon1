// filepath: src/lib/immutability.guard.ts
// Server-only immutability helpers for webhook (2-token) & rebalance (2–20 tokens) sets.
// Golden Rule respected: no UI/UX changes. Pure server logic.
//
// Exposed helpers:
//  - normalizeWebhookMintsFromDoc(doc)
//  - normalizeRebalanceMintsFromDoc(doc)
//  - getVaultForSetId(setId): reads mapping from DB (mm:set:* and mm:rebal:set:*), falls back to on-chain derivation
//  - pinVaultMints(vault, payload): persist canonical mapping in mm:vaultmints:{vault}
//  - readPinnedVaultMints(vault)
//  - isVaultEmptyOnChain({ vault?, setId }): checks SPL + Token-2022 under both vault owner and authority PDA
//  - enforceWebhookImmutability({ setId, incoming }): returns { ok, status?, reason?, canonical?, vault? }
//  - enforceRebalanceImmutability({ setId, incomingMints }): returns { ok, status?, reason?, canonical?, vault? }
//
// Redis layout used here (all strings):
//   mm:set:{setId}:vault      -> vault b58 (webhooks + also used by rebalance)
//   mm:rebal:set:{setId}      -> JSON doc with fields { id, wallet, mints[], vaultId? }
//   mm:vaultmints:{vault}     -> HSET fields:
//        type: 'webhook' | 'rebalance'
//        setId: string
//        mintA, mintB, mintIn, mintOut  (webhook)
//        mints: JSON.stringify(string[]) (rebalance)
//        ts: Date.now()
//
import 'server-only';
import { Redis } from '@upstash/redis';
import { PublicKey, Connection, clusterApiUrl } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { redis } from '@/lib/redis';

// ---- Solana connection (no UI change) ----
function getConn(): Connection {
  const url =
    process.env.HELIUS_RPC_URL ||
    process.env.RPC_URL ||
        process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC ||
    clusterApiUrl('mainnet-beta');
  return new Connection(url, 'confirmed');
}

// ---- Small utils ----
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const K = {
  setHash: (setId: string) => `mm:set:${setId}`,
  setVault: (setId: string) => `mm:set:${setId}:vault`,
  setVaultId: (setId: string) => `mm:set:${setId}:vaultId`,
  rebalSet: (setId: string) => `mm:rebal:set:${setId}`,
  pinned: (vault: string) => `mm:vaultmints:${vault}`,
};

function uniqStr(arr: string[]): string[] { return Array.from(new Set(arr.filter(Boolean).map(s => String(s).trim()))); }
function sameSet(a: string[], b: string[]): boolean {
  const A = uniqStr(a).sort(); const B = uniqStr(b).sort();
  return A.length === B.length && A.every((x, i) => x === B[i]);
}

// ---- Normalize webhook mints from any doc shape ----
export function normalizeWebhookMintsFromDoc(doc: any): { mintA?: string; mintB?: string; mintIn?: string; mintOut?: string } {
  const p = (doc && typeof doc.prefs === 'object' && doc.prefs) ? doc.prefs : {};
  const tokA = (doc && (doc.tokenA?.mint || doc.tokenA)) ? (doc.tokenA?.mint || doc.tokenA) : undefined;
  const tokB = (doc && (doc.tokenB?.mint || doc.tokenB)) ? (doc.tokenB?.mint || doc.tokenB) : undefined;
  const flatA = doc?.mintA || doc?.mintIn || tokA || doc?.buyOutputMint || doc?.sellInputMint;
  const flatB = doc?.mintB || doc?.mintOut || tokB || doc?.sellOutputMint;
  const mintA = p?.mintA || p?.mintIn || flatA;
  const mintB = p?.mintB || p?.mintOut || flatB;
  const mintIn = p?.mintIn || doc?.mintIn || mintA;
  const mintOut = p?.mintOut || doc?.mintOut || mintB;
  return {
    mintA: typeof mintA === 'string' ? mintA : undefined,
    mintB: typeof mintB === 'string' ? mintB : undefined,
    mintIn: typeof mintIn === 'string' ? mintIn : undefined,
    mintOut: typeof mintOut === 'string' ? mintOut : undefined,
  };
}

// ---- Normalize rebalance mints from any doc shape ----
export function normalizeRebalanceMintsFromDoc(doc: any): string[] {
  if (!doc) return [];
  const arr = Array.isArray(doc?.mints) ? doc.mints :
              Array.isArray(doc?.tokens) ? doc.tokens :
              Array.isArray(doc?.frozenMints) ? doc.frozenMints :
              (typeof doc?.mints === 'string' ? (() => { try { return JSON.parse(doc.mints); } catch { return []; } })() : []);
  return uniqStr(arr);
}

// ---- Read vault id for a set (webhook or rebalance) ----
export async function getVaultForSetId(setId: string): Promise<string | null> {
  const k1 = await redis.get<string>(K.setVault(setId)).catch(() => null);
  if (k1) return k1;
  const k2 = await redis.get<string>(K.setVaultId(setId)).catch(() => null);
  if (k2) return k2;
  const h = await redis.hget<string>(K.setHash(setId), 'vault').catch(() => null);
  if (h) return h;
  // rebalance JSON doc might embed vaultId
  try {
    const doc = await (redis as any).json?.get(K.rebalSet(setId), '$');
    if (Array.isArray(doc) && doc[0] && typeof doc[0].vaultId === 'string' && doc[0].vaultId) return String(doc[0].vaultId);
  } catch {}
  try {
    const raw = await redis.get(K.rebalSet(setId)).catch(() => null) as any;
    if (raw && typeof raw === 'string' && raw.trim().startsWith('{')) {
      const j = JSON.parse(raw);
      if (typeof j?.vaultId === 'string' && j.vaultId) return String(j.vaultId);
    } else if (raw && typeof raw === 'object' && raw.vaultId) {
      return String(raw.vaultId);
    }
  } catch {}
  return null;
}

// ---- Read/write pinned mapping ----
export async function readPinnedVaultMints(vault: string): Promise<any | null> {
  try {
    const h = await redis.hgetall<Record<string, string>>(K.pinned(vault));
    if (!h || !Object.keys(h).length) return null;
    const out: any = { ...h };
    if (typeof out.mints === 'string') {
      try { out.mints = JSON.parse(out.mints); } catch { out.mints = []; }
    }
    return out;
  } catch { return null; }
}

export async function pinVaultMints(vault: string, payload: { type: 'webhook' | 'rebalance'; setId: string; mintA?: string; mintB?: string; mintIn?: string; mintOut?: string; mints?: string[] }) {
  const h: Record<string, string> = { type: payload.type, setId: payload.setId, ts: String(Date.now()) };
  if (payload.type === 'webhook') {
    if (payload.mintA) h.mintA = payload.mintA;
    if (payload.mintB) h.mintB = payload.mintB;
    if (payload.mintIn) h.mintIn = payload.mintIn;
    if (payload.mintOut) h.mintOut = payload.mintOut;
  } else {
    h.mints = JSON.stringify(uniqStr(payload.mints || []));
  }
  await redis.hset(K.pinned(vault), h as any);
}

// ---- On-chain empty check ----
async function getParsedTokenAccountsForOwner(owner: PublicKey) {
  const conn = getConn();
  const [a, b] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_CLASSIC }).catch(() => ({ value: [] } as any)),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] } as any)),
  ]);
  const parse = (arr: any[]) => arr.map((it: any) => {
    const info = it?.account?.data?.parsed?.info;
    const mint = String(info?.mint || '');
    const amt = info?.tokenAmount;
    const ui = typeof amt?.uiAmount === 'number' ? amt.uiAmount : 0;
    const raw = String(amt?.amount || '0');
    const dec = Number(amt?.decimals || 0);
    return { mint, uiAmount: ui, amount: raw, decimals: dec };
  });
  return [...parse(Array.isArray(a?.value) ? a.value : []), ...parse(Array.isArray(b?.value) ? b.value : [])];
}

export async function isVaultEmptyOnChain(arg: { vault?: string; authority?: string }): Promise<boolean> {
  try {
    const owners: PublicKey[] = [];
    if (arg.vault) owners.push(new PublicKey(arg.vault));
    if (arg.authority) owners.push(new PublicKey(arg.authority));
    if (!owners.length) return false;
    const accs = await Promise.all(owners.map(o => getParsedTokenAccountsForOwner(o)));
    const flat = ([] as any[]).concat(...accs);
    for (const a of flat) {
      const n = Number(a?.uiAmount || 0);
      if (n > 0) return false;
    }
    return true;
  } catch { return false; }
}

// ---- Enforcers ----
export async function enforceWebhookImmutability(params: { setId: string; incoming?: { mintA?: string; mintB?: string; mintIn?: string; mintOut?: string } }) {
  const setId = String(params.setId || '').trim();
  const vault = await getVaultForSetId(setId);
  if (!vault) return { ok: true }; // no vault, editable
  const pinned = await readPinnedVaultMints(vault);
  if (pinned && pinned.type === 'webhook') {
    const cA = pinned.mintA || pinned.mintIn;
    const cB = pinned.mintB || pinned.mintOut;
    const inA = params.incoming?.mintA || params.incoming?.mintIn;
    const inB = params.incoming?.mintB || params.incoming?.mintOut;
    if ((inA && inA !== cA) || (inB && inB !== cB)) {
      return { ok: false, status: 409, reason: 'immutable_mints', canonical: { mintA: cA, mintB: cB, mintIn: cA, mintOut: cB }, vault };
    }
    return { ok: true, canonical: { mintA: cA, mintB: cB, mintIn: cA, mintOut: cB }, vault };
  }
  // No pinned -> allow (legacy), but we still prevent *changing* away from what's already in doc if present
  try {
    const doc = await redis.hgetall<any>(K.setHash(setId));
    const { mintA, mintB, mintIn, mintOut } = normalizeWebhookMintsFromDoc(doc || {});
    const inA = params.incoming?.mintA || params.incoming?.mintIn;
    const inB = params.incoming?.mintB || params.incoming?.mintOut;
    if (mintA && mintB && ((inA && inA !== mintA) || (inB && inB !== mintB))) {
      return { ok: false, status: 409, reason: 'immutable_mints', canonical: { mintA, mintB, mintIn: mintA, mintOut: mintB }, vault };
    }
  } catch {}
  return { ok: true, vault };
}

export async function enforceRebalanceImmutability(params: { setId: string; incomingMints?: string[] }) {
  const setId = String(params.setId || '').trim();
  // Load existing doc
  let doc: any = null;
  try {
    const raw = await (redis as any).json?.get(K.rebalSet(setId), '$');
    if (Array.isArray(raw) && raw[0]) doc = raw[0];
  } catch {}
  if (!doc) {
    const s = await redis.get(K.rebalSet(setId)).catch(() => null) as any;
    if (s && typeof s === 'string' && s.trim().startsWith('{')) try { doc = JSON.parse(s); } catch {}
    else if (s && typeof s === 'object') doc = s;
  }
  if (!doc) return { ok: true }; // unknown set

  const existing = normalizeRebalanceMintsFromDoc(doc);
  const incoming = uniqStr(params.incomingMints || []);

  const hasVault = !!(doc.vaultId || await redis.get(K.setVault(setId)).catch(() => null));
  if (!hasVault) return { ok: true }; // not frozen yet

  if (incoming.length && !sameSet(existing, incoming)) {
    return { ok: false, status: 409, reason: 'immutable_mints_array', canonical: { mints: existing }, vault: String(doc.vaultId || '') };
  }
  return { ok: true, canonical: { mints: existing }, vault: String(doc.vaultId || '') };
}
