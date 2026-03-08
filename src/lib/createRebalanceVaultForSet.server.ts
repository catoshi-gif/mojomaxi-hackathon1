
// filepath: src/lib/createRebalanceVaultForSet.server.ts
// FULL FILE REPLACEMENT — Pro-aware vault creation (no UI changes)
// - Accepts cadence "1h" for Mojo Pro subscribers; otherwise keeps legacy 2/6/12/24h.
// - Allows 2–20 tokens for Pro, 2–6 for Free.
// - Preserves mint order for Pro (Token #1 can be non-SOL); Free keeps SOL first.
// - Best-effort ATAs; freezes mints/cadence; idempotent storage.
// - Retains all existing API shapes and side-effects.
// - Uses Upstash Redis and program-derivation fallback for vault id.

import 'server-only';
import { PublicKey } from '@solana/web3.js';
import { ensureVaultAtasForMints } from '@/lib/vault-atas.server';
import { getSubscription } from '@/lib/strategy.store';
import { redis } from '@/lib/redis';

export type RebalanceSetDoc = {
  id: string;
  wallet: string;
  mints?: string[];
  cadence?: '1h' | '2h' | '6h' | '12h' | '24h';
  createdAt?: number;
  vaultId?: string | null;
  frozen?: boolean;
  frozenMints?: string[];
  frozenCadence?: '1h' | '2h' | '6h' | '12h' | '24h';
  type?: 'rebalance';
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CADENCES_PRO = new Set(['1h','2h','6h','12h','24h'] as const);
const CADENCES_FREE = new Set(['2h','6h','12h','24h'] as const);

function keySet(id: string) { return `mm:rebal:set:${id}`; }
function keyLegacy(id: string) { return `REBAL_SET:${id}`; }
function keyVaultMapping(id: string) { return `mm:set:${id}:vault`; }

// Exactly matches the program-side 16B hash used in /api/vaults/create
function setIdToBytes16(setId: string): Uint8Array {
  const raw = String(setId || '').replace(/-/g, '');
  const out = new Uint8Array(16);
  if (/^[0-9a-fA-F]{16,32}$/.test(raw)) {
    const hex = raw.slice(0, 32).padEnd(32, '0');
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i*2, i*2+2), 16);
    return out;
  }
  const enc = new TextEncoder().encode(String(setId || 'mm'));
  for (let i = 0; i < 16; i++) out[i] = enc[i % enc.length] ^ ((i*131)&0xff);
  return out;
}

function deriveProgramVault(owner: string, setId: string): string {
  const pidStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID || '2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp';
  const pid = new PublicKey(pidStr);
  const ownerPk = new PublicKey(owner);
  const set16 = setIdToBytes16(setId);
  const [vaultPk] = PublicKey.findProgramAddressSync([Buffer.from('vault'), ownerPk.toBuffer(), Buffer.from(set16)], pid);
  return vaultPk.toBase58();
}

async function isMojoProActive(wallet: string): Promise<boolean> {
  try {
    const sub = await getSubscription('mojo-pro', wallet);
    return !!sub && Number(sub.expiresAt || 0) > Date.now();
  } catch {
    return false;
  }
}

export async function createRebalanceVaultForSet(params: {
  wallet: string;
  setId: string;
  mints?: string[];
  cadence?: '1h' | '2h' | '6h' | '12h' | '24h';
  /** Optional canonical vault address returned from /api/vaults/create. Preferred if present. */
  vault?: string | null;
}): Promise<
  | { ok: true; vault: string; set: RebalanceSetDoc }
  | { ok: false; error: string }
> {
  const wallet = String(params.wallet || '').trim();
  const setId = String(params.setId || (params as any).id || '').trim();
  let vault = String(params.vault || '').trim() || null;

  // validate input
  if (!wallet) return { ok: false, error: 'missing wallet' };
  if (!setId) return { ok: false, error: 'missing setId' };
  try { new PublicKey(wallet); } catch { return { ok: false, error: 'invalid wallet' }; }

  const isPro = await isMojoProActive(wallet);

  // resolve vault in this order: provided -> mapping -> program-derivation
  if (!vault) {
    try {
      const mapped = await redis.get<string>(keyVaultMapping(setId)).catch(() => null);
      if (mapped && typeof mapped === 'string' && mapped.length > 30) vault = mapped;
    } catch {}
  }
  if (!vault) {
    try { vault = deriveProgramVault(wallet, setId); } catch {}
  }
  if (!vault) return { ok: false, error: 'failed to resolve vault' };

  // Normalize tokens: Pro 2–20 (preserve order); Free 2–6 (SOL first)
  const mintsIn = Array.isArray(params.mints) ? params.mints.map(m => String(m || '').trim()).filter(Boolean) : [];
  const uniq = Array.from(new Set(mintsIn));
  if (uniq.length > 0) {
    if (!isPro && (uniq.length < 2 || uniq.length > 6)) {
      return { ok: false, error: 'mints must be 2–6 tokens' };
    }
    if (isPro && (uniq.length < 2 || uniq.length > 20)) {
      return { ok: false, error: 'mints must be 2–20 tokens' };
    }
    params.mints = isPro ? uniq : (uniq.includes(SOL_MINT) ? [SOL_MINT, ...uniq.filter(m => m !== SOL_MINT)] : uniq);
  }

  // cadence gate: 1h allowed only for Pro
  const c = params.cadence;
  const okCadence = isPro ? CADENCES_PRO.has(c as any) : CADENCES_FREE.has(c as any);
  const cadence = okCadence ? c : undefined;

  // best-effort ATAs for declared mints (if any)
  if (params.mints && params.mints.length > 0) {
    try { await ensureVaultAtasForMints({ wallet, vault, mints: params.mints }); } catch {}
  }

  // persist & freeze (idempotent)
  const k = keySet(setId);
  let existing: RebalanceSetDoc | null = null;
  try {
    const raw = await (redis as any).json?.get(k, '$');
    if (Array.isArray(raw) && raw[0]) existing = raw[0] as RebalanceSetDoc;
  } catch {}
  if (!existing) {
    try {
      const raw2 = await (redis as any).get(k);
      if (typeof raw2 === 'string' && raw2.trim().startsWith('{')) existing = JSON.parse(raw2) as RebalanceSetDoc;
      else if (raw2 && typeof raw2 === 'object') existing = raw2 as RebalanceSetDoc;
    } catch {}
  }

  const frozenMints = (existing?.frozenMints && existing.frozenMints.length) ? existing.frozenMints : (params.mints || existing?.mints || []);
  const frozenCadence = (existing?.frozenCadence || cadence);

  const updated: RebalanceSetDoc = {
    id: setId,
    wallet,
    mints: params.mints || existing?.mints || [],
    cadence: cadence || existing?.cadence,
    createdAt: existing?.createdAt || Date.now(),
    vaultId: vault,
    frozen: true,
    frozenMints,
    frozenCadence,
    type: 'rebalance',
  };

  // Write JSON (prefer JSON.SET)
  let wrote = false;
  try { await (redis as any).json?.set(k, '$', updated); wrote = true; } catch {}
  if (!wrote) { try { await (redis as any).set(k, JSON.stringify(updated)); wrote = true; } catch {} }
  if (!wrote) return { ok: false, error: 'failed to persist vault document' };
  // Pin vault→mints mapping for immutability (best‑effort; non-blocking)
  try {
    await redis.hset(`mm:vaultmints:${vault}`, {
      type: 'rebalance',
      setId,
      mints: JSON.stringify(updated.frozenMints || updated.mints || mintsIn || []),
      ts: String(Date.now()),
    } as any);
  } catch {}


  return { ok: true, vault, set: updated };
}

export default createRebalanceVaultForSet;
