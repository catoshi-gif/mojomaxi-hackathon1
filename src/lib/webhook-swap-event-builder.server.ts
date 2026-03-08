// filepath: src/lib/webhook-swap-event-builder.server.ts
// Shared event builder for webhook-style swaps.
// This is extracted from the webhook ingest route so Manual Swap logs IDENTICAL activity + P&L.
// RUNTIME: nodejs (server-only)

import type { Redis } from "@upstash/redis";

// We intentionally keep dependencies minimal and rely on the same primitives ingest uses.
import { normalizeWebhookMintsFromDoc } from "@/lib/immutability.guard";

type AnyObj = Record<string, any>;

function safeStr(x: any) {
  return typeof x === "string" ? x : String(x ?? "");
}

function shortMint(m: string): string {
  const s = safeStr(m).trim();
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/**
 * Mirrors the ingest route's A/B mapping resolution.
 * For webhook sets, BUY should show B->A and SELL should show A->B, regardless of internal routing.
 */
function getSetMints(set: AnyObj): { mintA: string; mintB: string; symbolA: string; symbolB: string } {
  const { mintA, mintB, mintIn, mintOut } = normalizeWebhookMintsFromDoc(set || {});
  const A = safeStr(mintA || mintIn || "").trim();
  const B = safeStr(mintB || mintOut || "").trim();
  const symbolA = safeStr((set as any)?.tokenA?.symbol || (set as any)?.tokenA?.sym || "").trim();
  const symbolB = safeStr((set as any)?.tokenB?.symbol || (set as any)?.tokenB?.sym || "").trim();
  return { mintA: A, mintB: B, symbolA, symbolB };
}

function ensureDisplayOrdering(kind: "buy" | "sell", set: AnyObj, ev: AnyObj): AnyObj {
  const m = getSetMints(set);
  if (!m.mintA || !m.mintB) return ev;

  const expectedIn = kind === "buy" ? m.mintB : m.mintA;
  const expectedOut = kind === "buy" ? m.mintA : m.mintB;

  const inMint = safeStr(ev?.inMint || ev?.inputMint || "").trim();
  const outMint = safeStr(ev?.outMint || ev?.outputMint || "").trim();

  if (inMint === expectedIn && outMint === expectedOut) return ev;

  const out: AnyObj = { ...ev };

  // swap mints
  const tmpM = out.inMint;
  out.inMint = out.outMint;
  out.outMint = tmpM;
  const tmpIM = out.inputMint;
  out.inputMint = out.outputMint;
  out.outputMint = tmpIM;

  // swap symbols
  const tmpS = out.inSymbol;
  out.inSymbol = out.outSymbol;
  out.outSymbol = tmpS;
  const tmpIS = out.inputSymbol;
  out.inputSymbol = out.outputSymbol;
  out.outputSymbol = tmpIS;

  // swap amounts
  const tmpA = out.amountInAtoms;
  out.amountInAtoms = out.amountOutAtoms;
  out.amountOutAtoms = tmpA;
  const tmpU = out.amountInUi;
  out.amountInUi = out.amountOutUi;
  out.amountOutUi = tmpU;

  // swap usd
  const tmpP = out.inUsdPrice;
  out.inUsdPrice = out.outUsdPrice;
  out.outUsdPrice = tmpP;
  const tmpT = out.inTotalUsd;
  out.inTotalUsd = out.outTotalUsd;
  out.outTotalUsd = tmpT;

  // force expected mints (in case internal swap didn't match)
  out.inMint = expectedIn;
  out.outMint = expectedOut;
  out.inputMint = expectedIn;
  out.outputMint = expectedOut;

  return out;
}

// Same as ingest: resilient push so logging doesn't fail the swap
async function pushRecentEventResilient(redis: Redis, pushRecentEvent: any, setId: string, message: string, ev: AnyObj) {
  try {
    await pushRecentEvent(setId, message, ev);
  } catch (e: any) {
    // last-ditch: append a minimal event so the UI doesn't break
    try {
      const fallback = { ...ev, message, _pushError: safeStr(e?.message || e) };
      await pushRecentEvent(setId, message, fallback);
    } catch {}
  }
}

// Fresh prices: use price-lite helper if available; support both number and {price} shapes.
async function freshPricesByMint(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const uniq = Array.from(new Set((mints || []).map((m) => safeStr(m).trim()).filter(Boolean)));
  if (!uniq.length) return out;

  try {
    const mod: any = await import("@/lib/price-lite");
    // prefer a no-cache / fresh fetch to match ingest semantics
    const fn = mod?.pricesByMintNoCache || mod?.pricesByMint;
    if (typeof fn === "function") {
      const res: any = await fn(uniq);
      for (const m of uniq) {
        const v: any = res?.[m];
        if (typeof v === "number" && Number.isFinite(v)) out[m] = v;
        else if (v && typeof v === "object" && typeof v.price === "number" && Number.isFinite(v.price)) out[m] = v.price;
      }
    }
  } catch {}
  return out;
}

async function tokenSymbolForMint(set: AnyObj, mint: string): Promise<string> {
  const m = getSetMints(set);
  if (mint === m.mintA && m.symbolA) return m.symbolA;
  if (mint === m.mintB && m.symbolB) return m.symbolB;

  try {
    const mod: any = await import("@/lib/price-lite");
    if (typeof mod?.tokenMeta === "function") {
      const meta = await mod.tokenMeta(mint);
      const sym = safeStr(meta?.sym || meta?.symbol || "").trim();
      if (sym) return sym;
    }
  } catch {}

  return shortMint(mint);
}

async function mintDecimals(set: AnyObj, mint: string): Promise<number | null> {
  const m = getSetMints(set);
  const maybe =
    mint === m.mintA ? (set as any)?.tokenA?.decimals : mint === m.mintB ? (set as any)?.tokenB?.decimals : null;
  const n = Number(maybe);
  if (Number.isFinite(n)) return n;

  try {
    const mod: any = await import("@/lib/solana-mint");
    const fn = mod?.fetchMintDecimals || mod?.getMintDecimals;
    if (typeof fn === "function") return await fn(mint);
  } catch {}
  return null;
}

export type LogSwapEventParams = {
  redis: Redis;
  pushRecentEvent: any;
  set: AnyObj;
  kind: "buy" | "sell";
  owner: string;
  vault: string;
  inMint: string;
  outMint: string;
  amountInAtoms: string;
  outDeltaAtoms?: string | null;
  res: AnyObj;
  res0?: AnyObj | null;
  ingestId?: string | null;
};

export async function logWebhookStyleSwapEvent(p: LogSwapEventParams): Promise<AnyObj> {
  const { redis, pushRecentEvent, set, kind, owner, vault, inMint, outMint, amountInAtoms } = p;

  const inSym = await tokenSymbolForMint(set, inMint);
  const outSym = await tokenSymbolForMint(set, outMint);

  const decIn = await mintDecimals(set, inMint);
  const decOut = await mintDecimals(set, outMint);

  const q: AnyObj | null = (p?.res as any)?.quote || null;

  // Deterministic outAtoms (ingest semantics): quote outAmount preferred, else post-trade delta.
  const outAtoms =
    safeStr(q?.outAmountWithSlippage ?? q?.outAmount ?? q?.outAmountRaw ?? q?.otherAmountThreshold ?? "").trim() ||
    (p.outDeltaAtoms && /^[0-9]+$/.test(p.outDeltaAtoms) && BigInt(p.outDeltaAtoms) > 0n ? p.outDeltaAtoms : "");

  const uiIn =
    /^[0-9]+$/.test(amountInAtoms) && decIn != null ? Number(amountInAtoms) / Math.pow(10, decIn) : null;
  const uiOut =
    /^[0-9]+$/.test(outAtoms) && decOut != null ? Number(outAtoms) / Math.pow(10, decOut) : null;

  const px = await freshPricesByMint([inMint, outMint]);
  const inUsdPrice = Number.isFinite(px[inMint]) ? px[inMint] : null;
  const outUsdPrice = Number.isFinite(px[outMint]) ? px[outMint] : null;

  let inTotalUsd: number | null = null;
  let outTotalUsd: number | null = null;

  try {
    if (typeof q?.inAmountUsd === "number") inTotalUsd = q.inAmountUsd;
    if (typeof q?.outAmountUsd === "number") outTotalUsd = q.outAmountUsd;
  } catch {}

  if (inTotalUsd == null && uiIn != null && inUsdPrice != null) inTotalUsd = uiIn * inUsdPrice;
  if (outTotalUsd == null && uiOut != null && outUsdPrice != null) outTotalUsd = uiOut * outUsdPrice;

  // derive prices from totals if missing (generic, not token-specific)
  const inUsdPrice2 =
    (typeof inUsdPrice === "number" ? inUsdPrice : null) ??
    (typeof inTotalUsd === "number" && typeof uiIn === "number" && uiIn > 0 ? inTotalUsd / uiIn : null);
  const outUsdPrice2 =
    (typeof outUsdPrice === "number" ? outUsdPrice : null) ??
    (typeof outTotalUsd === "number" && typeof uiOut === "number" && uiOut > 0 ? outTotalUsd / uiOut : null);

  const sig = safeStr((p?.res as any)?.signature || "").trim() || null;

  let ev: AnyObj = {
    ingestId: p.ingestId || null,
    wallet: owner,
    vault,
    inMint,
    outMint,
    inputMint: inMint,
    outputMint: outMint,
    inSymbol: inSym,
    outSymbol: outSym,
    inputSymbol: inSym,
    outputSymbol: outSym,
    inputDecimals: decIn ?? null,
    outputDecimals: decOut ?? null,
    amountInAtoms: safeStr(amountInAtoms),
    amountOutAtoms: outAtoms || null,
    amountInUi: uiIn,
    amountOutUi: uiOut,
    inUsdPrice: typeof inUsdPrice2 === "number" ? inUsdPrice2 : undefined,
    outUsdPrice: typeof outUsdPrice2 === "number" ? outUsdPrice2 : undefined,
    inTotalUsd: typeof inTotalUsd === "number" ? inTotalUsd : undefined,
    outTotalUsd: typeof outTotalUsd === "number" ? outTotalUsd : undefined,
    unitPriceUsd:
      kind === "buy"
        ? (typeof outUsdPrice2 === "number" ? outUsdPrice2 : undefined)
        : (typeof inUsdPrice2 === "number" ? inUsdPrice2 : undefined),
    ok: !!(p?.res as any)?.ok,
    tx: sig,
    txUrl: sig ? `https://solscan.io/tx/${sig}` : null,
    diag: (p?.res as any)?.diag || (p?.res0 as any)?.diag || null,
    clientRef: (p?.res as any)?.clientRef || undefined,
    ts: Date.now(),
  };

  ev = ensureDisplayOrdering(kind, set, ev);

  await pushRecentEventResilient(redis, pushRecentEvent, safeStr((set as any)?.setId || ""), `swap_${kind}`, ev);

  // positions + pnl: atomic pipeline to minimize race window on concurrent swaps
  try {
    const setId = safeStr((set as any)?.setId || "").trim();
    if (setId) {
      const posKey = `mm:set:${setId}:pos`;
      const pnlKey = `mm:set:${setId}:pnl`;

      if (kind === "buy") {
        const units = typeof ev.amountOutUi === "number" ? ev.amountOutUi : 0;
        const cost = typeof ev.inTotalUsd === "number" ? ev.inTotalUsd : null;

        if (units > 0 && typeof cost === "number") {
          // Atomic pipeline: both increments in a single round-trip
          const p = (redis as any).pipeline();
          p.hincrbyfloat(posKey, "units", units);
          p.hincrbyfloat(posKey, "costUsd", cost);
          await p.exec();
        }
      } else if (kind === "sell") {
        const unitsSold = typeof ev.amountInUi === "number" ? ev.amountInUi : 0;
        const proceeds = typeof ev.outTotalUsd === "number" ? ev.outTotalUsd : null;

        if (unitsSold > 0 && typeof proceeds === "number") {
          // Read current position in a single pipeline round-trip
          const readPipe = (redis as any).pipeline();
          readPipe.hget(posKey, "units");
          readPipe.hget(posKey, "costUsd");
          const [rawUnits, rawCost] = await readPipe.exec();
          const curUnits = Number(rawUnits || 0);
          const curCost = Number(rawCost || 0);

          const avgCost = curUnits > 0 ? curCost / curUnits : 0;
          const costBasis = unitsSold * avgCost;
          const realized = proceeds - costBasis;

          // Write all position + pnl updates in a single pipeline round-trip
          const writePipe = (redis as any).pipeline();
          writePipe.hincrbyfloat(posKey, "units", -unitsSold);
          writePipe.hincrbyfloat(posKey, "costUsd", -costBasis);
          writePipe.hincrbyfloat(pnlKey, "realizedUsd", realized);
          writePipe.hincrbyfloat(pnlKey, "volumeUsd", proceeds);
          await writePipe.exec();
        }
      }
    }
  } catch {}

  return ev;
}
