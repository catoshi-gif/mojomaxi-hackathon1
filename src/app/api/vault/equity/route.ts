import 'server-only';
import { redis as _redis } from "@/lib/redis";
import { NextResponse, NextRequest } from 'next/server';
import { PublicKey, Connection, clusterApiUrl } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { deriveVaultAuthorityPda, deriveVaultPda } from '@/lib/program.server';
import { getSetById } from '@/lib/store';
import { getSet as getRebalanceSet } from '@/lib/rebalance-store';
import { cacheKey, cacheGetJSON, cacheSetJSON, singleflight } from '@/lib/cache.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MEMO_TTL_MS = 60_000;
const _memoSet = new Map<string, { ts: number; doc: any }>();
const _memoVaultId = new Map<string, { ts: number; vault: string | null }>();

type PriceMap = Record<string, number>;
type ByMintEntry = { ui: number; price: number; usd: number };
type EquityPayload = {
  ok: boolean;
  setId?: string | null;
  wallet?: string | null;
  vault?: string | null;         // vault PDA
  authority?: string | null;     // vault authority PDA (owner of ATAs)
  mints?: string[];            // mints present in the vault
  totalUsd: number;
  equityUsd: number;
  startingTotalUsd?: number | null;
  pnlUsd?: number | null;
  pnlPct?: number | null;
  byMint: Record<string, ByMintEntry>;
  ts: number;
  diag?: any;
};

function cfOrigin(req: NextRequest): string {
  const { origin } = new URL(req.url);
  return origin.replace(/\/+$/, '');
}

function buildInternalHeaders(req: NextRequest, diag?: any, extra?: HeadersInit): HeadersInit {
  const h: Record<string,string> = { 'x-mm-internal': '1', 'accept': 'application/json' };

  // Forward browser context (helps some CF rules & logs)
  const cookie = req.headers.get('cookie'); if (cookie) h['cookie'] = cookie;
  const ua = req.headers.get('user-agent'); if (ua) h['user-agent'] = ua;
  const al = req.headers.get('accept-language'); if (al) h['accept-language'] = al;

  // Optional: shared secret header for Cloudflare WAF bypass on specific paths
  const shared = process.env.X_MM_INTERNAL_TOKEN || process.env.INTERNAL_FETCH_TOKEN;
  if (shared) {
    h['x-mm-internal-token'] = shared;
    if (diag) diag.steps?.push('cfwaf:token');
  } else {
    if (diag) diag.steps?.push('cfwaf:none');
  }

  // Optional: CF Access service auth (if you later enable Zero Trust)
  const cid = process.env.CF_ACCESS_CLIENT_ID;
  const csec = process.env.CF_ACCESS_CLIENT_SECRET;
  const svc = process.env.CF_ACCESS_SERVICE_TOKEN;
  if (cid && csec) { h['CF-Access-Client-Id'] = cid; h['CF-Access-Client-Secret'] = csec; diag?.steps?.push('cfaccess:client'); }
  else if (svc) { h['Authorization'] = `Bearer ${svc}`; diag?.steps?.push('cfaccess:svc'); }

  return { ...h, ...(extra || {}) };
}

function uuidTo16BytesHex(u: string): Uint8Array | null {
  try {
    const hex = u.replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) return null;
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  } catch { return null; }
}

async function fetchSetDoc(req: NextRequest, setId: string, diag: any): Promise<any | null> {
  const now = Date.now();
  const memo = _memoSet.get(setId);
  if (memo && now - memo.ts < MEMO_TTL_MS) {
    diag.steps.push('setDoc:memo:hit');
    return memo.doc;
  }

  // Prefer canonical webhook sets (lib/store)
  try {
    const s = await getSetById(setId).catch(() => null);
    if (s) {
      const doc: any = s;
      _memoSet.set(setId, { ts: now, doc });
      diag.steps.push('setDoc:store:webhooks');
      return doc;
    }
  } catch (e: any) {
    diag.steps.push(`setDoc:store:error:${String(e?.message || e)}`);
  }

  // Fallback: rebalance sets (lib/rebalance-store)
  try {
    const r = await getRebalanceSet(setId).catch(() => null);
    if (r) {
      const doc: any = { ...r, kind: 'rebalance' };
      _memoSet.set(setId, { ts: now, doc });
      diag.steps.push('setDoc:store:rebalance');
      return doc;
    }
  } catch (e: any) {
    diag.steps.push(`setDoc:rebalance:error:${String(e?.message || e)}`);
  }

  // As a last resort, try legacy composite docs (best-effort, no internal HTTP hop)
  try {
    const doc = await _redis.get<any>(`mm:set:${setId}:doc`).catch(() => null);
    if (doc && typeof doc === 'object') {
      _memoSet.set(setId, { ts: now, doc });
      diag.steps.push('setDoc:redis:mm:set:doc');
      return doc;
    }
  } catch (e: any) {
    diag.steps.push(`setDoc:redis:error:${String(e?.message || e)}`);
  }

  diag.steps.push('setDoc:miss');
  return null;
}

async function fetchVaultIdByIndex(req: NextRequest, setId: string, diag: any): Promise<string | null> {
  const now = Date.now();
  const memo = _memoVaultId.get(setId);
  if (memo && now - memo.ts < MEMO_TTL_MS) {
    diag.steps.push('vaultIndex:memo:hit');
    return memo.vault;
  }

  const candidates = [
    `mm:set:${setId}:vault`,
    `mm:vault:${setId}`,
    `mm:vaultid:${setId}`,
  ];

  for (const key of candidates) {
    try {
      const v: any = await _redis.get(key);
      if (typeof v === 'string' && v.length >= 32) {
        _memoVaultId.set(setId, { ts: now, vault: v });
        diag.steps.push(`vaultIndex:redis:${key}`);
        return v;
      }
      if (v && typeof v === 'object') {
        const vv = (v as any).vault || (v as any).value || null;
        if (typeof vv === 'string' && vv.length >= 32) {
          _memoVaultId.set(setId, { ts: now, vault: vv });
          diag.steps.push(`vaultIndex:redisObj:${key}`);
          return vv;
        }
      }
    } catch (e: any) {
      diag.steps.push(`vaultIndex:redisErr:${key}:${String(e?.message || e)}`);
    }
  }

  _memoVaultId.set(setId, { ts: now, vault: null });
  diag.steps.push('vaultIndex:miss');
  return null;
}

async function fetchPrices(req: NextRequest, mints: string[], diag: any): Promise<PriceMap> {
  const uniq = Array.from(new Set((mints || []).map((x) => String(x || '').trim()).filter(Boolean)));
  if (!uniq.length) return {};
  const origin = cfOrigin(req);
  const url = `${origin}/api/prices?mints=${encodeURIComponent(uniq.join(','))}`;

  // 1) Try same-origin HTTP (keeps caching semantics + centralizes vendor logic)
  try {
    const r = await fetch(url, { cache: 'no-store', headers: buildInternalHeaders(req, diag) });
    diag.steps.push(`prices:http:${r.status}`);
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const data: any = j?.data || j?.prices || {};
      const out: PriceMap = {};
      for (const [k, v] of Object.entries<any>(data)) {
        const n = Number(v?.price ?? v);
        if (Number.isFinite(n) && n > 0) out[k] = n;
      }
      if (Object.keys(out).length) return out;
      diag.steps.push('prices:http:empty');
    }
  } catch (e: any) {
    diag.steps.push(`prices:http:error:${String(e?.message || e)}`);
  }

  // 2) Fallback: call internal price library directly (Cron/WAF safe)
  try {
    // Import lazily to keep the module side effects minimal under edge runtimes.
    const { pricesByMint } = await import('@/lib/price-lite');
    const pm = await pricesByMint(uniq);
    const out: PriceMap = {};
    for (const [k, v] of Object.entries<any>(pm || {})) {
      const n = Number(typeof v === 'number' ? v : v?.price);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    if (Object.keys(out).length) {
      diag.steps.push('prices:lib:ok');
      return out;
    }
    diag.steps.push('prices:lib:empty');
  } catch (e: any) {
    diag.steps.push(`prices:lib:error:${String(e?.message || e)}`);
  }

  return {};
}

function addParsedTo(byMintUi: Record<string, { ui: number }>, arr: any[]) {
  for (const it of arr || []) {
    try {
      const parsed = (it?.account?.data as any)?.parsed?.info;
      const mint = String(parsed?.mint || '').trim();
      const ui = Number(parsed?.tokenAmount?.uiAmount ?? 0);
      if (!mint || !(ui > 0)) continue;
      byMintUi[mint] = byMintUi[mint] || { ui: 0 };
      byMintUi[mint].ui += ui;
    } catch {}
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const setId = url.searchParams.get('setId') || url.searchParams.get('set_id') || null;
  let vaultStr = url.searchParams.get('vault') || url.searchParams.get('vaultAddress') || null;
  let walletStr: string | null = url.searchParams.get('wallet') || null;

  // Optional: allow caller to request RPC commitment level (processed|confirmed|finalized)
  const commitmentParam = (url.searchParams.get('commitment') || '').toLowerCase();
  const commitment: 'processed' | 'confirmed' | 'finalized' =
    commitmentParam === 'processed' || commitmentParam === 'finalized' ? (commitmentParam as any) : 'confirmed';


  const diag: any = { steps: [] as string[], rpc: null, path: null };
  const stamp = (s: string) => diag.steps.push(s);

  try {
    // Only consult protected set docs if BOTH wallet and vault are missing.
    let setDoc: any = null;
    if (!walletStr && !vaultStr && setId) {
      setDoc = await fetchSetDoc(req, setId, diag).catch(() => null);
      if (setDoc) {
        if (!walletStr) walletStr = setDoc?.wallet || setDoc?.owner || setDoc?.admin || null;
        if (!vaultStr)  vaultStr  = setDoc?.vault  || setDoc?.vaultAddress || (setDoc as any)?.vaultId || null;
      } else {
        const idxVault = await fetchVaultIdByIndex(req, setId, diag);
        if (!vaultStr && idxVault) vaultStr = idxVault;
      }
    } else {
      stamp('discover:skipped(wallet||vault provided)');
    }

    // If we only have (wallet,setId), derive the vault PDA
    let vaultPk: PublicKey | null = null;
    if (vaultStr) {
      try { vaultPk = new PublicKey(vaultStr); stamp('vault:param'); } catch { stamp('vault:param:bad'); }
    }
    if (!vaultPk && walletStr && setId) {
      try {
        const ownerPk = new PublicKey(walletStr);
        const set16 = uuidTo16BytesHex(setId);
        if (!set16) return NextResponse.json({ ok: false, error: 'invalid setId (need uuid)', setId }, { status: 400 });
        const v = deriveVaultPda(ownerPk, set16);
        vaultPk = v;
        vaultStr = v.toBase58();
        stamp('vault:derived');
      } catch (e: any) {
        stamp(`vault:derive:error:${String(e?.message || e)}`);
      }
    }

    if (!vaultPk) {
      return NextResponse.json({ ok: false, error: 'missing/invalid vault (and could not derive from wallet+setId)', wallet: walletStr, setId, diag }, { status: 400 });
    }

    // Derive the *authority* that may own the vault's ATAs
    let authorityPk: PublicKey | null = null;
    try { authorityPk = deriveVaultAuthorityPda(vaultPk); stamp('authority:derived'); } catch { stamp('authority:derive:error'); }
    if (!authorityPk) {
      return NextResponse.json({ ok: false, error: 'failed to derive authority', vault: vaultStr, setId, diag }, { status: 400 });
    }
    const authorityStr = authorityPk.toBase58();

    // Short-lived cache to prevent stampedes under load (balances + prices are expensive).
    // Keyed by vault + commitment (authority is derived from vault).
    const eqKey = cacheKey(`equity:v2:${vaultStr}:${commitment}`);
    const cached = await cacheGetJSON<EquityPayload>(eqKey).catch(() => null);
    if (cached && (cached as any).ok) {
      stamp('cache:hit');
      const out: any = { ...(cached as any), ts: Date.now() };
      try {
        if (out && out.diag && typeof out.diag === 'object') {
          out.diag = { ...out.diag, steps: Array.isArray(out.diag.steps) ? [...out.diag.steps, 'cache:hit'] : ['cache:hit'] };
        } else {
          out.diag = { steps: ['cache:hit'] };
        }
      } catch {}
      return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store, no-cache, max-age=0', 'x-mm-cache': 'hit' } });
    }

    // Singleflight ensures only one compute runs per instance even if many requests arrive at once.
    const payload = await singleflight(eqKey, async () => {


    // --- RPC connection (prefer HELIUS first) ---
    const rpc =
      process.env.HELIUS_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      process.env.SOLANA_MAINNET_RPC ||
      process.env.NEXT_PUBLIC_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      clusterApiUrl('mainnet-beta');
    const connection = new Connection(rpc, commitment);
    diag.rpc = rpc;

    // Read token accounts by BOTH possible owners
    const owners: PublicKey[] = [authorityPk, vaultPk];
    const byMintUi: Record<string, { ui: number }> = {};
    for (const owner of owners) {
      try {
        const [tokKeg, tok22] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
          connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] as any[] })),
        ]);
        addParsedTo(byMintUi, (tokKeg as any)?.value || []);
        addParsedTo(byMintUi, (tok22 as any)?.value || []);
      } catch (e) {
        stamp(`rpc:owner-scan:error`);
      }
    }

    // If nothing on-chain and we had a setDoc, try to synthesize (best-effort)
    if (!Object.keys(byMintUi).length && setDoc && Array.isArray(setDoc.mints)) {
      stamp('fallback:setDoc.mints');
      for (const x of setDoc.mints) {
        try {
          const m = String((x?.mint || x?.address || x) ?? '').trim();
          const ui = Number(x?.ui || x?.uiAmount || 0);
          if (!m) continue;
          byMintUi[m] = { ui: Math.max(0, ui) };
        } catch {}
      }
      if (!Object.keys(byMintUi).length) {
        const a = String(setDoc.mintA || setDoc.mintIn || '').trim();
        const b = String(setDoc.mintB || setDoc.mintOut || '').trim();
        if (a) byMintUi[a] = { ui: byMintUi[a]?.ui || 0 };
        if (b) byMintUi[b] = { ui: byMintUi[b]?.ui || 0 };
      }
    }

    // Price fill via INTERNAL /api/prices
    const mints = Object.keys(byMintUi);
    const prices = await fetchPrices(req, mints, diag);

    const byMint: Record<string, ByMintEntry> = {};
    let equityUsd = 0;
    for (const m of mints) {
      const ui = byMintUi[m].ui;
      const price = Number(prices[m] ?? 0) || 0;
      const usd = ui * price;
      byMint[m] = { ui, price, usd };
      equityUsd += usd;
    }
    const totalUsd = equityUsd;

    const payload: EquityPayload = {
      ok: true,
      setId,
      wallet: walletStr,
      vault: vaultStr,
      authority: authorityStr,
      mints: mints,
      totalUsd,
      equityUsd,
      startingTotalUsd: null,
      pnlUsd: null,
      pnlPct: null,
      byMint,
      ts: Date.now(),
      diag: { ...diag, path: 'owners:authority+vault' },
    };

    try { await cacheSetJSON(eqKey, payload, 10); } catch {}
    return payload;
    });

    return NextResponse.json(payload as any, { headers: { 'Cache-Control': 'no-store, no-cache, max-age=0', 'x-mm-cache': 'miss' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e), setId, vault: vaultStr, ts: Date.now(), diag }, { status: 500 });
  }
}
