// filepath: src/app/api/rebalance/rebalance-now/route.ts
// GOLDEN RULE: additive, surgical fix only. No UI/UX changes and no intended functionality removed.
// - Fix Vercel build error caused by stray/duplicated statements after buildInternalHeaders().
// - Make internal server-to-self fetches use a safe origin and consistent headers.
// - Carry a stable runId across all legs and finalize, and forward signatures so finalize can aggregate txUrls.
// - Ensure wallet→rebalance set indexing so Activity (wallet scope) discovers the set.

import 'server-only';
import { redis } from "@/lib/redis";
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Give serverless more headroom so larger baskets can complete.
// (Vercel respects maxDuration on Route Handlers.)
export const maxDuration = 300;

import { getSessionWalletFromRequest } from "@/lib/auth/session.server";
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { ensureVaultAtasForMints } from '@/lib/vault-atas.server';
import { deriveVaultAuthorityPda } from '@/lib/vault-sdk';



function isInternal(req: NextRequest): boolean {
  const auth = String(req.headers.get('authorization') || '').trim();
  const cron = (process.env.CRON_SECRET || '').trim();
  if (cron && auth === `Bearer ${cron}`) return true;

  const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
  if (bypass && String(req.headers.get('x-vercel-protection-bypass') || '').trim() === bypass) {
    return true;
  }

  return false;
}

// ---------------- origin helpers (safe behind Vercel/Cloudflare) ----------------
function hostLooksLocal(h: string): boolean {
  return /^localhost(:\\d+)?$/i.test(h) || /^127\\.0\\.0\\.1(?::\\d+)?$/.test(h);
}
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
function buildInternalUrl(req: NextRequest, path: string): string {
  const base = inferOrigin(req);
  const u = new URL(path.startsWith('/') ? path : `/${path}`, base);
  return u.toString();
}
function buildInternalHeaders(req: NextRequest, walletHeader: string): Record<string,string> {
  const headers: Record<string,string> = {
    'content-type': 'application/json',
    'x-wallet': walletHeader, // case-sensitive; never lowercase
  };

  // Forward auth (CRON or incoming)
  const auth = String(
    req.headers.get('authorization') ||
    (process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : '') ||
    ''
  ).trim();
  if (auth) headers['authorization'] = auth;

  // Vercel preview protection bypass
  const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;

  // Pass-through browser-ish headers (helps Cloudflare/WAF & internal routes)
  const ua = req.headers.get('user-agent') || 'MojomaxiCron/1.0';
  headers['user-agent'] = ua;
  const al = req.headers.get('accept-language');
  if (al) headers['accept-language'] = al;
  const cookie = req.headers.get('cookie');
  if (cookie) headers['cookie'] = cookie;

  // Optional internal bypass token for WAF rules at your edge
  const internalToken = (process.env.X_MM_INTERNAL_TOKEN || process.env.INTERNAL_FETCH_TOKEN || '').trim();
  if (internalToken) headers['x-mm-internal-token'] = internalToken;

  // Optional Cloudflare Zero Trust service auth
  const cid = process.env.CF_ACCESS_CLIENT_ID;
  const csec = process.env.CF_ACCESS_CLIENT_SECRET;
  const svc = process.env.CF_ACCESS_SERVICE_TOKEN;
  if (cid && csec) {
    headers['CF-Access-Client-Id'] = cid;
    headers['CF-Access-Client-Secret'] = csec;
  } else if (svc) {
    headers['Authorization'] = `Bearer ${svc}`;
  }

  return headers;
}

// ---------------- tiny store helpers ----------------


// Collect EC-PDA swap nonces from execute-swap results (diag.attempts[].swapNonce)
function collectSwapNonces(execResults: any[]): (string | number)[] {
  const out: (string | number)[] = [];
  for (const r of execResults || []) {
    try {
      const d = (r && (r.diag || r.result?.diag)) || null;
      const atts: any[] = (d && Array.isArray(d.attempts)) ? d.attempts : [];
      for (const a of atts) {
        const idx = String(a?.idx || a?.plan || '').toLowerCase();
        if (idx.includes('ec_pda') || idx.includes('ec-pda')) {
          const nRaw = (a as any)?.swapNonce;
          if (nRaw != null) {
            const nStr = typeof nRaw === 'string' ? nRaw.trim() : String(nRaw);
            if (nStr) out.push(nStr);
          }
        }
      }
    } catch {}
  }
  // de-duplicate
  const seen = new Set<string>();
  const uniq: (string | number)[] = [];
  for (const x of out) {
    const key = String(x);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(x);
  }
  return uniq;
}
const KEY = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_LEGACY = (setId: string) => `REBAL_SET:${setId}`;

async function loadDoc(setId: string): Promise<any | null> {
  const keys = [KEY(setId), KEY_LEGACY(setId)];
  for (const key of keys) {
    try {
      const j = await (redis as any).json?.get?.(key);
      if (j && typeof j === 'object') return j;
    } catch {}
    try {
      const s = await redis.get<string>(key as any);
      if (typeof s === 'string' && s.trim().startsWith('{')) {
        try { return JSON.parse(s); } catch {}
      }
    } catch {}
    try {
      const h = await redis.hgetall<Record<string, any>>(key as any);
      if (h && Object.keys(h).length) return h;
    } catch {}
  }
  return null;
}

async function savePatch(setId: string, patch: Record<string, any>): Promise<any> {
  const cur = (await loadDoc(setId)) || {};
  const next = { ...cur, ...patch };
  let ok = false;
  try { await (redis as any).json?.set?.(KEY(setId), '$', next); ok = true; } catch {}
  if (!ok) { try { await (redis as any).set(KEY(setId), JSON.stringify(next)); ok = true; } catch {} }
  if (!ok) { try { await redis.hset(KEY(setId), next as any); ok = true; } catch {} }
  if (!ok) throw new Error('persist_failed');
  return next;
}

// ---------------- rpc / price helpers ----------------
function rpcUrl(): string {
  const env = (process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || process.env.SOLANA_RPC_URL || '').trim();
  return env || 'https://api.mainnet-beta.solana.com';
}

async function tokenProgramIdForMint(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  try {
    const info = await conn.getAccountInfo(mint, { commitment: 'processed' });
    const owner = info?.owner;
    if (owner && owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  } catch {}
  return TOKEN_PROGRAM_ID;
}

const WSOL = 'So11111111111111111111111111111111111111112' as const;

const STABLES = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

type DexPair = {
  priceUsd?: number;        // USD per BASE
  price?: number;           // QUOTE per BASE
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  chainId?: string;
  pairAddress?: string;
  url?: string;
};

function isStableSymbol(sym?: string | null): boolean {
  if (!sym) return false;
  const u = String(sym).toUpperCase();
  return u === 'USDC' || u === 'USDT' || u === 'USD';
}

async function fetchDexPairsForMints(mints: string[]): Promise<Record<string, DexPair[]>> {
  const out: Record<string, DexPair[]> = {};
  const CHUNK = 30;
  for (let i = 0; i < mints.length; i += CHUNK) {
    const chunk = mints.slice(i, i + CHUNK);
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(chunk.join(','))}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) continue;
    const j = await r.json().catch(() => ({} as any));
    const pairs: DexPair[] = Array.isArray(j?.pairs) ? j.pairs : [];
    for (const p of pairs) {
      if (p?.chainId !== 'solana') continue;
      const base = p?.baseToken?.address;
      const quote = p?.quoteToken?.address;
      if (base) (out[base] ||= []).push(p);
      if (quote) (out[quote] ||= []).push(p);
    }
  }
  return out;
}

type DexMeta = { priceUsd?: number; symbol?: string; liquidityUsd?: number; pairId?: string };
function chooseDexMetaForMint(mint: string, pairs: DexPair[]): DexMeta | null {
  if (!pairs || !pairs.length) return null;
  type Scored = { liq: number; stableQuoted: number; priceUsd?: number; symbol?: string; pairId?: string };
  const scored: Scored[] = [];
  for (const p of pairs) {
    const liq = Number(p?.liquidity?.usd ?? 0) || 0;
    const baseAddr  = p?.baseToken?.address;
    const baseSym   = p?.baseToken?.symbol;
    const quoteAddr = p?.quoteToken?.address;
    const quoteSym  = p?.quoteToken?.symbol;
    const priceUsdBase = Number(p?.priceUsd ?? 0) || undefined;
    const quotePerBase = Number(p?.price ?? 0) || undefined;
    const stableQuoted = (isStableSymbol(quoteSym) ||
      quoteAddr === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ||
      quoteAddr === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') ? 1 : 0;
    if (baseAddr === mint && priceUsdBase) {
      scored.push({ liq, stableQuoted, priceUsd: priceUsdBase, symbol: baseSym, pairId: p?.pairAddress || p?.url });
    } else if (quoteAddr === mint && priceUsdBase && quotePerBase && quotePerBase > 0) {
      const usdPerQuote = priceUsdBase / quotePerBase;
      scored.push({ liq, stableQuoted, priceUsd: usdPerQuote, symbol: quoteSym, pairId: p?.pairAddress || p?.url });
    } else {
      if (baseAddr === mint) scored.push({ liq, stableQuoted, symbol: baseSym, pairId: p?.pairAddress || p?.url });
      if (quoteAddr === mint) scored.push({ liq, stableQuoted, symbol: quoteSym, pairId: p?.pairAddress || p?.url });
    }
  }
  if (!scored.length) return null;
  scored.sort((a,b) => {
    if ((b.stableQuoted||0) !== (a.stableQuoted||0)) return (b.stableQuoted||0) - (a.stableQuoted||0);
    return (b.liq||0) - (a.liq||0);
  });
  const best = scored[0];
  return {
    priceUsd: Number.isFinite(best.priceUsd as any) ? (best.priceUsd as number) : undefined,
    symbol: (best.symbol || '').toString(),
    liquidityUsd: best.liq,
    pairId: best.pairId,
  };
}

async function getDexPricesAndSymbols(mints: string[]): Promise<{ prices: Record<string, number>, symbols: Record<string, string> }> {
  const prices: Record<string, number> = {};
  const symbols: Record<string, string> = {};
  const allPairs = await fetchDexPairsForMints(mints);
  for (const m of mints) {
    const meta = chooseDexMetaForMint(m, allPairs[m] || []);
    if (!meta) continue;
    if (Number.isFinite(meta.priceUsd as any)) prices[m] = meta.priceUsd as number;
    if (meta.symbol) symbols[m] = meta.symbol;
  }
  return { prices, symbols };
}

async function fetchJupV3Prices(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!mints.length) return out;
  const key = (process.env.JUP_API_KEY || process.env.JUP_PRO_API_KEY || '').trim();
  const base = key ? 'https://api.jup.ag/price/v3' : 'https://api.jup.ag/price/v3';
  const chunks: string[][] = [];
  const CHUNK = 50;
  for (let i = 0; i < mints.length; i += CHUNK) chunks.push(mints.slice(i, i + CHUNK));
  for (const c of chunks) {
    const url = `${base}?ids=${encodeURIComponent(c.join(','))}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['x-api-key'] = key;
    try {
      const r = await fetch(url, { headers, cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({} as any));
      for (const id of Object.keys(j || {})) {
        const usd = Number(j[id]?.usdPrice ?? j[id]?.price ?? j[id]);
        if (Number.isFinite(usd) && usd > 0) out[id] = usd;
      }
    } catch {}
  }
  return out;
}

async function getPrices(mints: string[]): Promise<Record<string, number>> {
  const jup = await fetchJupV3Prices(mints);
  const prices: Record<string, number> = { ...jup };
  if (Object.keys(prices).length < 2) {
    const dex = await getDexPricesAndSymbols(mints);
    for (const m of mints) {
      if (prices[m] == null && dex.prices[m] != null) prices[m] = dex.prices[m];
    }
  }
  for (const m of mints) {
    if (prices[m] == null && STABLES.has(m)) prices[m] = 1;
  }
  return prices;
}

// ---------------- planning ----------------
function toNum(n: any, d = 0): number { const v = Number(n); return Number.isFinite(v) ? v : d; }
function safeStr(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  try { return String(v); } catch { return ''; }
}
type PlanLeg = { inMint: string; outMint: string; amountInUi: number; amountInAtoms: bigint; usd: number };

function planGreedySwaps(opts: {
  mints: string[];
  prices: Record<string, number>;
  uiByMint: Record<string, number>;
  decimalsByMint: Record<string, number>;
  toleranceUsd: number;
  minLegUsd: number;
  maxLegs?: number;
}): PlanLeg[] {
  const { mints, prices, uiByMint, decimalsByMint, toleranceUsd, minLegUsd } = opts;
  let maxLegs = Number.isFinite(Number(opts.maxLegs)) ? Number(opts.maxLegs) : Infinity;
  const usable = mints.filter(m => (prices[m] ?? 0) > 0);
  if (usable.length < 2) return [];
  const totalUsd = usable.reduce((sum, m) => sum + toNum(uiByMint[m], 0) * toNum(prices[m], 0), 0);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return [];
  const targetUsd = totalUsd / usable.length;
  type Leg = { mint: string; deltaUsd: number };
  const legs: Leg[] = usable.map((m) => ({
    mint: m,
    deltaUsd: targetUsd - ((uiByMint[m] || 0) * (prices[m] || 0)),
  }));
  const buys  = legs.filter(l => l.deltaUsd >  toleranceUsd).sort((a,b) => b.deltaUsd - a.deltaUsd);
  const sells = legs.filter(l => l.deltaUsd < -toleranceUsd).sort((a,b) => a.deltaUsd - b.deltaUsd);
  const remainingUi: Record<string, number> = Object.fromEntries(usable.map(m => [m, toNum(uiByMint[m], 0)]));
  const out: PlanLeg[] = [];
  let bi = 0, si = 0;
  while (bi < buys.length && si < sells.length && out.length < maxLegs) {
    const buy = buys[bi];
    const sell = sells[si];
    const sellPx = toNum(prices[sell.mint], 0);
    if (!(sellPx > 0)) { si++; continue; }
    const maxUsdToMove = Math.min(buy.deltaUsd, -sell.deltaUsd);
    const dec = Math.max(0, Math.min(12, toNum(decimalsByMint[sell.mint], 9)));
    const factor = Math.pow(10, dec);
    const availUi = Math.max(0, remainingUi[sell.mint] || 0);
    const availAtoms = Math.floor(availUi * factor);
    const desiredAtoms = Math.floor((maxUsdToMove / sellPx) * factor);
    const atomsNum = Math.min(desiredAtoms, availAtoms);
    if (atomsNum <= 0) {
      if (-sell.deltaUsd <= buy.deltaUsd) si++; else bi++;
      continue;
    }
    const inUiActual = atomsNum / factor;
    const usedUsd = inUiActual * sellPx;
    if (usedUsd < minLegUsd) {
      if (-sell.deltaUsd <= buy.deltaUsd) si++; else bi++;
      continue;
    }
    const atoms = BigInt(atomsNum);
    out.push({ inMint: sell.mint, outMint: buy.mint, amountInUi: inUiActual, amountInAtoms: atoms, usd: usedUsd });
    buy.deltaUsd  -= usedUsd;
    sell.deltaUsd += usedUsd;
    remainingUi[sell.mint] = Math.max(0, availUi - inUiActual);
    if (buy.deltaUsd <= toleranceUsd) bi++;
    if (-sell.deltaUsd <= toleranceUsd || remainingUi[sell.mint] <= 0) si++;
  }
  return out;
}

function coalesceByPair(swaps: PlanLeg[]): PlanLeg[] {
  const key = (x: PlanLeg) => `${x.inMint}->${x.outMint}`;
  const map = new Map<string, PlanLeg>();
  for (const s of swaps) {
    const k = key(s);
    const prev = map.get(k);
    if (!prev) map.set(k, { ...s });
    else {
      prev.amountInUi += s.amountInUi;
      prev.amountInAtoms += s.amountInAtoms;
      prev.usd += s.usd;
    }
  }
  return Array.from(map.values());
}

// ---------------- handler ----------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const setId = String(body?.setId || '').trim();
    const walletHeader = String(req.headers.get('x-wallet') || '').trim();
    if (!setId) return NextResponse.json({ ok: false, error: 'missing setId' }, { status: 400 });
    if (!walletHeader) return NextResponse.json({ ok: false, error: 'missing wallet header' }, { status: 400 });

    const internal = isInternal(req);
    let sessionWallet: string | null = null;
    if (!internal) {
      sessionWallet = await getSessionWalletFromRequest(req);
      if (!sessionWallet) {
        return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
    }

    const set = await loadDoc(setId);
    if (!set) return NextResponse.json({ ok: false, error: 'set_not_found' }, { status: 404 });
    const owner = String(set?.wallet || set?.ownerWallet || set?.owner || '').trim();
    if (owner !== walletHeader) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 403 });
    if (!internal && sessionWallet && owner !== sessionWallet) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 403 });
    }




    // Basket as configured
    const mintsArr: string[] = Array.isArray(set?.mints)
      ? (set.mints as unknown[]).map((s: any) => String(s ?? '').trim()).filter((x: string) => !!x)
      : [];
    const mints: string[] = Array.from(new Set<string>(mintsArr as string[]));

    // Ensure wallet→rebalance-set index so wallet-scope Activity can discover this set
    try {
      await (redis as any).sadd(`mm:rebal:wallet:${owner}:sets`, setId);
      try { await (redis as any).sadd(`WALLET_REBAL_SETS:${owner}`, setId); } catch {}
    } catch {}

    const programIdStr = (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID || '').trim();
    if (!programIdStr) return NextResponse.json({ ok: false, error: 'missing_program_id' }, { status: 500 });
    const programId = new PublicKey(programIdStr);

    // RPC (needed early so we can validate that the vault account is actually initialized on-chain)
    const conn = new Connection(rpcUrl(), { commitment: 'processed' });

    // Vault resolution:
    // Some legacy docs can contain both `vault` and `vaultId`, where `vault` may be stale/incorrect.
    // This basket is failing with AnchorError AccountNotInitialized (3012) when we pass a non-vault pubkey
    // into EC-PDA post-swap cleanup. Prefer the canonical `vaultId`, and fall back only if the candidate
    // exists, is owned by the program, and has non-empty data.
    const vaultCandidates = Array.from(
      new Set(
        [
          String(set?.vaultId || '').trim(),
          String(set?.vaultAddress || '').trim(),
          String(set?.vault || '').trim(),
        ].filter(Boolean)
      )
    );

    async function pickInitializedVault(cands: string[]): Promise<string | null> {
      for (const c of cands) {
        try {
          const pk = new PublicKey(c);
          const info = await conn.getAccountInfo(pk, { commitment: 'processed' });
          // Must exist, be owned by the vault program, and have enough data to carry an Anchor discriminator.
          if (!info) continue;
          if (!info.owner?.equals?.(programId)) continue;
          if (!info.data || (info.data as any).length < 8) continue;
          return pk.toBase58();
        } catch {
          continue;
        }
      }
      return null;
    }

    const vault = (await pickInitializedVault(vaultCandidates)) || (vaultCandidates[0] || '');
    if (!vault) return NextResponse.json({ ok: false, error: 'missing_vault' }, { status: 400 });

    const vaultPk = new PublicKey(vault);
    const [authorityPda] = deriveVaultAuthorityPda(programId, vaultPk);

    // ensure ATAs exist for authority (idempotent)
    try { await ensureVaultAtasForMints({ wallet: owner, vault, mints }); } catch {} 


    // decimals (from chain)
    const decimalsByMint: Record<string, number> = {};
    for (const m of mints) {
      try {
        const mintPk = new PublicKey(m);
        const progId = await tokenProgramIdForMint(conn, mintPk);
        const info = await getMint(conn, mintPk, undefined, progId);
        decimalsByMint[m] = Number(info.decimals ?? 9);
      } catch { decimalsByMint[m] = 9; }
    }

    // balances
    const uiByMint: Record<string, number> = {};
    for (const m of mints) {
      try {
        const mintPk = new PublicKey(m);
        const progId = await tokenProgramIdForMint(conn, mintPk);
        const ata = getAssociatedTokenAddressSync(mintPk, authorityPda, true, progId);
        const bal = await conn.getTokenAccountBalance(ata).catch(() => null as any);
        const uiStr = (bal?.value?.uiAmountString ?? '').toString();
        const uiNum = uiStr ? Number(uiStr) : Number(bal?.value?.uiAmount ?? 0);
        const ui = Number.isFinite(uiNum) ? uiNum : 0;
        uiByMint[m] = ui;
      } catch { uiByMint[m] = 0; }
    }

    // prices (Jupiter Pro/Lite → Dex → $1 stables)
    const prices = await getPrices(mints);
    if (prices[WSOL] == null) {
      try {
        const { prices: extra } = await getDexPricesAndSymbols([WSOL]);
        if (extra[WSOL] != null) prices[WSOL] = extra[WSOL];
      } catch {}
    }

    // Stable run id across all legs & finalize
    const runId = `${String(setId).slice(0,6)}-${Date.now().toString(36)}-${String(owner||'').slice(0,6)}-${Math.random().toString(36).slice(2,8)}`;

    // PLAN + EXEC: PASS 1
    let swaps = planGreedySwaps({
      mints, prices, uiByMint, decimalsByMint,
      toleranceUsd: 5,
      minLegUsd: 5,
    });
    swaps = coalesceByPair(swaps);

    const hasWsolInBasket = mints.includes(WSOL);

    function isTxTooLargeFailure(obj: any): boolean {
      try {
        const s = [
          obj?.reason,
          obj?.error,
          obj?.message,
          obj?.detail,
          obj?.code,
          (obj?.diag ? JSON.stringify(obj.diag) : null),
        ]
          .filter(Boolean)
          .map((x: any) => String(x))
          .join(" | ")
          .toLowerCase();
        if (!s) return false;
        return (
          s.includes("tx_too_large") ||
          s.includes("encoding overruns uint8array") ||
          s.includes("transaction too large") ||
          s.includes("rangeerror") && s.includes("uint8array")
        );
      } catch {
        return false;
      }
    }

    
    // ---- fetch helpers (avoid hanging requests + improve resiliency) ----
    async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number; json: any }> {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), Math.max(1_000, timeoutMs));
      try {
        const res = await fetch(url, { ...init, signal: ac.signal });
        const j = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, json: j };
      } catch (e: any) {
        return { ok: false, status: 0, json: { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) } };
      } finally {
        clearTimeout(t);
      }
    }

    function looksTransientSwapFailure(obj: any): boolean {
      const status = Number(obj?.status || obj?.http || 0);
      const msg = String(obj?.error || obj?.reason || obj?.message || '').toLowerCase();
      // network / rpc / blockhash / congestion / slippage that often resolves on retry
      if (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
      if (!status && (msg.includes('timeout') || msg.includes('fetch failed') || msg.includes('network') || msg.includes('econnreset'))) return true;
      if (msg.includes('blockhash not found') || msg.includes('blockhash')) return true;
      if (msg.includes('transaction was not confirmed') || msg.includes('transaction expired') || msg.includes('expired')) return true;
      if (msg.includes('node is behind') || msg.includes('slots behind')) return true;
      if (msg.includes('too many requests') || msg.includes('rate limit')) return true;
      if (msg.includes('slippage')) return true;
      return false;
    }

    async function execSwapLegOnce(params: {
      inMint: string;
      outMint: string;
      amountInAtoms: string;
      clientRef: string;
    }): Promise<any> {
      const { inMint, outMint, amountInAtoms, clientRef } = params;

      const url = buildInternalUrl(req, '/api/rebalance/execute-swap');
      const init: RequestInit = {
        method: 'POST',
        headers: buildInternalHeaders(req, walletHeader),
        body: JSON.stringify({
          setId,
          ownerWallet: owner,
          inMint,
          outMint,
          amountIn: amountInAtoms,
          vault,
          vaultAuthority: authorityPda.toBase58(),
          programId: programIdStr,
          wrapAndUnwrapSol: true,
          preferNativeSolInput: true,
          clientRef,
          setKind: 'rebalance',
          runId,
        }),
        cache: 'no-store',
      };

      const { ok, status, json } = await fetchJsonWithTimeout(url, init, 25_000);
      return { ok: !!(ok && json?.ok), status, ...json, inputMint: inMint, outputMint: outMint };
    }

    async function execSwapLeg(params: {
      inMint: string;
      outMint: string;
      amountInAtoms: string;
      clientRef: string;
    }): Promise<any> {
      // IMPORTANT: keep swaps sequential (shared vault authority accounts).
      // Concurrency tends to increase account-lock contention and partial failures.
      const maxAttempts = 3;
      const backoffs = [650, 1_750, 3_500];

      let last: any = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const j = await execSwapLegOnce({
          ...params,
          clientRef: `${params.clientRef}:a${attempt}`,
        });

        last = j;
        if (j?.ok) return j;

        // If the failure is "tx too large", the caller may decide to hub via SOL; don't hide it here.
        if (isTxTooLargeFailure(j)) return j;

        if (!looksTransientSwapFailure(j)) return j;

        if (attempt < maxAttempts) {
          const ms = backoffs[Math.min(backoffs.length - 1, attempt - 1)];
          try { await new Promise(r => setTimeout(r, ms)); } catch {}
        }
      }
      return last ?? { ok: false, error: 'swap_failed' };
    }

    async function maybeHubViaSol(opts: {
      originalInMint: string;
      originalOutMint: string;
      originalAmountInAtoms: string;
      clientRefBase: string;
    }): Promise<any[]> {
      const { originalInMint, originalOutMint, originalAmountInAtoms, clientRefBase } = opts;
      // Only attempt hub if SOL is part of the basket and neither side is SOL already.
      if (!hasWsolInBasket) return [];
      if (originalInMint === WSOL || originalOutMint === WSOL) return [];
      // First hop: in -> SOL
      const hop1 = await execSwapLeg({
        inMint: originalInMint,
        outMint: WSOL,
        amountInAtoms: originalAmountInAtoms,
        clientRef: `${clientRefBase}:via-sol-1`,
      });
      const outAtoms = safeStr(hop1?.outAmountAtoms ?? hop1?.amountOutAtoms ?? hop1?.amountOut ?? '').trim();
      if (!hop1?.ok || !outAtoms) {
        return [hop1];
      }
      // Second hop: SOL -> out (using the actual SOL output as input)
      const hop2 = await execSwapLeg({
        inMint: WSOL,
        outMint: originalOutMint,
        amountInAtoms: outAtoms,
        clientRef: `${clientRefBase}:via-sol-2`,
      });
      return [hop1, hop2];
    }

    const execResults: any[] = [];
    for (const leg of swaps) {
      try {
        const j = await execSwapLeg({
          inMint: leg.inMint,
          outMint: leg.outMint,
          amountInAtoms: leg.amountInAtoms.toString(),
          clientRef: 'rebalance-now:pass1',
        });
        if (!j.ok && isTxTooLargeFailure(j)) {
          const hops = await maybeHubViaSol({
            originalInMint: leg.inMint,
            originalOutMint: leg.outMint,
            originalAmountInAtoms: leg.amountInAtoms.toString(),
            clientRefBase: 'rebalance-now:pass1',
          });
          if (hops.length) {
            execResults.push(...hops);
            continue;
          }
        }
        execResults.push(j);
      } catch (e: any) {
        execResults.push({ ok: false, error: e?.message || String(e), inputMint: leg.inMint, outputMint: leg.outMint });
      }
    }

    if (execResults.length) { try { await new Promise(r => setTimeout(r, 1200)); } catch {} }

    // PASS 2: cleanup > $5
    const uiByMint2: Record<string, number> = {};
    for (const m of mints) {
      try {
        const mintPk = new PublicKey(m);
        const progId = await tokenProgramIdForMint(conn, mintPk);
        const ata = getAssociatedTokenAddressSync(mintPk, authorityPda, true, progId);
        const bal = await conn.getTokenAccountBalance(ata).catch(() => null as any);
        const uiStr = (bal?.value?.uiAmountString ?? '').toString();
        const uiNum = uiStr ? Number(uiStr) : Number(bal?.value?.uiAmount ?? 0);
        const ui = Number.isFinite(uiNum) ? uiNum : uiByMint[m];
        uiByMint2[m] = ui;
      } catch { uiByMint2[m] = uiByMint[m]; }
    }
    let swaps2 = planGreedySwaps({
      mints, prices, uiByMint: uiByMint2, decimalsByMint,
      toleranceUsd: 5,
      minLegUsd: 5,
    });
    swaps2 = coalesceByPair(swaps2);
    for (const leg of swaps2) {
      try {
        const j = await execSwapLeg({
          inMint: leg.inMint,
          outMint: leg.outMint,
          amountInAtoms: leg.amountInAtoms.toString(),
          clientRef: 'rebalance-now:pass2',
        });
        if (!j.ok && isTxTooLargeFailure(j)) {
          const hops = await maybeHubViaSol({
            originalInMint: leg.inMint,
            originalOutMint: leg.outMint,
            originalAmountInAtoms: leg.amountInAtoms.toString(),
            clientRefBase: 'rebalance-now:pass2',
          });
          if (hops.length) {
            execResults.push(...hops);
            continue;
          }
        }
        execResults.push(j);
      } catch (e: any) {
        execResults.push({ ok: false, error: e?.message || String(e), inputMint: leg.inMint, outputMint: leg.outMint });
      }
    }

    // PASS 3: micro-cleanup ($1–$4.99) if buys remain but no big sells
    const computeDeltas = (ui: Record<string, number>) => {
      const usable = mints.filter(m => (prices[m] ?? 0) > 0);
      const totalUsd = usable.reduce((sum, m) => sum + toNum(ui[m], 0) * toNum(prices[m], 0), 0);
      const target = totalUsd / Math.max(1, usable.length);
      return usable.map((m) => ({ mint: m, deltaUsd: target - (toNum(ui[m], 0) * toNum(prices[m], 0)) }));
    };
    const deltas2 = computeDeltas(uiByMint2);
    const stillBuys = deltas2.filter(d => d.deltaUsd > 5);
    const bigSells = deltas2.filter(d => d.deltaUsd < -5);
    if (stillBuys.length && bigSells.length === 0) {
      const uiByMint3 = { ...uiByMint2 };
      let swaps3 = planGreedySwaps({
        mints, prices, uiByMint: uiByMint3, decimalsByMint,
        toleranceUsd: 1,
        minLegUsd: 5,
        maxLegs: Math.max(2, mints.length - 1),
      });
      swaps3 = coalesceByPair(swaps3);
      for (const leg of swaps3) {
        try {
          const j = await execSwapLeg({
            inMint: leg.inMint,
            outMint: leg.outMint,
            amountInAtoms: leg.amountInAtoms.toString(),
            clientRef: 'rebalance-now:pass3',
          });
          if (!j.ok && isTxTooLargeFailure(j)) {
            const hops = await maybeHubViaSol({
              originalInMint: leg.inMint,
              originalOutMint: leg.outMint,
              originalAmountInAtoms: leg.amountInAtoms.toString(),
              clientRefBase: 'rebalance-now:pass3',
            });
            if (hops.length) {
              execResults.push(...hops);
              continue;
            }
          }
          execResults.push(j);
        } catch (e: any) {
          execResults.push({ ok: false, error: e?.message || String(e), inputMint: leg.inMint, outputMint: leg.outMint });
        }
      }
    }

    
    // ---- post-check + scheduling ----
    // We used to always advance the cadence even if some legs failed. That causes "3/4 tokens rebalanced"
    // to persist until the user manually triggers another run. Instead, we detect residual imbalance and
    // schedule a quick retry (bounded) so cron can complete the basket without user intervention.

    const uiByMintFinal: Record<string, number> = {};
    for (const m of mints) {
      try {
        const mintPk = new PublicKey(m);
        const progId = await tokenProgramIdForMint(conn, mintPk);
        const ata = getAssociatedTokenAddressSync(mintPk, authorityPda, true, progId);
        const bal = await conn.getTokenAccountBalance(ata).catch(() => null as any);
        const uiStr = (bal?.value?.uiAmountString ?? '').toString();
        const uiNum = uiStr ? Number(uiStr) : Number(bal?.value?.uiAmount ?? 0);
        const ui = Number.isFinite(uiNum) ? uiNum : 0;
        uiByMintFinal[m] = ui;
      } catch {
        uiByMintFinal[m] = 0;
      }
    }

    const finalDeltas = (() => {
      const usable = mints.filter(m => (prices[m] ?? 0) > 0);
      const totalUsd = usable.reduce((sum, m) => sum + toNum(uiByMintFinal[m], 0) * toNum(prices[m], 0), 0);
      const target = totalUsd / Math.max(1, usable.length);
      return usable.map((m) => ({
        mint: m,
        deltaUsd: target - (toNum(uiByMintFinal[m], 0) * toNum(prices[m], 0)),
      }));
    })();

    const residualMaxAbsUsd = finalDeltas.reduce((mx, d) => Math.max(mx, Math.abs(toNum(d.deltaUsd, 0))), 0);
    const hasHardFailures = (execResults || []).some((x: any) => x && x.ok === false);

    const needsRetry = (residualMaxAbsUsd > 6) || hasHardFailures;

    const cadence = (set?.cadence || set?.frequency || set?.freq || set?.freqHours || '6h') as string;
    const msMap: Record<string, number> = { '1h': 3600000, '2h': 7200000, '6h': 21600000, '12h': 43200000, '24h': 86400000 };

    let nextAt = Date.now() + (msMap[cadence] || 21600000);

    const retryKey = `mm:rebal:retry:${setId}`;
    if (needsRetry) {
      let n = 0;
      try {
        n = await redis.incr(retryKey);
        // keep counter for 45 minutes, enough for a few cron ticks
        try { await redis.expire(retryKey, 45 * 60); } catch {}
      } catch {}

      // Quick retry for the first couple of attempts; after that, fall back to cadence to avoid hot-looping.
      if (n <= 2) {
        nextAt = Date.now() + 2 * 60_000; // 2 minutes
      }
    } else {
      // Reset retry counter on success
      try { await redis.del(retryKey); } catch {}
    }

    try {
      await savePatch(setId, {
        id: setId,
        wallet: owner,
        type: 'rebalance',
        nextRebalanceAt: nextAt,
        updatedAt: new Date().toISOString(),
        // additive diagnostics
        lastRunId: runId,
        lastResidualMaxAbsUsd: residualMaxAbsUsd,
        lastNeedsRetry: needsRetry,
      });
    } catch {}

    // Collect signatures and expected legs
    const signatures = Array.from(new Set((execResults||[])
      .map((x:any)=> String(x?.signature||x?.sig||x?.tx||'').trim())
      .filter(Boolean)));
    const expectedLegs = (execResults || []).length;
    const swapNonces = collectSwapNonces(execResults);


    // Best-effort append (diagnostic) – downstream keeps using finalize's single aggregated row
    try {
      await fetch(buildInternalUrl(req, '/api/events/append'), {
        method: 'POST',
        headers: buildInternalHeaders(req, walletHeader),
        body: JSON.stringify({
          type: 'rebalance_execute',
          setId,
          wallet: owner,
          vault,
          swaps: execResults,
          runId,
          signatures,
          expectedLegs,
        }),
        cache: 'no-store',
      });
    } catch {}

    // Finalize: aggregate & freeze equity snapshot (idempotent)
    try {
      await fetch(buildInternalUrl(req, '/api/rebalance/finalize'), {
        method: 'POST',
        headers: buildInternalHeaders(req, walletHeader),
        body: JSON.stringify({
          setId,
          wallet: owner,
          vault,
          ts: Date.now(),
          runId,
          signatures,
          expectedLegs,
          swapNonces,
        }),
        cache: 'no-store',
      });
    } catch {}

    return NextResponse.json({ ok: true, swaps: execResults, nextRebalanceAt: nextAt, runId, expectedLegs, signatures, needsRetry, residualMaxAbsUsd });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
