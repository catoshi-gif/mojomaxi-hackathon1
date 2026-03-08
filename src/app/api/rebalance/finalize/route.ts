/**
 * FINALIZE REBALANCE — freeze equity and surface tx links
 *
 * ADDITIVE HARDENING (Cron-safe):
 *  - Longer bounded retry; never accept 0 from equity API.
 *  - If swap nonces are not provided, salvage them from recent set events (Upstash),
 *    then perform composite (authority + swap_authority) equity scan.
 *  - Dual-key per-run freeze for nonce: writes under both the raw nonce and a normalized decimal,
 *    so the Activity reader can find the correct run regardless of nonce representation.
 *  - Add `vault` to the aggregated event row (purely additive).
 *  - 2025-11 PATCH: Canonicalize setId to dashless (strip 'set_'/'set-'); probe dashed variant only as a fallback.
 *
 * NOTE: All existing functionality is preserved; no UI changes.
 */
import 'server-only';
import { redis } from "@/lib/redis";
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


import bs58 from 'bs58';

import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getMint,
} from '@solana/spl-token';

// Both exist in the repo; use aliases to try both derivations safely.
import { deriveVaultAuthorityPda as derivePdaVaultSdk } from '@/lib/vault-sdk';
import { deriveVaultAuthorityPda as derivePdaProgramServer } from '@/lib/program.server';
import { isTrustedInternalRequest } from '@/lib/auth/internal';

function isInternal(req: NextRequest): boolean {
  return isTrustedInternalRequest(req);
}


type AnyObj = Record<string, any>;

// ---- TYPE FIX: explicit union avoids typeof-narrowing to "none" ----
type EquitySource =
  | 'equity_api'
  | 'authority_scan'
  | 'composite_scan'
  | 'composite_scan_from_events'
  | 'none';

// ---------------- Keys (kept) ----------------
const KEY_SET_RECENT    = (setId: string) => `mm:set:${setId}:recent`;
const KEY_SET_EVENTS    = (setId: string) => `mm:events:${setId}`;
const KEY_GLOBAL        = `mm:events:recent`;
const KEY_REBAL_SET     = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_REBAL_SET_OLD = (setId: string) => `REBAL_SET:${setId}`; // legacy
const KEY_REBAL_RUN     = (setId: string, runKey: string) => `mm:rebal:run:${setId}:${runKey}`;

// ---------------- Small utils ----------------
const nowMs = () => Date.now();
const toNum = (x: any, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };
const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms|0)));
const asStr = (v: any) => (v == null ? '' : String(v)).trim();

function hostLooksLocal(h: string): boolean {
  return /^localhost(:\d+)?$/i.test(h) || /^127\.0\.0\.1(?::\d+)?$/.test(h);
}

/** Canonicalize: strip leading set_ / set- if present; DO NOT insert dashes. */
function canonicalSetId(raw: string): string {
  const s = String(raw || '').trim();
  const m = s.match(/^set[_-](.+)$/i);
  return m ? m[1] : s;
}

/** Helper: return dashed variant if input is 32-hex; else null (for fallback reads only). */
function dashedIf32Hex(id: string): string | null {
  const no = String(id || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(no)) return null;
  return `${no.slice(0,8)}-${no.slice(8,12)}-${no.slice(12,16)}-${no.slice(16,20)}-${no.slice(20)}`;
}

/** Prefer the real request origin for internal fetches. */
function inferOrigin(req: NextRequest): string {
  try {
    const o = (req as any).nextUrl?.origin || new URL(req.url).origin;
    if (o && o !== 'null') return o;
  } catch {}
  const h = req.headers;
  const forwarded = h.get('x-forwarded-host') || h.get('host') || '';
  let proto = 'https';
  const xf = h.get('x-forwarded-proto');
  if (xf) {
    const p0 = xf.split(',')[0].trim();
    if (p0) proto = p0;
  }
  if (forwarded && !hostLooksLocal(forwarded)) proto = 'https';
  if (forwarded) return `${proto}://${forwarded}`;
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL || '';
  if (envUrl) return envUrl.startsWith('http') ? envUrl : `https://${envUrl}`;
  return 'http://localhost:3000';
}

function buildInternalUrl(req: NextRequest, path: string, qs?: URLSearchParams): string {
  const base = inferOrigin(req);
  const u = new URL(path.startsWith('/') ? path : `/${path}`, base);
  if (qs) qs.forEach((v,k) => u.searchParams.set(k, v));
  return u.toString();
}

function err(e: any): string { try { return String(e?.message || e); } catch { return 'error'; } }

async function getJSON(key: string): Promise<any | null> {
  // Prefer JSON.GET; fall back to GET and HGETALL
  try {
    const v = await (redis as any).json?.get?.(key, '$');
    if (Array.isArray(v) && v.length) return v[0];
    if (v && typeof v === 'object') return v;
  } catch {}
  try {
    const raw = await redis.get<string>(key as any);
    if (typeof raw === 'string' && raw.trim().startsWith('{')) return JSON.parse(raw);
  } catch {}
  try {
    const h = await (redis as any).hgetall(key);
    if (h && typeof h === 'object' && Object.keys(h).length) return h;
  } catch {}
  return null;
}

async function setJSON(key: string, doc: AnyObj): Promise<void> {
  let ok = false;
  try { await (redis as any).json?.set?.(key, '$', doc); ok = true; } catch {}
  if (!ok) { try { await (redis as any).set(key, JSON.stringify(doc)); ok = true; } catch {} }
  if (!ok) { await (redis as any).hset(key, doc as any); }
}

async function lrangeParseJSON(key: string, start = 0, stop = 199): Promise<any[]> {
  try {
    const arr = await (redis as any).lrange(key, start, stop);
    if (!Array.isArray(arr)) return [];
    return arr.map((x: any) => {
      if (!x) return null;
      try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Build headers for internal fetches; forwards x-wallet and x-set-id. */
function buildInternalHeaders(req: NextRequest, walletHeader?: string, setIdHeader?: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-mm-internal': '1' };

  // Forward wallet header (critical for /api/vault/equity ACL/selection on server)
  const incomingWallet = (req.headers.get('x-wallet') || '').trim();
  if (walletHeader && walletHeader.trim()) headers['x-wallet'] = walletHeader.trim();
  else if (incomingWallet) headers['x-wallet'] = incomingWallet;

  // Optional set id hint
  if (setIdHeader && setIdHeader.trim()) headers['x-set-id'] = setIdHeader.trim();

  // Forward Authorization (cron or incoming)
  try {
    const auth = String(
      req.headers.get('authorization') ||
      (process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : '') ||
      ''
    ).trim();
    if (auth) headers['authorization'] = auth;
  } catch {}

  // Pass-through browser-like headers (helps WAF expectations)
  try {
    const ua = req.headers.get('user-agent') || 'MojomaxiFinalize/1.0';
    headers['user-agent'] = ua;
    const al = req.headers.get('accept-language');
    if (al) headers['accept-language'] = al;
    const cookie = req.headers.get('cookie');
    if (cookie) headers['cookie'] = cookie;
  } catch {}

  // Vercel preview protection bypass
  try {
    const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  } catch {}

  // Optional Cloudflare WAF bypass token
  try {
    const internalToken = (process.env.X_MM_INTERNAL_TOKEN || process.env.INTERNAL_FETCH_TOKEN || '').trim();
    if (internalToken) headers['x-mm-internal-token'] = internalToken;
  } catch {}

  // Optional Cloudflare Zero Trust service auth
  try {
    const cid = process.env.CF_ACCESS_CLIENT_ID;
    const csec = process.env.CF_ACCESS_CLIENT_SECRET;
    const svc = process.env.CF_ACCESS_SERVICE_TOKEN;
    if (cid && csec) {
      headers['CF-Access-Client-Id'] = cid;
      headers['CF-Access-Client-Secret'] = csec;
    } else if (svc) {
      headers['Authorization'] = `Bearer ${svc}`;
    }
  } catch {}

  return headers;
}

// ---------------- Internal helpers ----------------
async function fetchSetDoc(req: NextRequest, setId: string): Promise<any | null> {
  try {
    const u = buildInternalUrl(req, `/api/rebalance/set/${encodeURIComponent(setId)}`);
    const r = await fetch(u, { cache: 'no-store', headers: buildInternalHeaders(req, undefined, setId) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null as any);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

// Accept optional `wallet`, pass it via querystring + x-wallet header
async function fetchVaultId(req: NextRequest, setId: string, wallet?: string | null): Promise<string | null> {
  try {
    const qs = new URLSearchParams();
    if (wallet && wallet.trim()) qs.set('wallet', wallet.trim());
    const u = buildInternalUrl(req, `/api/sets/${encodeURIComponent(setId)}/vaultid`, qs);
    const r = await fetch(u, {
      cache: 'no-store',
      headers: buildInternalHeaders(req, wallet || undefined, setId), // force x-wallet when known
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({} as any));
    const v = j?.vault || j?.value || null;
    return v ? String(v) : null;
  } catch { return null; }
}

/** Try to gather swap nonces for this run by scanning recent set events (SWAP_REBALANCE/REBALANCE). */
async function collectSwapNoncesFromRecentEvents(setId: string): Promise<string[]> {
  const ids = [setId];
  const dashed = dashedIf32Hex(setId);
  if (dashed && dashed !== setId) ids.push(dashed);
  const keys = ids.flatMap((id) => [
    KEY_SET_EVENTS(id),
    KEY_SET_RECENT(id),
  ]);
  const out: string[] = [];
  for (const k of keys) {
    try {
      const arr = await lrangeParseJSON(k, 0, 199);
      for (const row of arr) {
        try {
          const kind = String(row?.kind || row?.event || '').toUpperCase();
          if (kind !== 'SWAP_REBALANCE' && kind !== 'REBALANCE') continue;
          const n =
            row?.rebalanceNonce ?? row?.swapNonce ?? row?.nonce ?? null;
          if (n != null) {
            const s = String(n).trim();
            if (s) out.push(s);
          }
        } catch {}
      }
    } catch {}
  }
  return Array.from(new Set(out));
}

/** PATCH: salvage wallet/vault from recent events if missing in setDoc */
async function findWalletFromEvents(setId: string): Promise<string | null> {
  const ids = [setId];
  const dashed = dashedIf32Hex(setId);
  if (dashed && dashed !== setId) ids.push(dashed);
  for (const id of ids) {
    const rows = await lrangeParseJSON(KEY_SET_EVENTS(id), 0, 50);
    for (const r of rows) {
      const w = asStr((r as any)?.wallet);
      if (w) return w;
    }
    const rows2 = await lrangeParseJSON(KEY_SET_RECENT(id), 0, 50);
    for (const r of rows2) {
      const w = asStr((r as any)?.wallet);
      if (w) return w;
    }
  }
  return null;
}
async function findVaultFromEvents(setId: string): Promise<string | null> {
  const ids = [setId];
  const dashed = dashedIf32Hex(setId);
  if (dashed && dashed !== setId) ids.push(dashed);
  for (const id of ids) {
    const rows = await lrangeParseJSON(KEY_SET_EVENTS(id), 0, 50);
    for (const r of rows) {
      const v = asStr((r as any)?.vault);
      if (v) return v;
    }
    const rows2 = await lrangeParseJSON(KEY_SET_RECENT(id), 0, 50);
    for (const r of rows2) {
      const v = asStr((r as any)?.vault);
      if (v) return v;
    }
  }
  return null;
}

/** PATCH: equity API helper that tries snapshot=1 then snapshot=0 and accepts totalUsd||equityUsd||equity */
async function fetchEquityApi(req: NextRequest, setId: string, wallet?: string | null, vault?: string | null): Promise<number | null> {
  const parse = (j: any) => {
    const v = Number(j?.totalUsd ?? j?.equityUsd ?? j?.equity);
    return Number.isFinite(v) ? v : null;
  };
  const doFetch = async (snapshot: 0 | 1) => {
    try {
      const qs = new URLSearchParams();
      if (setId) qs.set('setId', setId);
      if (wallet) qs.set('wallet', wallet);
      if (vault) qs.set('vault', vault);
      qs.set('commitment','finalized');
      qs.set('snapshot', String(snapshot));
      const u = buildInternalUrl(req, '/api/vault/equity', qs);
      const r = await fetch(u, { cache: 'no-store', headers: buildInternalHeaders(req, wallet || undefined, setId) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({} as any));
      return parse(j);
    } catch {
      return null;
    }
  };
  // Try snapshot first (post‑swap), then live
  const a = await doFetch(1);
  if (Number.isFinite(a as number) && (a as number) > 0) return Number(a);
  const b = await doFetch(0);
  if (Number.isFinite(b as number) && (b as number) > 0) return Number(b);
  return null;
}

function rpcUrl(): string {
  return (
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.SOLANA_MAINNET_RPC ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    clusterApiUrl('mainnet-beta')
  );
}

async function waitForConfirmations(connection: Connection, sigs: string[], until = 30_000_000): Promise<void> {
  if (!sigs?.length) return;
  const start = Date.now();
  const unique = Array.from(new Set(sigs.filter(Boolean)));
  while (Date.now() - start < until) {
    try {
      const st = await connection.getSignatureStatuses(unique, { searchTransactionHistory: true });
      const ok = (st?.value || []).every((v) => (v?.confirmationStatus === 'finalized'));
      if (ok) return;
    } catch {}
    await sleep(350);
  }
}

async function scanAuthorityEquity(req: NextRequest, authority: PublicKey): Promise<{ total: number; byMint: Record<string, number> }> {
  const byMint: Record<string, number> = {};
  const connection = new Connection(rpcUrl(), 'confirmed');
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  for (const programId of programs) {
    try {
      const accs = await connection.getTokenAccountsByOwner(authority, { programId });
      for (const a of accs.value) {
        try {
          const parsed = await getAccount(connection, a.pubkey, undefined, programId);
          const mint = parsed.mint.toBase58();
          const mintInfo = await getMint(connection, parsed.mint, undefined, programId);
          const ui = Number(parsed.amount) / Math.pow(10, mintInfo.decimals);
          byMint[mint] = (byMint[mint] || 0) + ui;
        } catch {}
      }
    } catch {}
  }
  const mints = Object.keys(byMint);
  if (!mints.length) return { total: 0, byMint };
  try {
    const qs = new URLSearchParams();
    qs.set('mints', mints.join(','));
    const u = buildInternalUrl(req, '/api/prices', qs);
    const r = await fetch(u, { cache: 'no-store', headers: buildInternalHeaders(req) });
    const j = await r.json().catch(() => ({} as any));
    const price: Record<string, number> = (j?.data || j?.prices || j) as any;
    let total = 0;
    for (const m of mints) {
      const p = Number(price?.[m]);
      if (Number.isFinite(p)) total += byMint[m] * p;
    }
    return { total, byMint };
  } catch {
    return { total: 0, byMint };
  }
}

function toU64LeFromFlexibleNonce(n: any): Buffer | null {
  if (n == null) return null;
  try {
    let v: bigint;
    if (typeof n === 'bigint') v = n;
    else {
      const s = String(n).trim();
      if (!s) return null;
      v = BigInt(s); // accepts 0x.. or decimal
    }
    if (v < 0n || v > 18446744073709551615n) return null;
    const buf = Buffer.alloc(8);
    let x = v;
    for (let i = 0; i < 8; i++) { buf[i] = Number(x & 0xffn); x >>= 8n; }
    return buf;
  } catch { return null; }
}

function getVaultProgramId(): PublicKey {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID as string) ||
    (process.env.VAULT_PROGRAM_ID as string) ||
    '2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp';
  return new PublicKey(raw);
}

function getAuthorityForVault(programId: PublicKey, vaultPk: PublicKey): PublicKey | null {
  // Try vault-sdk derive first (tuple return)
  try {
    const out = (derivePdaVaultSdk as any)(programId, vaultPk);
    if (Array.isArray(out) && out.length && out[0] instanceof PublicKey) return out[0] as PublicKey;
  } catch {}
  // Fallback: program.server derive that returns a PublicKey directly
  try {
    const out2 = (derivePdaProgramServer as any)(vaultPk);
    if (out2 instanceof PublicKey) return out2 as PublicKey;
  } catch {}
  return null;
}

const EC_SWAP_AUTH_SEED = 'swap_authority';
const CONFIG_SEED_STR = 'config';

// sha256("global:sweep_ec_pda_bins")[..8]
const DISC_SWEEP_EC_PDA_BINS = Buffer.from([0x0c, 0xab, 0x64, 0x92, 0x1e, 0x1b, 0x35, 0xca]);

function loadRelayerForSweep(): Keypair {
  const s = process.env.RELAYER_SECRET || process.env.ADMIN_RELAYER_SECRET || '';
  if (!s) throw new Error('missing RELAYER_SECRET/ADMIN_RELAYER_SECRET');
  try {
    if (s.startsWith('[')) {
      const arr = JSON.parse(s);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(s));
  } catch (e: any) {
    throw new Error(`invalid_relayer_secret:${e?.message || String(e)}`);
  }
}

function assertRelayerMatchesEnv(relayerPk58: string) {
  const expected = (
    process.env.EXPECT_RELAYER_PUBKEY ||
    process.env.NEXT_PUBLIC_EXPECT_RELAYER_PUBKEY ||
    ''
  ).trim();
  if (expected && expected !== relayerPk58) {
    throw new Error(`relayer_pubkey_mismatch: expected ${expected} got ${relayerPk58}`);
  }
}

async function tryFinalEcPdaSweep(params: { vault: string | null; swapNonce: any }): Promise<void> {
  const { vault, swapNonce } = params;
  if (!vault) return;

  const swapNonceLe = toU64LeFromFlexibleNonce(swapNonce);
  if (!swapNonceLe) return;

  const programId = getVaultProgramId();
  const vaultPk = new PublicKey(vault);

  const [swapAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from(EC_SWAP_AUTH_SEED), vaultPk.toBuffer(), swapNonceLe],
    programId
  );

  const conn = new Connection(rpcUrl(), 'confirmed');
  const relayer = loadRelayerForSweep();
  const payer = relayer.publicKey;
  assertRelayerMatchesEnv(payer.toBase58());

  const [config] = PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED_STR)], programId);

  const tokenPrograms = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const bins: { programId: PublicKey; pubkey: PublicKey }[] = [];

  for (const tokenProgram of tokenPrograms) {
    try {
      const res = await conn.getTokenAccountsByOwner(swapAuthority, { programId: tokenProgram }, 'confirmed');
      for (const it of res.value) bins.push({ programId: tokenProgram, pubkey: it.pubkey });
    } catch {}
  }

  if (!bins.length) return;

  const keys: AccountMeta[] = [
    { pubkey: payer,         isSigner: true,  isWritable: true },
    { pubkey: swapAuthority, isSigner: false, isWritable: false },
    { pubkey: config,        isSigner: false, isWritable: false },
  ];
  for (const b of bins) {
    keys.push({ pubkey: b.programId, isSigner: false, isWritable: false });
    keys.push({ pubkey: b.pubkey,    isSigner: false, isWritable: true });
  }

  const data = Buffer.concat([
    DISC_SWEEP_EC_PDA_BINS,
    vaultPk.toBuffer(),
    swapNonceLe,
  ]);

  const ix = new TransactionInstruction({ programId, keys, data });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');

  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;
  tx.add(ix);
  tx.sign(relayer);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'processed',
    maxRetries: 3,
  });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'processed');
}

function normalizeNonceVariants(n: any): string[] {
  const s = String(n ?? '').trim();
  if (!s) return [];
  const out = new Set<string>();
  out.add(s);
  try {
    const bi = BigInt(s.startsWith('0x') ? s : s);
    out.add(bi.toString(10));
    out.add('0x' + bi.toString(16));
  } catch {}
  return Array.from(out).map(v => `nonce:${v}`);
}

export async function POST(req: NextRequest) {
  if (!isInternal(req)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  try {
    const j: AnyObj = await req.json().catch(() => ({}));

    // Canonicalize setId to dashless (strip set_/set- only)
    const setIdRaw = String(j?.setId || j?.set_id || '').trim();
    const setId = canonicalSetId(setIdRaw);
    if (!setId) return NextResponse.json({ ok: false, error: 'missing_setId' }, { status: 400 });

    // Inputs that help correlation
    const runIdIn = typeof j?.runId === 'string' ? j.runId.trim() : '';
    const nonceIn = j?.rebalanceNonce ?? j?.swapNonce ?? j?.nonce ?? null;
    let swapNoncesIn: any[] = Array.isArray((j as any)?.swapNonces) ? (j as any).swapNonces : (nonceIn != null ? [nonceIn] : []);

    const walletIn = typeof j?.wallet === 'string' ? j.wallet.trim() : '';
    const vaultIn  = typeof j?.vault  === 'string' ? j.vault.trim()  : '';
    const tsBase = Number.isFinite(Number(j?.ts)) ? Number(j.ts) : nowMs();

    // Resolve set doc, wallet & vault
    const dashedAlt = dashedIf32Hex(setId);
    const setDoc =
      (await getJSON(KEY_REBAL_SET(setId))) ||
      (dashedAlt ? await getJSON(KEY_REBAL_SET(dashedAlt)) : null) ||
      (await getJSON(KEY_REBAL_SET_OLD(setId))) ||
      (await fetchSetDoc(req, setId)) ||
      null;

    let wallet: string | null =
      walletIn ||
      (typeof setDoc?.wallet === 'string' ? setDoc.wallet : null) ||
      (typeof setDoc?.walletAddress === 'string' ? setDoc.walletAddress : null) ||
      null;
    let vault: string | null =
      vaultIn ||
      (typeof setDoc?.vault === 'string' ? setDoc.vault : null) ||
      (typeof setDoc?.vaultAddress === 'string' ? setDoc.vaultAddress : null) ||
      (typeof setDoc?.vaultId === 'string' ? setDoc.vaultId : null) ||
      null;

    // When trying the resolver endpoint, pass the best-known wallet
    if (!vault) vault = await fetchVaultId(req, setId, wallet);

    // Salvage anchors from recent events if missing
    if (!wallet) wallet = await findWalletFromEvents(setId);
    if (!vault)  vault  = await findVaultFromEvents(setId);

    // After salvaging wallet from events, try the resolver again with wallet present
    if (!vault && wallet) vault = await fetchVaultId(req, setId, wallet);

    // Collect signatures (if any)
    let sigs: string[] = Array.isArray(j?.signatures) ? j.signatures.map((x: any) => String(x || '').trim()).filter(Boolean) : [];
    if (!sigs.length && (j as any)?.signature) sigs = [String((j as any).signature || '').trim()].filter(Boolean);
    if (!sigs.length && (j as any)?.sig)        sigs = [String((j as any).sig || '').trim()].filter(Boolean);
    if (!sigs.length && (j as any)?.tx)         sigs = [String((j as any).tx || '').trim()].filter(Boolean);
    if (!sigs.length && (j as any)?.hash)       sigs = [String((j as any).hash || '').trim()].filter(Boolean);
    if (!sigs.length && Array.isArray((j as any)?.sigs)) sigs = (j as any).sigs.map((x: any) => String(x || '').trim()).filter(Boolean);

    // Wait briefly for confirmations so snapshot is post‑swap
    if (sigs.length) {
      const conn = new Connection(rpcUrl(), 'confirmed');
      await waitForConfirmations(conn, sigs, 15_000);
    } else {
      await sleep(500);
    }

    // If we didn't receive nonces from the caller, try to salvage from recent set events.
    if (!Array.isArray(swapNoncesIn) || swapNoncesIn.length === 0) {
      try {
        swapNoncesIn = await collectSwapNoncesFromRecentEvents(setId);
      } catch {}
    }

    // Resolve a robust equity snapshot (accept strictly > 0)
    const retrySchedule = [0, 600, 1500, 3000, 6000, 10000, 14000];
    let totalUsd: number | null = null;
    let equitySource: EquitySource = 'none';

    // Stabilization loop: sample equity multiple times and prefer the highest settled value.
    let bestTotal: number | null = null;
    let bestSource: EquitySource = 'none';
    for (const delay of retrySchedule) {
      if (delay) await sleep(delay);

      // Candidate 1: internal equity API (finalized commitment)
      const viaApi = await fetchEquityApi(req, setId, wallet, vault);
      if (Number.isFinite(viaApi as number) && (viaApi as number) > 0) {
        const vNum = Number(viaApi);
        if (!(Number.isFinite(bestTotal as number) && (bestTotal as number) >= vNum)) {
          bestTotal = vNum;
          bestSource = 'equity_api';
        }
      }

      // Candidate 2: composite scan (authority + EC-PDA swap bins), but only if we have nonces
      if (vault && Array.isArray(swapNoncesIn) && swapNoncesIn.length) {
        try {
          const programId = getVaultProgramId();
          const vaultPk = new PublicKey(vault);
          const byMint: Record<string, number> = {};
          const mints: string[] = [];
          const seen: Set<string> = new Set();

          const addBin = (mint: string, ui: number) => {
            const k = String(mint || '').trim();
            if (!k) return;
            if (!seen.has(k)) { mints.push(k); seen.add(k); }
            byMint[k] = (byMint[k] || 0) + (Number(ui) || 0);
          };

          // authority
          try {
            const auth = getAuthorityForVault(programId, vaultPk);
            if (auth) {
              const conn = new Connection(rpcUrl(), 'finalized');
              const [tokKeg, tok22] = await Promise.all([
                conn.getParsedTokenAccountsByOwner(auth, { programId: TOKEN_PROGRAM_ID }, 'finalized'),
                conn.getParsedTokenAccountsByOwner(auth, { programId: TOKEN_2022_PROGRAM_ID }, 'finalized').catch(() => ({ value: [] as any[] })),
              ]);
              for (const it of ((tokKeg as any)?.value || [])) {
                const info = (it?.account?.data as any)?.parsed?.info;
                const mint = String(info?.mint || '').trim();
                const ui = Number(info?.tokenAmount?.uiAmount ?? 0);
                if (ui > 0) addBin(mint, ui);
              }
              for (const it of ((tok22 as any)?.value || [])) {
                const info = (it?.account?.data as any)?.parsed?.info;
                const mint = String(info?.mint || '').trim();
                const ui = Number(info?.tokenAmount?.uiAmount ?? 0);
                if (ui > 0) addBin(mint, ui);
              }
            }
          } catch {}

          // EC-PDA swap bins
          try {
            for (const n of swapNoncesIn) {
              const le = toU64LeFromFlexibleNonce(n);
              if (!le) continue;
              const [sa] = PublicKey.findProgramAddressSync([Buffer.from(EC_SWAP_AUTH_SEED), vaultPk.toBuffer(), le], programId);
              const conn = new Connection(rpcUrl(), 'finalized');
              const [tokKeg, tok22] = await Promise.all([
                conn.getParsedTokenAccountsByOwner(sa, { programId: TOKEN_PROGRAM_ID }, 'finalized'),
                conn.getParsedTokenAccountsByOwner(sa, { programId: TOKEN_2022_PROGRAM_ID }, 'finalized').catch(() => ({ value: [] as any[] })),
              ]);
              for (const it of ((tokKeg as any)?.value || [])) {
                const info = (it?.account?.data as any)?.parsed?.info;
                const mint = String(info?.mint || '').trim();
                const ui = Number(info?.tokenAmount?.uiAmount ?? 0);
                if (ui > 0) addBin(mint, ui);
              }
              for (const it of ((tok22 as any)?.value || [])) {
                const info = (it?.account?.data as any)?.parsed?.info;
                const mint = String(info?.mint || '').trim();
                const ui = Number(info?.tokenAmount?.uiAmount ?? 0);
                if (ui > 0) addBin(mint, ui);
              }
            }
          } catch {}

          // Price them
          if (mints.length) {
            try {
              const qs = new URLSearchParams();
              qs.set('mints', mints.join(','));
              const u = buildInternalUrl(req, '/api/prices', qs);
              const r = await fetch(u, { cache: 'no-store', headers: buildInternalHeaders(req) });
              const j = await r.json().catch(() => ({} as any));
              const prices: Record<string, number> = (j?.data || j?.prices || j) as any;
              let total = 0;
              for (const m of mints) {
                const p = Number(prices?.[m]);
                if (Number.isFinite(p)) total += (byMint[m] || 0) * p;
              }
              if (total > 0 && (!(Number.isFinite(bestTotal as number)) || total > (bestTotal as number))) {
                bestTotal = total;
                bestSource = 'composite_scan_from_events';
              }
            } catch {}
          }
        } catch {}
      }
    }

    totalUsd = bestTotal;
    equitySource = bestSource;

    if (!(Number.isFinite(totalUsd as number) && (totalUsd as number) > 0)) {
      totalUsd = null;
      equitySource = 'none';
    }

    // P&L deltas (kept same shape fields if setDoc has anchors)
    const startingTotalUsd = toNum((setDoc as any)?.startingTotalUsd, NaN);
    const lastTotalUsd     = toNum((setDoc as any)?.lastTotalUsd, NaN);
    let pnlUsd: number | null = null, pnlPct: number | null = null;
    let pnlLastUsd: number | null = null, pnlLastPct: number | null = null;
    if (Number.isFinite(totalUsd as number) && Number.isFinite(startingTotalUsd)) {
      pnlUsd = (totalUsd as number) - startingTotalUsd;
      if (startingTotalUsd > 0) pnlPct = pnlUsd / startingTotalUsd * 100;
    }
    if (Number.isFinite(totalUsd as number) && Number.isFinite(lastTotalUsd)) {
      pnlLastUsd = (totalUsd as number) - lastTotalUsd;
      if (lastTotalUsd > 0) pnlLastPct = pnlLastUsd / lastTotalUsd * 100;
    }

    // Build aggregated event row
    const txUrls = uniq((sigs || []).map((s) => s && `https://solscan.io/tx/${s}`).filter(Boolean)) as string[];

    // Compute executed volume for this run by summing the swap legs we already recorded as activity.
    // IMPORTANT: Do not use equity snapshots (totalUsd) as volume.
    let volumeUsd: number | null = null;
    try {
      const sigSet = new Set<string>((sigs || []).filter(Boolean) as string[]);
      const urlSigs = new Set<string>();
      for (const u of txUrls) {
        try {
          const parts = String(u).split('/tx/');
          const s = parts.length > 1 ? parts[1].split('?')[0] : '';
          if (s && s.length >= 20) urlSigs.add(s);
        } catch {}
      }
      const want = new Set<string>([...sigSet, ...urlSigs]);

      const pull = async () => {
        const a = await lrangeParseJSON(KEY_SET_EVENTS(setId), 0, 199);
        const b = await lrangeParseJSON(KEY_SET_RECENT(setId), 0, 199);
        return [...a, ...b];
      };

      const rows = await pull();
      let sum = 0;
      for (const e of rows) {
        try {
          const ok = (e as any)?.ok;
          if (ok === false) continue;

          const k = String((e as any)?.kind || (e as any)?.type || '').toUpperCase();
          if (k === 'REBALANCE' || k === 'FIRST_REBALANCE_EQUITY') continue;

          const sig = String((e as any)?.signature || (e as any)?.sig || (e as any)?.txid || '').trim();
          const txUrl = String((e as any)?.txUrl || '').trim();
          let match = false;
          if (sig && sig.length >= 20 && want.has(sig)) match = true;
          if (!match && txUrl) {
            const parts = txUrl.split('/tx/');
            const s = parts.length > 1 ? parts[1].split('?')[0] : '';
            if (s && s.length >= 20 && want.has(s)) match = true;
          }
          if (!match && typeof runIdIn === 'string' && runIdIn && String((e as any)?.runId || '') === runIdIn) match = true;
          if (!match && nonceIn != null && String((e as any)?.rebalanceNonce || (e as any)?.swapNonce || '') === String(nonceIn)) match = true;
          if (!match) continue;

          const inTot = Number((e as any)?.inTotalUsd ?? (e as any)?.inTotalUSD ?? (e as any)?.usdIn ?? NaN);
          if (Number.isFinite(inTot) && inTot > 0) { sum += Math.abs(inTot); continue; }

          const outTot = Number((e as any)?.outTotalUsd ?? (e as any)?.outTotalUSD ?? (e as any)?.usdOut ?? NaN);
          if (Number.isFinite(outTot) && outTot > 0) { sum += Math.abs(outTot); continue; }

          const v = Number((e as any)?.volumeUsd ?? (e as any)?.amountUsd ?? (e as any)?.notionalUsd ?? NaN);
          if (Number.isFinite(v) && v > 0) sum += Math.abs(v);
        } catch {}
      }
      if (Number.isFinite(sum) && sum > 0) volumeUsd = sum;
    } catch {}

    const row: AnyObj = {
      ts: tsBase || nowMs(),

      setId,
      kind: 'REBALANCE',
      aggregated: true,
      runId: runIdIn || (setDoc?.lastRunId ? String(setDoc.lastRunId) : undefined),
      ...(nonceIn != null ? { rebalanceNonce: String(nonceIn) } : {}),
      wallet: wallet || undefined,
      vault: vault || undefined,          // ADDITIVE
      source: 'rebalance',
      ok: true,
      txUrl: txUrls?.[0] || null,
      txUrls: txUrls || [],
      ...(Number.isFinite(volumeUsd as number) && (volumeUsd as number) > 0 ? { volumeUsd } : {}),
      ...(Number.isFinite(totalUsd as number) && (totalUsd as number) > 0 ? { totalUsd } : {}),
      equitySource,
    };

    // Persist a per-run frozen equity snapshot (strictly > 0), dual-key for nonce variants
    try {
      const runKeyDirect = (typeof row.runId === 'string' && row.runId) || '';
      const nonceVariants = (nonceIn != null) ? normalizeNonceVariants(nonceIn) : [];
      const keys: string[] = [];
      if (runKeyDirect) keys.push(runKeyDirect);
      for (const nv of nonceVariants) keys.push(nv);
      const uniqueKeys = Array.from(new Set(keys));

      if (uniqueKeys.length && Number.isFinite(totalUsd as number) && (totalUsd as number) > 0) {
        const freezeDoc: AnyObj = {
          ts: row.ts,
          setId,
          runId: runKeyDirect || undefined,
          rebalanceNonce: nonceIn != null ? String(nonceIn) : undefined,
          totalUsd: Number(totalUsd),
          equitySource,
          txUrls: Array.isArray(row.txUrls) ? row.txUrls : [],
          wallet: wallet || undefined,
          vault: vault || undefined,
          source: 'finalize',
          ...(Number.isFinite(lastTotalUsd) ? { lastTotalUsd } : {}),
        };
        for (const rk of uniqueKeys) {
          await setJSON(KEY_REBAL_RUN(setId, rk), freezeDoc);
        }
      }
    } catch {}

    const serialized = JSON.stringify(row);

    // Write to set streams (LPUSH + LTRIM) using dashless id (canonical)
    await (redis as any).lpush(KEY_SET_RECENT(setId), serialized);
    await (redis as any).ltrim(KEY_SET_RECENT(setId), 0, 199);
    await (redis as any).lpush(KEY_SET_EVENTS(setId), serialized);
    await (redis as any).ltrim(KEY_SET_EVENTS(setId), 0, 199);
    await (redis as any).lpush(KEY_GLOBAL, serialized);
    await (redis as any).ltrim(KEY_GLOBAL, 0, 499);
    // Mirror to dashed setId lists if a dashed variant exists (compat window)
    try {
      if (dashedAlt && dashedAlt !== setId) {
        await (redis as any).lpush(KEY_SET_RECENT(dashedAlt), serialized);
        await (redis as any).ltrim(KEY_SET_RECENT(dashedAlt), 0, 199);
        await (redis as any).lpush(KEY_SET_EVENTS(dashedAlt), serialized);
        await (redis as any).ltrim(KEY_SET_EVENTS(dashedAlt), 0, 199);
      }
    } catch {}
    // legacy aliases
    try { await (redis as any).lpush(`mm:set:${setId}:events`, serialized); await (redis as any).ltrim(`mm:set:${setId}:events`, 0, 199); } catch {}
    try { await (redis as any).lpush(`mm:set:set_${setId}:events`, serialized); await (redis as any).ltrim(`mm:set:set_${setId}:events`, 0, 199); } catch {}
    try { await (redis as any).lpush(`mm:set:set-${setId}:events`, serialized); await (redis as any).ltrim(`mm:set:set-${setId}:events`, 0, 199); } catch {}

    // Update set doc anchors (non‑breaking), mirror to dashed variant doc if present
    try {
      const doc = (setDoc && typeof setDoc === 'object') ? { ...setDoc } : {};
      (doc as any).lastRunId = (row as any).runId || (doc as any).lastRunId || null;
      if (Number.isFinite(totalUsd as number) && (totalUsd as number) > 0) {
        (doc as any).lastTotalUsd = totalUsd;
        if (!Number.isFinite(startingTotalUsd)) (doc as any).startingTotalUsd = totalUsd;
      }
      await setJSON(KEY_REBAL_SET(setId), doc);
      if (dashedAlt && dashedAlt !== setId) {
        await setJSON(KEY_REBAL_SET(dashedAlt), doc);
      }
    } catch {}
    try {
      // legacy mirror
      const doc = await getJSON(KEY_REBAL_SET(setId));
      if (doc) await setJSON(KEY_REBAL_SET_OLD(setId), doc);
    } catch {}

    // Best-effort: final EC-PDA bin sweep for Jupiter-created bins on this rebalance nonce(s).
    try {
      const hasRelayerSecret = !!(process.env.RELAYER_SECRET || process.env.ADMIN_RELAYER_SECRET);
      if (hasRelayerSecret && vault && Array.isArray(swapNoncesIn) && swapNoncesIn.length) {
        for (const n of swapNoncesIn) {
          try { await tryFinalEcPdaSweep({ vault, swapNonce: n }); } catch {}
        }
      } else if (hasRelayerSecret && vault && nonceIn != null) {
        await tryFinalEcPdaSweep({ vault, swapNonce: nonceIn });
      }
    } catch {
      // swallow errors; finalize must remain non-breaking
    }

    // Ensure wallet→rebalance-set index is present so /api/events/recent?wallet=... can discover this set
    try {
      if (wallet && typeof wallet === 'string' && wallet.length) {
        try { await (redis as any).sadd(`mm:rebal:wallet:${wallet}:sets`, setId); } catch {}
        try {
          if (dashedAlt && dashedAlt !== setId) {
            await (redis as any).sadd(`mm:rebal:wallet:${wallet}:sets`, dashedAlt);
            await (redis as any).sadd(`WALLET_REBAL_SETS:${wallet}`, dashedAlt);
          }
        } catch {}
        try { await (redis as any).sadd(`WALLET_REBAL_SETS:${wallet}`, setId); } catch {}
      }
    } catch {}

    return NextResponse.json({ ok: true, aggregated: true, event: row }, { status: 200, headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: 'finalize_failed', detail: err(e) }, { status: 500 });
  }
}
