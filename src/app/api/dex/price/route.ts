// filepath: src/app/api/dex/price/route.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "edge";

type Out = {
  ok: boolean;
  mint: string;
  priceUsd?: number;
  symbol?: string;
  baseMatched?: boolean;
  error?: string;
};

function isStableSymbol(sym?: string | null): boolean {
  if (!sym) return false;
  const u = sym.toUpperCase();
  return u === "USDC" || u === "USDT" || u === "USD";
}

// Pick Dex info strictly when our mint is the BASE (priceUsd = USD per BASE)
function pickDexInfo(data: any, mint: string): { priceUsd?: number, symbol?: string, baseMatched?: boolean } {
  const allPairs = Array.isArray(data?.pairs) ? data.pairs : [];
  if (!allPairs.length) return {};
  const solPairs = allPairs.filter((p: any) => p?.chainId === "solana");
  if (!solPairs.length) return {};

  type Scored = { px?: number, sym?: string, liq: number, stableQuoted: number, baseMatched: boolean };
  const basePairs: Scored[] = [];
  const anyPairs: Scored[] = [];

  for (const p of solPairs) {
    const liq = Number(p?.liquidity?.usd ?? 0) || 0;
    const priceUsd = p?.priceUsd ? Number(p.priceUsd) : undefined;

    const baseAddr  = p?.baseToken?.address;
    const baseSym   = p?.baseToken?.symbol;
    const quoteAddr = p?.quoteToken?.address;
    const quoteSym  = p?.quoteToken?.symbol;

    const stableQuoted = isStableSymbol(quoteSym) || quoteAddr === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" || quoteAddr === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" ? 1 : 0;

    if (baseAddr === mint && priceUsd && Number.isFinite(priceUsd)) {
      basePairs.push({ px: priceUsd, sym: baseSym, liq, stableQuoted, baseMatched: true });
    }
    if (quoteAddr === mint) {
      anyPairs.push({ px: undefined, sym: quoteSym, liq, stableQuoted, baseMatched: false });
    }
  }

  const sorter = (a: Scored, b: Scored) => {
    if (b.stableQuoted !== a.stableQuoted) return b.stableQuoted - a.stableQuoted;
    return b.liq - a.liq;
  };

  if (basePairs.length) {
    basePairs.sort(sorter);
    const best = basePairs[0];
    return { priceUsd: best.px, symbol: best.sym, baseMatched: true };
  }

  if (anyPairs.length) {
    anyPairs.sort(sorter);
    const best = anyPairs[0];
    return { symbol: best.sym, baseMatched: false };
  }

  return {};
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mint = String(searchParams.get("mint") || "").trim();
  if (!mint) {
    return NextResponse.json<Out>({ ok: false, mint, error: "missing_mint" }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
      headers: { "accept": "application/json" },
      // Let Vercel/CDN cache this response; Dex is public and deterministic enough for 60s
      cache: "no-store",
    });
    if (!r.ok) {
      return NextResponse.json<Out>({ ok: false, mint, error: `upstream_${r.status}` }, {
        status: 200,
        headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=30" },
      });
    }
    const data = await r.json();
    const picked = pickDexInfo(data, mint);
    const out: Out = { ok: true, mint, ...picked };
    return NextResponse.json<Out>(out, {
      status: 200,
      headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=30" },
    });
  } catch (e: any) {
    return NextResponse.json<Out>({ ok: false, mint, error: "upstream_error" }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
