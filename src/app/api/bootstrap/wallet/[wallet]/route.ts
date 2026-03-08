/**
 * Wallet bootstrap aggregator — ONE fast call to pre-hydrate the dashboard.
 *
 * - Aggregates (no UI/UX changes):
 *   • Webhook sets (via lib/store) — **setId preserved EXACTLY as stored (no canonicalization)**
 *   • Rebalance sets (robust against Upstash string values)
 *   • Mojo Pro strategy sets
 *   • VaultId + deletable flags for all setIds (with rebalance.vaultId fallback)
 *   • Token metadata (symbol/name/decimals/logo) for *all* mints seen in the sets
 *   • Lightweight logo map { mint: proxiedLogoUrl } for instant <img> resolution
 *
 * - Caching:
 *   • Per-wallet JSON blob in Upstash (key: mm:boot:v1:<wallet>) with a short TTL (10s)
 *     so fast reloads don't stampede the DB/RPCs while keeping state fresh.
 *
 * NOTE: Surgical server-only change. Client pages/components remain sacred.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionWalletFromRequest } from '@/lib/auth/session.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { cacheKey, cacheGetJSON, cacheSetJSON, singleflight } from '@/lib/cache.server';
import { getSetsByWallet } from '@/lib/store';

import { PublicKey } from '@solana/web3.js';
import { getConnection } from '@/lib/solana.server';
import { deriveVaultPda } from '@/lib/program.server';
import { getMojoProSetsByWallet } from '@/lib/strategy.store';
import { redis } from "@/lib/redis";

type AnyObj = Record<string, any>;

function privateWalletJsonHeaders(): HeadersInit {
  return {
    'Cache-Control': 'private, max-age=5, must-revalidate',
    Vary: 'Cookie',
  };
}

function noStoreJsonHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, private, must-revalidate',
    Pragma: 'no-cache',
    Vary: 'Cookie',
  };
}


function pickMint(prefs: any, k: 'mintIn'|'mintOut'): string | undefined {
  if (!prefs || typeof prefs !== 'object') return undefined;
  if (typeof prefs[k] === 'string') return prefs[k];
  if (k === 'mintIn') {
    if (typeof (prefs as any).tokenA === 'string') return (prefs as any).tokenA;
    if (typeof (prefs as any).tokenIn === 'string') return (prefs as any).tokenIn;
  } else {
    if (typeof (prefs as any).tokenB === 'string') return (prefs as any).tokenB;
    if (typeof (prefs as any).tokenOut === 'string') return (prefs as any).tokenOut;
  }
  return undefined;
}

const MINT_SOL  = 'So11111111111111111111111111111111111111112';
const MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Rebalance store keys (kept identical to /api/rebalance/for route); include legacy
const RB_IDX     = (wallet: string) => `mm:rebal:wallet:${wallet}:sets`;
const RB_SET     = (setId: string)   => `mm:rebal:set:${setId}`;
const RB_IDX_OLD = (wallet: string)  => `WALLET_REBAL_SETS:${wallet}`;
const RB_SET_OLD = (setId: string)   => `REBAL_SET:${setId}`;

function parseMaybeJson<T = any>(v: any): T | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const c = s[0];
  if (c !== '{' && c !== '[') return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

async function jsonOrHash(key: string): Promise<any | null> {
  try {
    const j = await (redis as any).json?.get(key);
    if (j && typeof j === 'object') return j;
  } catch {}
  try {
    const s = await (redis as any).get(key as any);
    const parsed = parseMaybeJson(s);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  try {
    const h = await (redis as any).hgetall(key as any);
    if (h && typeof h === 'object' && Object.keys(h).length) return h;
  } catch {}
  return null;
}

function coerceRebalanceDoc(raw: any): any | null {
  if (!raw || typeof raw !== 'object') return null;
  const mints: string[] = (() => {
    const v = (raw as any).mints;
    if (Array.isArray(v)) return v.map((x) => String(x || '')).filter(Boolean);
    if (typeof v === 'string') {
      try { const arr = JSON.parse(v); return Array.isArray(arr) ? arr.map((x) => String(x || '')).filter(Boolean) : []; }
      catch { return []; }
    }
    return [];
  })();
  const cadence = (() => {
    const c = String((raw as any).cadence ?? '').trim();
    return c || undefined;
  })();
  const id = String((raw as any).id || (raw as any).setId || '').trim();
  if (!id) return null;
  const createdAt = Number((raw as any).createdAt ?? 0) || undefined;
  const vaultId   = typeof (raw as any).vaultId === 'string' ? (raw as any).vaultId : null;
  const frozen    = !!(raw as any).frozen;
  return { id, wallet: String((raw as any).wallet || ''), mints, cadence, createdAt, vaultId, frozen };
}

async function listRebalanceSetIds(wallet: string): Promise<string[]> {
  try {
    const [a, b] = await Promise.all([
      (redis as any).smembers(RB_IDX(wallet) as any).catch(() => []),
      (redis as any).smembers(RB_IDX_OLD(wallet) as any).catch(() => []),
    ]);
    const bag: Record<string, true> = {};
    for (const x of (a || [])) bag[String(x)] = true;
    for (const x of (b || [])) bag[String(x)] = true;
    return Object.keys(bag);
  } catch {
    return [];
  }
}

async function loadRebalanceDocs(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const keys = ([] as string[]).concat(ids.map(RB_SET), ids.map(RB_SET_OLD));
  let arr: any[] | null = null;
  try { arr = await (redis as any).mget(keys as any).catch(() => null) as any[] | null; } catch {}
  const out: any[] = [];
  if (arr && Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i++) {
      let raw = arr[i];
      if (raw == null) continue;
      if (typeof raw === 'string') {
        const parsed = parseMaybeJson(raw);
        if (parsed) raw = parsed;
        else {
          const alt = await jsonOrHash(keys[i]);
          if (alt) raw = alt;
        }
      }
      const doc = coerceRebalanceDoc(raw);
      if (doc) out.push(doc);
    }
  } else {
    // fallback one-by-one
    for (const id of ids) {
      const d1 = await jsonOrHash(RB_SET(id));
      const d2 = await jsonOrHash(RB_SET_OLD(id));
      const doc = coerceRebalanceDoc(d1 || d2);
      if (doc) out.push(doc);
    }
  }
  // de-dupe by id
  const bag: Record<string, any> = {};
  for (const d of out) bag[d.id] = d;
  return Object.values(bag);
}

// Token meta helpers (compatible with /api/tokens/meta)
const LITE_TOKEN_META = (mint: string) => `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`;
const SEARCH_BY_MINT  = (mint: string) => `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`;
const TTL_META_SEC = 60 * 60 * 24 * 30;

async function getTokenMetaForMints(mints: string[]): Promise<any[]> {
  const uniq = Array.from(new Set(mints.filter(Boolean)));
  const items: any[] = [];
  const cached = await Promise.all(uniq.map((m) => cacheGetJSON(cacheKey('token','meta', m))));
  const missing: string[] = [];
  uniq.forEach((m, i) => {
    const v = cached[i];
    if (v && typeof v === 'object') items.push(v as any);
    else missing.push(m);
  });
  if (missing.length) {
    for (const m of missing) {
      let meta: any | null = null;
      try {
        const r = await fetch(LITE_TOKEN_META(m), { cache: 'no-store' });
        if (r.ok) {
          const j: any = await r.json().catch(() => ({}));
          const data = j?.data || null;
          if (data && typeof data?.address === 'string') {
            meta = {
              address: String(data.address),
              mint: String(data.address),
              symbol: String(data.symbol || ''),
              name: String(data.name || ''),
              logoURI: String((data as any).logoURI || (data as any).logoUri || ''),
              decimals: Number.isFinite(data.decimals) ? data.decimals : undefined,
              verified: typeof (data as any).verified === 'boolean' ? (data as any).verified : undefined,
            };
          }
        }
        if (!meta) {
          const r2 = await fetch(SEARCH_BY_MINT(m), { cache: 'no-store' });
          if (r2.ok) {
            const j2: any = await r2.json().catch(() => ({}));
            const arr: any[] = Array.isArray(j2?.tokens) ? j2.tokens : Array.isArray(j2?.items) ? j2.items : [];
            const cand = arr.find((t: any) => String(t?.address || t?.mint || '').trim() === m) || arr[0] || null;
            if (cand) {
              meta = {
                address: String(cand.address || cand.mint || m),
                mint: String(cand.address || cand.mint || m),
                symbol: String(cand.symbol || ''),
                name: String(cand.name || ''),
                logoURI: String((cand as any).logoURI || (cand as any).logoUri || ''),
                decimals: Number.isFinite(cand.decimals) ? cand.decimals : undefined,
                verified: typeof (cand as any).verified === 'boolean' ? (cand as any).verified : undefined,
              };
            }
          }
        }
      } catch {}
      if (meta) {
        items.push(meta);
        await cacheSetJSON(cacheKey('token','meta', meta.address), meta, TTL_META_SEC);
      }
    }
  }
  const bag: Record<string, any> = {};
  for (const it of items) bag[String((it as any).address)] = it;
  if (!bag[MINT_SOL])  bag[MINT_SOL]  = { address: MINT_SOL,  mint: MINT_SOL,  symbol: 'SOL',  name: 'Solana',  logoURI: '/brand/solana-64.png', decimals: 9, verified: true };
  if (!bag[MINT_USDC]) bag[MINT_USDC] = { address: MINT_USDC, mint: MINT_USDC, symbol: 'USDC', name: 'USD Coin', logoURI: '', decimals: 6, verified: true };
  return Object.values(bag);
}

// Vault + deletable helpers (batch)
const SET_VAULT_ID = (setId: string) => `mm:set:${setId}:vaultId`;
const SET_DELETABLE = (setId: string) => `mm:set:${setId}:deletable`;


function readVaultProgramId(): PublicKey {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID as string) ||
    (process.env.VAULT_PROGRAM_ID as string) ||
    "";
  try { return new PublicKey(raw); } catch { return new PublicKey("2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp"); }
}

function setIdToBytes16Compat(setId: string): Uint8Array {
  const raw = String(setId || '').trim().replace(/-/g, '');
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return Uint8Array.from(Buffer.from(raw, 'hex'));
  try {
    const crypto = require('crypto') as typeof import('crypto');
    return new Uint8Array(crypto.createHash('md5').update(raw, 'utf8').digest());
  } catch {
    // fallback: zero pad
    const h = (raw + '0'.repeat(32)).slice(0, 32);
    return Uint8Array.from(Buffer.from(h, 'hex'));
  }
}

async function autoHealVaultMappings(args: {
  wallet: string;
  ids: string[];
  vaultMap: Record<string, string | null>;
}): Promise<void> {
  const { wallet, ids, vaultMap } = args;
  // Auto-heal: if mapping is missing but the derived vault PDA exists on-chain,
  // persist mm:set:{id}:vaultId and patch the set doc for future boots.
  // No UI/UX changes; best-effort only.
  let ownerPk: PublicKey;
  try { ownerPk = new PublicKey(wallet); } catch { return; }
  const programId = readVaultProgramId();
  const conn = getConnection();
  const toWrite: Array<{ setId: string; vault: string }> = [];

  for (const setId of ids) {
    if (vaultMap[setId]) continue;
    try {
      const seed16 = setIdToBytes16Compat(setId);
      const vaultPk = deriveVaultPda(ownerPk, seed16);
      const info = await conn.getAccountInfo(vaultPk, { commitment: 'confirmed' });
      if (info?.owner?.equals(programId)) {
        const v = vaultPk.toBase58();
        vaultMap[setId] = v;
        toWrite.push({ setId, vault: v });
      }
    } catch {
      // ignore per-set errors
    }
  }

  if (!toWrite.length) return;

  try {
    const pipe = (redis as any).pipeline?.() || null;
    if (pipe && typeof pipe.set === 'function') {
      for (const row of toWrite) {
        pipe.set(SET_VAULT_ID(row.setId), row.vault);
        // Also seed legacy key to keep older code paths stable.
        pipe.set(`mm:set:${row.setId}:vault`, row.vault);
        // Patch set doc hash (best-effort)
        pipe.hset(`mm:set:${row.setId}`, { vaultId: row.vault, vault: row.vault, vaultAddress: row.vault });
      }
      await pipe.exec().catch(() => null);
    } else {
      await Promise.all(toWrite.map(async (row) => {
        try { await (redis as any).set(SET_VAULT_ID(row.setId), row.vault); } catch {}
        try { await (redis as any).set(`mm:set:${row.setId}:vault`, row.vault); } catch {}
        try { await (redis as any).hset(`mm:set:${row.setId}`, { vaultId: row.vault, vault: row.vault, vaultAddress: row.vault }); } catch {}
      }));
    }
  } catch {
    // ignore
  }
}


async function getVaultAndDeletable(ids: string[]): Promise<{ vaultMap: Record<string,string|null>, deletableMap: Record<string,boolean> }> {
  if (!ids.length) return { vaultMap: {}, deletableMap: {} };

  // NOTE:
  //  - Newer mapping key:  mm:set:{id}:vaultId
  //  - Legacy mapping key: mm:set:{id}:vault
  // We read BOTH so the UI never "loses" a vault mapping on refresh.
  const vaultIdKeys = ids.map(SET_VAULT_ID);
  const legacyVaultKeys = ids.map((id) => `mm:set:${id}:vault`);
  const deletableKeys = ids.map(SET_DELETABLE);

  const [vIdArr, vLegacyArr, dArr] = await Promise.all([
    (redis as any).mget(vaultIdKeys as any).catch(() => null) as Promise<any>,
    (redis as any).mget(legacyVaultKeys as any).catch(() => null) as Promise<any>,
    (redis as any).mget(deletableKeys as any).catch(() => null) as Promise<any>,
  ]);

  const vaultMap: Record<string,string|null> = {};
  const deletableMap: Record<string,boolean> = {};

  const toStr = (x: any) => (typeof x === 'string' && x.trim() ? x.trim() : null);

  // Best-effort migration: if we only find legacy, we also write vaultId key for future reads.
  const toMigrate: Array<[string, string]> = [];

  ids.forEach((id, i) => {
    const vId = vIdArr && Array.isArray(vIdArr) ? toStr(vIdArr[i]) : null;
    const vLegacy = vLegacyArr && Array.isArray(vLegacyArr) ? toStr(vLegacyArr[i]) : null;

    const v = vId || vLegacy || null;
    vaultMap[id] = v;

    if (!vId && vLegacy) {
      toMigrate.push([SET_VAULT_ID(id), vLegacy]);
    }

    const d = dArr && Array.isArray(dArr) ? (dArr[i] as any) : null;
    deletableMap[id] = !!(d === true || d === '1' || d === 1);
  });

  if (toMigrate.length) {
    try {
      const pipe = (redis as any).pipeline?.() || null;
      if (pipe && typeof pipe.set === 'function') {
        toMigrate.forEach(([k, v]) => pipe.set(k, v));
        await pipe.exec().catch(() => null);
      } else {
        await Promise.all(toMigrate.map(([k, v]) => (redis as any).set(k, v).catch(() => null)));
      }
    } catch {}
  }

  return { vaultMap, deletableMap };
}

export async function GET(
  _req: NextRequest,
  { params }: any
) {
  let wallet = '';
  let data: any;
  try {
    wallet = String(params?.wallet || '').trim();
    if (!wallet) return NextResponse.json({ ok:false, error:'wallet_required' }, { status: 400, headers: noStoreJsonHeaders() });

    const key = cacheKey('boot','v1', wallet);
    data = await singleflight(key, async () => {
      const cached = await cacheGetJSON(key);
      if (cached) return cached;

      // 1) Sets
      const webhooksRaw = await getSetsByWallet(wallet);
      const webhooks = (webhooksRaw || []).map((s: any) => {
        const setId = String(s?.setId || '');
        const prefs = (typeof s?.prefs === 'object' && s.prefs) ? s.prefs : {};
        const buyId = String(s?.buyId || '');
        const sellId = String(s?.sellId || '');
        const label = typeof s?.label === 'string' ? s.label : '';
        const createdAt = Number((s as any).createdAt ?? 0) || undefined;
        const mintIn  = pickMint(prefs, 'mintIn');
        const mintOut = pickMint(prefs, 'mintOut');
        return { setId, wallet, label, prefs, buyId, sellId, mintIn, mintOut, createdAt };
      });

      const rebalanceIds = await listRebalanceSetIds(wallet);
      const rebalance = await loadRebalanceDocs(rebalanceIds);

      const strategies = await getMojoProSetsByWallet(wallet).catch(() => []) || [];

      // 2) Vault + deletable map, batched
      const allIds = ([] as string[]).concat(webhooks.map(s => s.setId), rebalance.map((r: any) => r.id), strategies.map((s: any) => s.setId));
      const { vaultMap, deletableMap } = await getVaultAndDeletable(allIds);
      // Best-effort auto-heal: runs in the background — not awaited so it never adds latency to the
      // bootstrap response. Any discovered vault mappings will be available on the next boot call.
      autoHealVaultMappings({ wallet, ids: allIds, vaultMap }).catch(() => null);

      // Seed vaultMap from rebalance docs if available (helps first paint for rebalance cards)
      for (const r of rebalance) {
        if (r?.id && r?.vaultId && !vaultMap[r.id]) vaultMap[r.id] = String(r.vaultId);
      }

      // 3) Token metas + logo map
      const mints: string[] = [];
      for (const s of webhooks) {
        if (s.mintIn)  mints.push(String(s.mintIn));
        if (s.mintOut) mints.push(String(s.mintOut));
      }
      for (const r of rebalance) {
        const arr = Array.isArray((r as any).mints) ? (r as any).mints : [];
        for (const m of arr) if (m) mints.push(String(m));
      }
      mints.push(MINT_SOL, MINT_USDC); // always include

      const tokenItems = await getTokenMetaForMints(Array.from(new Set(mints)));

      const logos: Record<string,string> = {};
      for (const t of tokenItems) {
        const mint = String(((t as any)?.address || (t as any)?.mint || '')).trim();
        if (!mint) continue;
        const prox = `/api/token-logos/${encodeURIComponent(mint)}`;
        logos[mint] = prox; // always proxy (CDN/cache)
      }

      const boot = {
        ok: true,
        wallet,
        webhooks,
        rebalance,
        strategies,
        vaultMap,
        deletableMap,
        tokens: { items: tokenItems },
        logos,
        ts: Date.now(),
      };

      await cacheSetJSON(key, boot, 10); // ~10s TTL
      return boot;
    });

    return NextResponse.json(data, { headers: privateWalletJsonHeaders() });
  } catch (e: any) {
    // Harden: redact webhook ids/urls for non-owners (privacy boundary).
    try {
      const sessionWallet = await getSessionWalletFromRequest(_req as any);
      const isOwner = !!sessionWallet && sessionWallet === wallet;
      if (!isOwner && data && data.webhooks && Array.isArray(data.webhooks)) {
        data.webhooks = data.webhooks.map((s: any) => ({
          ...s,
          buyId: undefined,
          sellId: undefined,
          urls: undefined,
        }));
      }
    } catch {}
    return NextResponse.json({ ok:false, error: e?.message || 'boot_error' }, { status: 500, headers: noStoreJsonHeaders() });
  }
}
