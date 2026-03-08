// server-only
// src/lib/pricing/getUsdPrices.server.ts
// Fetch USD prices for a set of mints, preferring the same metadata path used by
// RebalanceInlinePanel (your /api/tokens/meta endpoint), then falling back to
// Jupiter's price API if any mints are missing.

import type { NextRequest } from 'next/server';

export type PriceMap = Record<string, number>;

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function isHttps(reqHeaders: Headers) {
  const proto = reqHeaders.get('x-forwarded-proto');
  return (proto ?? '').includes('https');
}

function getOriginFromHeaders(reqHeaders: Headers) {
  const host = reqHeaders.get('x-forwarded-host') || reqHeaders.get('host') || 'localhost:3000';
  const https = isHttps(reqHeaders);
  return `${https ? 'https' : 'http'}://${host}`;
}

async function fetchInternalMeta(reqHeaders: Headers, mints: string[]): Promise<Record<string, { symbol?: string; price?: number }>> {
  const origin = getOriginFromHeaders(reqHeaders);
  const url = `${origin}/api/tokens/meta?mints=${encodeURIComponent(mints.join(','))}`;
  const res = await fetch(url, { cache: 'no-store', headers: { 'x-mm-internal': '1' } });
  if (!res.ok) throw new Error('meta endpoint failed: ' + res.status);
  const j = await res.json();
  // Try common shapes: {meta: {mint: {symbol, price}}} or { [mint]: {symbol, price} }
  if (j?.meta && typeof j.meta === 'object') return j.meta;
  return j;
}

async function fetchJupiterPrices(mints: string[]): Promise<PriceMap> {
  // Jupiter v6 price API accepts mint ids.
  if (mints.length === 0) return {};
  const url = `https://price.jup.ag/v6/price?ids=${encodeURIComponent(mints.join(','))}`;
  const res = await fetch(url, { next: { revalidate: 10 } });
  if (!res.ok) throw new Error('jupiter price failed: ' + res.status);
  const j = await res.json();
  const out: PriceMap = {};
  const src = j?.data ?? j?.prices ?? {};
  for (const [k, v] of Object.entries<any>(src)) {
    const p = typeof v?.price === 'number' ? v.price : (typeof v === 'number' ? v : undefined);
    if (typeof p === 'number' && Number.isFinite(p)) out[k] = p;
  }
  return out;
}

export async function getUsdPricesServer(reqHeaders: Headers, mintList: string[]): Promise<PriceMap> {
  const mints = uniq(mintList.filter(Boolean));
  if (mints.length === 0) return {};

  let meta: Record<string, { symbol?: string; price?: number }> = {};
  const prices: PriceMap = {};

  // 1) Try internal meta path first (canonical for your app)
  try {
    meta = await fetchInternalMeta(reqHeaders, mints);
    for (const m of mints) {
      const p = meta?.[m]?.price;
      if (typeof p === 'number' && Number.isFinite(p) && p > 0) {
        prices[m] = p;
      }
    }
  } catch (_) {
    // ignore; we'll rely on fallback
  }

  // 2) For any missing/zero prices, hit Jupiter price API
  const missing = mints.filter((m) => !(m in prices) || !(prices[m] > 0));
  if (missing.length) {
    try {
      const jup = await fetchJupiterPrices(missing);
      for (const m of missing) {
        const p = jup[m];
        if (typeof p === 'number' && Number.isFinite(p) && p > 0) prices[m] = p;
      }
    } catch (_) {}
  }

  return prices;
}
