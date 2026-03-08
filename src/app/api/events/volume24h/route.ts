import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const CACHE_KEY = "mm:cache:events:vol24h";
const TTL_MS = 10_000;

type AnyObj = Record<string, any>;

function isSuccessfulEvent(e: AnyObj): boolean {
  // We only count *successful* swaps as volume.
  // Robust heuristics (additive):
  // - A valid signature (from any known field or txUrl) => success (even if ok was mis-set).
  // - ok:true => success
  // - ok:false with no signature => failed
  const ok = (e as any)?.ok;

  const directSig = String(
    (e as any)?.signature ||
      (e as any)?.sig ||
      (e as any)?.tx ||
      (e as any)?.txid ||
      ""
  ).trim();

  let sig = directSig;
  const txUrl = String((e as any)?.txUrl || "").trim();
  if (!sig && txUrl) {
    const parts = txUrl.split("/tx/");
    const s = parts.length > 1 ? parts[1].split("?")[0] : "";
    if (s && s.length >= 20) sig = s;
  }

  if (sig && sig.length >= 20) return true;
  if (ok === true) return true;
  if (ok === false) return false;
  return false;
}


async function getCached(): Promise<any | null> {
  try {
    const raw = await (redis as any).get(CACHE_KEY);
    if (!raw) return null;
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (j && typeof j.t === "number" && Date.now() - j.t < TTL_MS) return j.v;
  } catch {}
  return null;
}
async function setCached(v: any) {
  try {
    await (redis as any).set(CACHE_KEY, JSON.stringify({ t: Date.now(), v }));
  } catch {}
}

function isRebalanceSummary(e: AnyObj): boolean {
  const k = String(e?.kind || e?.type || "").toUpperCase();
  return k === "REBALANCE" && (!!e?.aggregated || Array.isArray(e?.rebalancePairs) || Number.isFinite(Number(e?.volumeUsd)));
}

function isSwapLike(e: AnyObj): boolean {
  const k = String(e?.kind || e?.type || "").toLowerCase();
  if (k === "buy" || k === "sell") return true;
  if (k.includes("swap")) return true;
  // REBALANCE summaries are "volume-worthy" even if they don't look like a swap row.
  if (isRebalanceSummary(e)) return true;
  return !!(e?.inSymbol || e?.outSymbol || e?.mintIn || e?.mintOut || e?.inputMint || e?.outputMint);
}

function usdNotional(e: AnyObj): number {
  // direct notional fields
  const amt = Number(e?.amountUsd ?? e?.amountUSD ?? e?.notional ?? e?.usdAmount ?? e?.volumeUsd ?? NaN);
  if (Number.isFinite(amt) && amt > 0) return amt;

  // common swap payload fields
  const inTot = Number(e?.inTotalUsd ?? e?.inTotalUSD ?? e?.usdIn ?? e?.inputUsd ?? e?.inUsd ?? NaN);
  const outTot = Number(e?.outTotalUsd ?? e?.outTotalUSD ?? e?.usdOut ?? e?.outputUsd ?? e?.outUsd ?? NaN);
  if (Number.isFinite(inTot) || Number.isFinite(outTot)) {
    return Math.max(Number.isFinite(inTot) ? Math.abs(inTot) : 0, Number.isFinite(outTot) ? Math.abs(outTot) : 0);
  }

  // price * qty style
  const price = Number(e?.price ?? e?.unitPriceUsd ?? e?.usdPrice ?? NaN);
  const qty = Number(e?.qty ?? e?.quantity ?? e?.amount ?? NaN);
  if (price > 0 && qty > 0) return price * qty;

  // in/out price + amount style
  const inP = Number(e?.inUsdPrice ?? e?.priceInUsd ?? NaN);
  const inQ = Number(e?.inAmount ?? e?.amountIn ?? NaN);
  const outP = Number(e?.outUsdPrice ?? e?.priceOutUsd ?? NaN);
  const outQ = Number(e?.outAmount ?? e?.amountOut ?? NaN);
  const inUsd = inP > 0 && inQ > 0 ? inP * inQ : 0;
  const outUsd = outP > 0 && outQ > 0 ? outP * outQ : 0;
  const best = Math.max(inUsd, outUsd);
  return Number.isFinite(best) && best > 0 ? best : 0;
}

function rebalancePairsVolumeUsd(e: AnyObj): number {
  try {
    const pairs = Array.isArray(e?.rebalancePairs) ? (e.rebalancePairs as AnyObj[]) : [];
    if (!pairs.length) return 0;

    // Mirror the client-side ActivityPanel behavior:
    // for each pair, use the best available USD notional and sum it.
    let sum = 0;
    for (const p of pairs) {
      const v = usdNotional(p);
      if (v > 0) sum += Math.abs(v);
    }
    return Number.isFinite(sum) && sum > 0 ? sum : 0;
  } catch {
    return 0;
  }
}

function eventVolumeUsd(e: AnyObj): number {
  // For normal swap/buy/sell rows this will pick up inTotalUsd/outTotalUsd etc.
  const base = usdNotional(e);
  if (base > 0) return base;

  // For REBALANCE summaries, volume is often stored on rebalancePairs or as a precomputed volumeUsd.
  const pairSum = rebalancePairsVolumeUsd(e);
  if (pairSum > 0) return pairSum;

  const v = Number(e?.volumeUsd ?? NaN);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function lrangeJson(key: string, start: number, stop: number): Promise<AnyObj[]> {
  const list = (await redis.lrange<string[]>(key, start, stop).catch(() => [])) as any[];
  return (list || [])
    .map((row) => {
      try {
        return typeof row === "string" ? JSON.parse(row) : row;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as AnyObj[];
}

export async function GET(_req: NextRequest) {
  try {
    const cached = await getCached();
    if (cached) {
      return NextResponse.json({ ok: true, ...(cached || {}) }, { headers: { "Cache-Control": "public, max-age=10, s-maxage=20, stale-while-revalidate=30" } });
    }

    const now = Date.now();
    const rows = await lrangeJson("mm:events:recent", 0, 999);
    let sum = 0;
    let count = 0;

    const seenSigs = new Set<string>();
    const seenRunIds = new Set<string>();

    for (const e of rows) {
      const ts = Number(e?.ts ?? e?.t ?? 0);
      if (!Number.isFinite(ts) || now - ts > 24 * 60 * 60 * 1000) continue;
      if (!isSwapLike(e)) continue;
      if (!isSuccessfulEvent(e)) continue;
      const kind = String(e?.kind || e?.type || "").toUpperCase();
      const isAggRebalance = isRebalanceSummary(e) && kind === "REBALANCE" && (e as any)?.aggregated;

      // Extract a signature if present (used to de-dupe aggregated REBALANCE vs per-leg swap rows).
      const sigRaw = String((e as any)?.signature || (e as any)?.sig || (e as any)?.tx || (e as any)?.txid || "").trim();
      const txUrl = String((e as any)?.txUrl || "").trim();
      let sig = sigRaw;
      if (!sig && txUrl) {
        const parts = txUrl.split("/tx/");
        const s = parts.length > 1 ? parts[1].split("?")[0] : "";
        if (s && s.length >= 20) sig = s;
      }

      const runId = String((e as any)?.runId || "").trim();
      if (isAggRebalance) {
        // If we've already observed per-leg swaps for this run, skip the summary to avoid double count.
        if (runId && seenRunIds.has(runId)) continue;

        // Also skip if any of the summary signatures are already seen.
        const urls: any[] = Array.isArray((e as any)?.txUrls) ? (e as any).txUrls : [];
        let overlap = false;
        for (const u of urls) {
          try {
            const parts = String(u).split("/tx/");
            const s = parts.length > 1 ? parts[1].split("?")[0] : "";
            if (s && s.length >= 20 && seenSigs.has(s)) { overlap = true; break; }
          } catch {}
        }
        if (!overlap && sig && sig.length >= 20 && seenSigs.has(sig)) overlap = true;
        if (overlap) continue;
      } else {
        if (sig && sig.length >= 20) seenSigs.add(sig);
        if (runId) seenRunIds.add(runId);
      }



      const usd = eventVolumeUsd(e);
      if (usd > 0) {
        sum += usd;
        count++;
      }
    }

    const payload = { volumeUsd: sum, sampleCount: count, windowMs: 24 * 60 * 60 * 1000 };
    await setCached(payload);
    return NextResponse.json({ ok: true, ...payload }, { headers: { "Cache-Control": "public, max-age=10, s-maxage=20, stale-while-revalidate=30" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "volume_error" }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
