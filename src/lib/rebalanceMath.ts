// src/lib/rebalanceMath.ts
// Pure helpers for rebalance math. No React, no browser APIs.
// You can import these in client or server components without side effects.
//
// WHAT THIS SOLVES
// - Correct "Volume (USD)" for a rebalance: sum of absolute USD values of each leg.
// - Correct "Total vault equity (USD) AFTER the rebalance": equity is *not* the net delta;
//   it's the USD value of all post-rebalance balances.
// - Designed to "freeze" the equity number at the moment a rebalance group is complete.
//   (Freezing is done by the caller; this file only computes values deterministically.)
//
// SAFETY
// - Works with bigint string raw amounts and token decimals (spl-style 0..9).
// - Price map can be by mint or by symbol. Stable mints can be forced to 1.0.
// - Never returns negative equity; volume is always >= 0.
// - No external dependencies.
//
// USAGE (minimal):
//   import { equityAfterRebalance, sumRebalanceVolumeUsd } from '@/lib/rebalanceMath';
//
//   const { postSnapshot, equityUsdAfter } = equityAfterRebalance(preSnapshot, legs, priceMap, {
//     stableMints: ['EPjFWdd5AufqSSqeM2q8GL4pNH65J5oP68', 'Es9vMFrzaCERg8wNaGqPkjj1nKze1G7xSL3QFTtZ8s7'] // USDC, USDT
//   });
//   const volumeUsd = sumRebalanceVolumeUsd(legs, priceMap);
//
// TYPES
export interface Leg {
  id: string;
  groupId: string;
  confirmed: boolean;
  // SPL token mints (or any unique token identifier string). Case-sensitive.
  tokenIn: string;
  tokenOut: string;
  // Raw integer amounts in smallest units (e.g. lamports-style). Strings recommended.
  amountInRaw: string | number | bigint;
  amountOutRaw: string | number | bigint;
  decimalsIn: number;
  decimalsOut: number;
  // Optional per-leg prices at execution time. Prefer these if available.
  priceInUsdAtExec?: number;
  priceOutUsdAtExec?: number;
  feeUsd?: number; // positive fee in USD (if known)
  // Timestamp (ms since epoch preferred). Used only for debugging/ordering by callers.
  ts?: number;
}

export interface TokenBalance {
  mint: string;         // token mint / unique id
  amountRaw: string;    // raw integer in smallest units, as string
  decimals: number;
}

export type Snapshot = Record<string, TokenBalance>; // keyed by mint (case-sensitive)
export type PriceMap = Record<string, number>;

export interface EquityOptions {
  // If a token's price is missing, and its mint is in stableMints, treat price as 1.0
  stableMints?: string[];
  // If true, prefer "price at exec" fields on legs to the provided priceMap.
  preferLegExecutionPrices?: boolean;
}

const ZERO = 0 as const;

function toBigInt(v: string | number | bigint): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    // Accept only integers
    if (!Number.isFinite(v) || Math.floor(v) !== v) throw new Error('amount must be integer');
    return BigInt(v);
  }
  // string
  const s = v.trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`invalid integer string: ${v}`);
  return BigInt(s);
}

function pow10(decimals: number): bigint {
  if (decimals < 0 || decimals > 18) throw new Error('decimals out of range (0..18)');
  let p = 1n;
  for (let i = 0; i < decimals; i++) p *= 10n;
  return p;
}

function toUiAmount(raw: string | number | bigint, decimals: number): number {
  const bi = toBigInt(raw);
  const sign = bi < 0n ? -1 : 1;
  const abs = bi < 0n ? -bi : bi;
  const denom = pow10(decimals);
  // Convert to number safely: do integer division + remainder to avoid precision blowup
  const whole = abs / denom;
  const rem = abs % denom;
  const precise = Number(whole) + Number(rem) / Number(denom);
  return sign * precise;
}

function isStable(mint: string, opts?: EquityOptions): boolean {
  if (!opts?.stableMints) return false;
  return opts.stableMints.includes(mint);
}

/**
 * Resolve USD price for a token. Tries, in order:
 *  - If allowLegPrice and a per-leg price is provided, use it
 *  - priceMap[mint]
 *  - priceMap[symbol-like uppercase], if caller puts symbols into the map
 *  - if mint is in stableMints -> 1.0
 *  - otherwise 0
 */
function resolvePriceUsd(
  mint: string,
  priceMap: PriceMap | undefined,
  fallbackSymbol?: string,
  allowLegPrice?: number | undefined,
  opts?: EquityOptions,
): number {
  if (typeof allowLegPrice === 'number' && Number.isFinite(allowLegPrice) && allowLegPrice > 0) {
    return allowLegPrice;
  }
  if (priceMap && Object.prototype.hasOwnProperty.call(priceMap, mint)) {
    const p = priceMap[mint];
    if (typeof p === 'number' && Number.isFinite(p) && p >= 0) return p;
  }
  if (priceMap && fallbackSymbol && Object.prototype.hasOwnProperty.call(priceMap, fallbackSymbol)) {
    const p = priceMap[fallbackSymbol];
    if (typeof p === 'number' && Number.isFinite(p) && p >= 0) return p;
  }
  if (isStable(mint, opts)) return 1.0;
  return 0;
}

/**
 * Compute absolute USD trade volume for a set of legs.
 * We count only the "amountIn * priceInUsdAtExec" per leg (if available),
 * otherwise we fallback to "amountIn * priceMap[tokenIn]" (or amountOut * priceOut price).
 * Fees (feeUsd) are *added* to volume if provided.
 */
export function sumRebalanceVolumeUsd(
  legs: Leg[],
  priceMap?: PriceMap,
  opts?: EquityOptions,
): number {
  let total = 0;
  for (const leg of legs) {
    // prefer leg execution price if requested
    const preferLeg = opts?.preferLegExecutionPrices ?? true;
    const priceIn = resolvePriceUsd(
      leg.tokenIn,
      priceMap,
      undefined,
      preferLeg ? leg.priceInUsdAtExec : undefined,
      opts
    );
    const priceOut = resolvePriceUsd(
      leg.tokenOut,
      priceMap,
      undefined,
      preferLeg ? leg.priceOutUsdAtExec : undefined,
      opts
    );

    const inUi = toUiAmount(leg.amountInRaw, leg.decimalsIn);
    const outUi = toUiAmount(leg.amountOutRaw, leg.decimalsOut);

    let legVol = 0;
    if (priceIn > 0) {
      legVol = Math.abs(inUi * priceIn);
    } else if (priceOut > 0) {
      legVol = Math.abs(outUi * priceOut);
    } else {
      legVol = 0;
    }

    if (typeof leg.feeUsd === 'number' && Number.isFinite(leg.feeUsd) && leg.feeUsd > 0) {
      legVol += leg.feeUsd;
    }
    total += legVol;
  }
  return total;
}

/**
 * Apply legs to a pre-rebalance snapshot to produce a post-rebalance snapshot.
 * This *does not* validate balances going negative; caller is expected to pass valid legs.
 */
export function applyLegsToBalances(pre: Snapshot, legs: Leg[]): Snapshot {
  const post: Snapshot = {};
  // shallow copy
  for (const [mint, bal] of Object.entries(pre)) {
    post[mint] = { ...bal };
  }

  function addToMint(mint: string, deltaRaw: string | number | bigint, decimals: number) {
    const d = toBigInt(deltaRaw);
    if (!post[mint]) {
      post[mint] = { mint, amountRaw: '0', decimals };
    }
    const cur = toBigInt(post[mint].amountRaw);
    const next = cur + d;
    post[mint].amountRaw = next.toString();
    post[mint].decimals = decimals; // keep latest seen decimals
  }

  for (const leg of legs) {
    // subtract amountIn from tokenIn
    addToMint(leg.tokenIn, -toBigInt(leg.amountInRaw), leg.decimalsIn);
    // add amountOut to tokenOut
    addToMint(leg.tokenOut, toBigInt(leg.amountOutRaw), leg.decimalsOut);
    // fees are not represented as token balances here; caller may subtract SOL/USDC elsewhere if needed
  }

  return post;
}

/**
 * Compute USD equity for a balances snapshot.
 * Missing prices are treated as 0 unless the mint is marked stable (-> 1.0).
 */
export function computeEquityUsd(
  snapshot: Snapshot,
  priceMap?: PriceMap,
  opts?: EquityOptions,
): number {
  let total = 0;
  for (const [mint, bal] of Object.entries(snapshot)) {
    const ui = toUiAmount(bal.amountRaw, bal.decimals);
    if (ui === 0) continue;
    const price = resolvePriceUsd(mint, priceMap, undefined, undefined, opts);
    if (price <= 0) continue;
    total += ui * price;
  }
  // Equity cannot be negative (in the panel's meaning). Clamp at 0.
  if (!Number.isFinite(total) || total < 0) return 0;
  return total;
}

/**
 * Main helper: given a pre snapshot + legs, return post snapshot and equity USD *after* rebalance.
 * Also returns the volume USD for convenience.
 */
export function equityAfterRebalance(
  preSnapshot: Snapshot,
  legs: Leg[],
  priceMap?: PriceMap,
  opts?: EquityOptions,
): { postSnapshot: Snapshot; equityUsdAfter: number; volumeUsd: number } {
  const post = applyLegsToBalances(preSnapshot, legs);
  const equityUsd = computeEquityUsd(post, priceMap, opts);
  const volumeUsd = sumRebalanceVolumeUsd(legs, priceMap, opts);
  return { postSnapshot: post, equityUsdAfter: equityUsd, volumeUsd };
}

// Utilities exposed for callers that need precise math.
export const __internal = { toBigInt, toUiAmount, pow10, resolvePriceUsd };
