// filepath: src/app/api/events/top-tokens/route.ts
// Top traded tokens derived from our own activity stream in Upstash (last 24h).
// - This route is for homepage widgets only. It does NOT modify or replace /api/tokens/top (used by pickers).
// - Fast: reads a bounded slice from mm:events:recent and aggregates in-memory; cached ~30s.
// - Accurate: prefers frozen USD totals recorded at append-time; falls back to qty * price.

import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";


type AnyObj = Record<string, any>;

function isSuccessfulEvent(e: AnyObj): boolean {
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


const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_FETCH = 600;                 // last N events from the global ring
const CACHE_KEY = "mm:cache:top_tokens_24h";
const CACHE_TTL_MS = 30 * 1000;

function asStr(x: any): string { return typeof x === "string" ? x : x == null ? "" : String(x); }
function asNum(x: any): number { const n = Number(x); return Number.isFinite(n) ? n : NaN; }

function usd(primary?: any, qty?: any, price?: any): number {
  const p = asNum(primary);
  if (Number.isFinite(p)) return p;
  const q = asNum(qty);
  const pr = asNum(price);
  if (Number.isFinite(q) && Number.isFinite(pr)) return q * pr;
  return 0;
}

function parseRow(row: any): AnyObj | null {
  try {
    if (row && typeof row === "string") return JSON.parse(row);
    if (row && typeof row === "object") return row as AnyObj;
    return null;
  } catch { return null; }
}

function pickAssetSide(e: AnyObj): { mint?: string | null; symbol?: string | null; volumeUsd: number } | null {
  const kind = asStr(e.kind || e.message || e.type).toLowerCase();

  if (!isSuccessfulEvent(e)) return null;

  // Rebalance summary rows: count OUT sides
  if (kind.includes("rebalance") && Array.isArray(e.rebalancePairs)) {
    let sum = 0;
    let mint: string | null = null;
    let symbol: string | null = null;
    for (const p of e.rebalancePairs) {
      const m = asStr(p?.outMint);
      if (m) {
        mint = m;
        symbol = asStr(p?.outSymbol || p?.symbol || symbol || "");
        sum += usd(p?.outTotalUsd, p?.amountOutUi, p?.outUsdPrice);
      }
    }
    if (mint && sum > 0) return { mint, symbol, volumeUsd: sum };
    return null;
  }

  // Swaps / Buys / Sells
  const looksSwap = kind.includes("swap") || kind.includes("buy") || kind.includes("sell");
  if (!looksSwap) return null;

  const isBuy  = kind.includes("buy");
  const isSell = kind.includes("sell");

  // BUY: B -> A (asset is OUT).  SELL: A -> B (asset is IN). For generic SWAP, prefer OUT side.
  const mint   = isBuy ? asStr(e.outputMint || e.outMint) : isSell ? asStr(e.inputMint || e.inMint) : asStr(e.outputMint || e.outMint || e.inMint || e.inputMint);
  const symbol = isBuy ? asStr(e.outputSymbol || e.outSymbol) : isSell ? asStr(e.inputSymbol || e.inSymbol) : asStr(e.outSymbol || e.outputSymbol || e.inSymbol || e.inputSymbol);
  const notional = isBuy
    ? usd(e.outTotalUsd, e.amountOutUi ?? e.outAmountUi, e.outUsdPrice)
    : isSell
      ? usd(e.inTotalUsd,  e.amountInUi  ?? e.inAmountUi,  e.inUsdPrice)
      : usd(e.outTotalUsd, e.amountOutUi ?? e.outAmountUi, e.outUsdPrice);

  if (mint && notional > 0) return { mint, symbol, volumeUsd: notional };
  return null;
}

async function getCached(): Promise<any | null> {
  try {
    const as = await (redis as any).get(CACHE_KEY);
    const ts = asNum(as?.ts);
    if (!as || !Number.isFinite(ts)) return null;
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return as.payload;
  } catch { return null; }
}

async function setCached(payload: any): Promise<void> {
  try {
    await (redis as any).set(CACHE_KEY, { ts: Date.now(), payload });
  } catch {}
}

export async function GET(req: NextRequest) {
  try {
    // cache first
    const cached = await getCached();
    if (cached) return NextResponse.json({ ok: true, ...cached });

    const now = Date.now();
    const rows = (await (redis as any).lrange("mm:events:recent", 0, MAX_FETCH - 1).catch(() => [])) as any[];
    const events = rows.map(parseRow).filter(Boolean) as AnyObj[];
    const windowed = events.filter((e) => {
      const ts = asNum(e?.ts);
      return Number.isFinite(ts) ? now - ts <= WINDOW_MS : false;
    });

    // aggregate
    const byMint = new Map<string, { volumeUsd: number; symbol?: string }>();
    for (const e of windowed) {
      const side = pickAssetSide(e);
      if (!side?.mint) continue;
      const prev = byMint.get(side.mint) || { volumeUsd: 0, symbol: side.symbol };
      prev.volumeUsd += side.volumeUsd || 0;
      if (!prev.symbol && side.symbol) prev.symbol = side.symbol;
      byMint.set(side.mint, prev);
    }

    // rank
    const ranked = Array.from(byMint.entries())
      .sort((a, b) => b[1].volumeUsd - a[1].volumeUsd)
      .slice(0, 10);

    // enrich meta for just the ranked mints via our internal meta route
    const url = new URL(req.url);
    const origin = url.origin;
    const mints = ranked.map(([m]) => m).join(",");
    let metaMap = new Map<string, AnyObj>();
    if (mints.length) {
      const metaRes = await fetch(`${origin}/api/tokens/meta?mints=${encodeURIComponent(mints)}`, { cache: "no-store" });
      const meta = (await metaRes.json().catch(() => null)) as AnyObj | null;
      if (meta?.ok && Array.isArray(meta.items)) {
        for (const t of meta.items) {
          const mint = asStr(t?.mint || t?.address);
          if (mint) metaMap.set(mint, t);
        }
      }
    }

    const items = ranked.map(([mint, v]) => {
      const mm = metaMap.get(mint) || {};
      return {
        address: mint,
        mint,
        symbol: asStr(v.symbol || mm.symbol || ""),
        name: asStr(mm.name || v.symbol || ""),
        logoURI: asStr(mm.logoURI || mm.icon || ""),
        volumeUsd: Math.round((v.volumeUsd + Number.EPSILON) * 100) / 100,
      };
    });

    const payload = { items, updatedAt: Date.now() };
    await setCached(payload);
    return NextResponse.json({ ok: true, ...payload });
  } catch (e: any) {
    return NextResponse.json({ ok: false, items: [], updatedAt: Date.now(), error: e?.message || "top_tokens_error" }, { status: 500 });
  }
}
