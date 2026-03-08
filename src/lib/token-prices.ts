
/* eslint-disable @typescript-eslint/no-explicit-any */
export type PriceMap = Record<string, number>;

const JUP_V3 = "https://api.jup.ag/price/v3?ids="; // may require key (401 in browser)
const JUP_V6 = "https://price.jup.ag/v6/price?ids=";
const JUP_V4 = "https://price.jup.ag/v4/price?ids=";

// If all endpoints fail for stables, hint $1.00 so UI doesn't show "$–" (rare API outage)
// NOTE: If Jupiter returns a price, we use that (covers any de-peg).
const STABLE_PRICE_HINT: Record<string, number> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 1.0, // USDC mint
  "USDC": 1.0,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 1.0, // USDT mint
  "USDT": 1.0,
};

function isServerSide(): boolean {
  return typeof window === "undefined";
}

async function tryFetch(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { cache: "no-store", mode: "cors" as RequestMode });
    if (!r.ok) {
      // Swallow 4xx/5xx and move to next fallback
      return null;
    }
    return await r.json();
  } catch {
    return null;
  }
}

function uniq(arr: string[]) {
  const s = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    const t = (v || "").trim();
    if (!t || s.has(t)) continue;
    s.add(t);
    out.push(t);
  }
  return out;
}

function parsePriceResponse(json: any): PriceMap {
  // Shape: { data: { [id]: { price: number, symbol?: string, mint?: string, id?: string } } }
  const out: PriceMap = {};
  const data = json?.data;
  if (!data || typeof data !== "object") return out;
  for (const [k, v] of Object.entries<any>(data)) {
    const p = v?.price;
    if (typeof p === "number" && Number.isFinite(p)) {
      out[k] = p;
      if (typeof v.mint === "string") out[v.mint] = p;
      if (typeof v.id === "string") out[v.id] = p;
      if (typeof v.symbol === "string") out[v.symbol] = p;
    }
  }
  return out;
}

async function fetchFrom(urls: string[], idsJoined: string): Promise<PriceMap> {
  for (const base of urls) {
    const json = await tryFetch(`${base}${idsJoined}`);
    const map = parsePriceResponse(json);
    if (Object.keys(map).length) return map;
  }
  return {};
}

/**
 * Robust USD price fetch:
 * - Accepts ids that can be mints AND/OR symbols.
 * - In the browser we SKIP v3 (it returns 401 without a key); we try v6 -> v4.
 * - On the server we can try v3 first (in case you later proxy with a key), then v6 -> v4.
 * - Stablecoins backfill to $1.00 only if the APIs return nothing.
 */
export async function fetchUsdPricesByAny(ids: string[]): Promise<PriceMap> {
  const wantedList = uniq(ids);
  if (!wantedList.length) return {};

  const joined = encodeURIComponent(wantedList.join(","));

  const urls = isServerSide()
    ? [JUP_V3, JUP_V6, JUP_V4]  // server can try v3 first (if you ever proxy with key)
    : [JUP_V6, JUP_V4];         // client/browser: skip v3 to avoid 401

  const out = await fetchFrom(urls, joined);

  // Backfill stables if still missing
  for (const id of wantedList) {
    if (out[id] === undefined && STABLE_PRICE_HINT[id] !== undefined) {
      out[id] = STABLE_PRICE_HINT[id];
    }
  }

  return out;
}

// Legacy compatibility (mints only)
export async function fetchUsdPricesByMint(mints: string[]): Promise<PriceMap> {
  return fetchUsdPricesByAny(mints);
}

export function formatUsd2(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "$–";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
