// Destination: src/lib/price-lite.ts
// Randomized replacement artifact: price-lite.ts__repl8a22aa.txt
/**
 * Mojomaxi price helpers (Jupiter API primary (Dex fallback))
 * -----------------------------------------
 * - Prices are per 1.0 UI token (never apply decimals to prices)
 * - No-cache HTTP for freshness
 * - Default source: Jupiter Price V3 (PRO key if present) — NO fallbacks
 * - Back-compat: export `pricesByMint(...)` (numbers-only) used by existing UI
 */

export type PriceSource = 'dexscreener' | 'jupiter';
export type PriceMap = Record<string, { price: number; source: PriceSource }>;

// Native USDC mint (strip whitespace defensively)
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qn1z ybapC8G4wEGGkZwyTDt1v'.replace(/\s+/g, '');

// Endpoints
const JUP_V3 = 'https://api.jup.ag/price/v3';  // GET ?ids=<m1,m2>&vsToken=USDC
const JUP_V6 = 'https://price.jup.ag/v6/price';     // legacy fallback
const DEX    = 'https://api.dexscreener.com/latest/dex/tokens'; // /<mint>
async function fetchJupProBatch(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!mints.length) return out;

  // IMPORTANT: Match the same Jupiter Price V3 parsing used by /api/prices routes.
  // - Query strictly by mint (ids=...)
  // - Prefer PRO key if present
  // - Parse `usdPrice` (Jupiter's field) with backward-compatible fallbacks
  const base = (process.env.JUPITER_PRO_BASE || "https://api.jup.ag").replace(/\/$/, "");
  const key = (process.env.JUP_API_KEY || process.env.JUP_PRO_API_KEY || "").trim();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-api-key"] = key;

  const u = new URL(base + "/price/v3");
  u.searchParams.set("ids", mints.join(","));

  try {
    const r = await fetch(u.toString(), { cache: "no-store", headers, next: { revalidate: 0 } });
    if (!r.ok) return out;

    // Jupiter returns a top-level object keyed by mint:
    // { "<mint>": { usdPrice: number, ... }, ... }
    const text = await r.text();
    let j: any = {};
    try { j = JSON.parse(text); } catch { j = {}; }

    const data: any = j?.data || j?.prices || j;
    for (const k of Object.keys(data || {})) {
      const node: any = (data as any)[k];
      const usd = Number(node?.usdPrice ?? node?.usd_price ?? node?.price ?? node?.priceUsd ?? node?.priceUSD ?? node);
      if (Number.isFinite(usd) && usd > 0) out[k] = usd;
    }
  } catch {
    // ignore
  }
  return out;
}

async function fetchDexBatch(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(mints.map(async (mint) => {
    try {
      const r = await fetch(`${DEX}/${encodeURIComponent(mint)}`, { cache: 'no-store', next: { revalidate: 0 } });
      if (!r.ok) return;
      const j = await r.json();
      const v = j?.pairs?.[0]?.priceUsd ?? j?.pairs?.[0]?.priceUSD ?? j?.pairs?.[0]?.price;
      const n = Number(v);
      if (Number.isFinite(n)) out[mint] = n;
    } catch { /* ignore */ }
  }));
  return out;
}

async function fetchJupV3Batch(mints: string[]): Promise<Record<string, number>> {
  if (!mints.length) return {};
  const u = new URL(JUP_V3);
  u.searchParams.set('ids', mints.join(','));
  u.searchParams.set('vsToken', USDC_MINT);
  const out: Record<string, number> = {};
  try {
    const r = await fetch(u.toString(), { cache: 'no-store', next: { revalidate: 0 } });
    if (!r.ok) return out;
    const j = await r.json();
    const data: any = j?.data || j?.priceData || j?.prices || j;
    for (const mint of mints) {
      const rec = data?.[mint] ?? data?.priceMap?.[mint] ?? null;
      const p = (rec && typeof rec === 'object') ? (rec.price ?? rec.priceUsd ?? rec.unitPrice) : rec;
      const n = Number(p);
      if (Number.isFinite(n)) out[mint] = n;
    }
  } catch { /* ignore */ }
  return out;
}

async function fetchJupV6Batch(mints: string[]): Promise<Record<string, number>> {
  if (!mints.length) return {};
  const u = new URL(JUP_V6);
  u.searchParams.set('ids', mints.join(','));
  u.searchParams.set('vsToken', USDC_MINT);
  const out: Record<string, number> = {};
  try {
    const r = await fetch(u.toString(), { cache: 'no-store', next: { revalidate: 0 } });
    if (!r.ok) return out;
    const j = await r.json();
    const data: any = j?.data || {};
    for (const mint of mints) {
      const rec = data?.[mint] ?? null;
      const p = (rec && typeof rec === 'object') ? (rec.price ?? rec.priceUsd) : rec;
      const n = Number(p);
      if (Number.isFinite(n)) out[mint] = n;
    }
  } catch { /* ignore */ }
  return out;
}

/** Dex-first, no-cache prices by mint */
export async function pricesByMintNoCache(mints: string[]): Promise<PriceMap> {
  const uniq = Array.from(new Set(mints.filter(Boolean)));
  if (!uniq.length) return {};

  // NO FALLBACKS: use Jupiter Price V3 only (same pricing backbone as /api/prices used by panels).
  const jpro = await fetchJupProBatch(uniq);

  const out: PriceMap = {};
  for (const mint of uniq) {
    const j = Number(jpro[mint]);
    if (Number.isFinite(j) && j > 0) {
      out[mint] = { price: j, source: "jupiter" };
    }
  }
  return out;
}

/** Golden-compat wrapper (numbers-only) */
export async function pricesByMint(mints: string[]): Promise<Record<string, number>> {
  const pm = await pricesByMintNoCache(mints);
  const out: Record<string, number> = {};
  for (const k of Object.keys(pm)) {
    const v: any = (pm as any)[k];
    const n = typeof v === 'number' ? v : v?.price;
    if (Number.isFinite(Number(n))) out[k] = Number(n);
  }
  return out;
}

/* ---------------- token meta (symbol/name/decimals/logo) ---------------- */
const TOKENS_V2 = 'https://api.jup.ag/tokens/v2/search'; // ?query=<mint or symbol>
const TOKENS_V1 = 'https://tokens.jup.ag/token';              // /<mint>

async function tokenMetaFromJupiterV2(mint: string) {
  try {
    const u = new URL(TOKENS_V2);
    u.searchParams.set('query', mint);
    const r = await fetch(u.toString(), { cache: 'no-store', next: { revalidate: 0 } });
    if (!r.ok) return null;
    const j = await r.json();
    const arr: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.results) ? j.results : Array.isArray(j) ? j : [];
    let hit: any = arr.find((x: any) => (x?.address || x?.mint) === mint);
    if (!hit && arr.length) hit = arr[0];
    if (!hit) return null;
    return {
      symbol: typeof hit.symbol === 'string' ? hit.symbol : undefined,
      name: typeof hit.name === 'string' ? hit.name : undefined,
      decimals: Number.isFinite(hit.decimals) ? Number(hit.decimals) : undefined,
      logoURI: typeof hit.logoURI === 'string' ? hit.logoURI : (typeof hit.logoUrl === 'string' ? hit.logoUrl : undefined),
    };
  } catch { return null; }
}

async function tokenMetaFromJupiterV1(mint: string) {
  try {
    const r = await fetch(`${TOKENS_V1}/${encodeURIComponent(mint)}`, { cache: 'no-store', next: { revalidate: 0 } });
    if (!r.ok) return null;
    const j = await r.json();
    const rec = j?.[mint] || j;
    if (!rec) return null;
    return {
      symbol: typeof rec.symbol === 'string' ? rec.symbol : undefined,
      name: typeof rec.name === 'string' ? rec.name : undefined,
      decimals: Number.isFinite(rec.decimals) ? Number(rec.decimals) : undefined,
      logoURI: typeof rec.logoURI === 'string' ? rec.logoURI : undefined,
    };
  } catch { return null; }
}

async function tokenMetaFromDex(mint: string) {
  try {
    const r = await fetch(`${DEX}/${encodeURIComponent(mint)}`, { cache: 'no-store', next: { revalidate: 0 } });
    if (!r.ok) return null;
    const j = await r.json();
    const arr: any[] = Array.isArray(j?.pairs) ? j.pairs : [];
    let symbol: string | undefined, name: string | undefined;
    for (const p of arr) {
      const base = p?.baseToken, quote = p?.quoteToken;
      if (base?.address === mint) { symbol = base?.symbol || symbol; name = base?.name || name; break; }
      if (quote?.address === mint) { symbol = quote?.symbol || symbol; name = quote?.name || name; break; }
    }
    if (!symbol && !name) return null;
    return { symbol, name, decimals: undefined, logoURI: undefined };
  } catch { return null; }
}

export async function tokenMeta(mint: string): Promise<{ symbol?: string; name?: string; decimals?: number; logoURI?: string } | null> {
  const v2 = await tokenMetaFromJupiterV2(mint);
  if (v2) return v2;
  const v1 = await tokenMetaFromJupiterV1(mint);
  if (v1) return v1;
  const ds = await tokenMetaFromDex(mint);
  if (ds) return ds;
  return null;
}
