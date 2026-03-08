// filepath: src/app/api/rebalance/new/route.ts
// Build-safe creator for Rebalance Sets with legacy-compat parsing.
// - Current design: create set with just `wallet`; pick tokens/cadence later via /api/rebalance/set.
// - Legacy-compat: if tokens/freqHours are provided, we PATCH the new set via /api/rebalance/set after creation.
// - No imports of non-existent types from rebalance-store (TokenInfo/FrequencyHours).

import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { createRebalanceSet } from '@/lib/rebalance-store';
import { markSetKind } from '@/lib/set-kind';
import { requireOwnerSession } from "@/lib/auth/guards";

// Local, minimal token shape for legacy inputs
type TokenInfo = { mint: string; symbol?: string; decimals?: number } | undefined;

type Incoming = {
  wallet?: string;
  tokens?: any;
  freqHours?: number;
  frequencyHours?: number;
  status?: string;
  vault?: string;
};

const SOL_MINT = "So11111111111111111111111111111111111111112";

function asToken(x: any): TokenInfo {
  if (!x || typeof x !== 'object') return undefined;
  const mint = typeof x.mint === 'string' ? x.mint.trim() : '';
  if (!mint) return undefined;
  const symbol = typeof x.symbol === 'string' ? x.symbol : undefined;
  const decimals = Number.isFinite(x.decimals) ? Number(x.decimals) : undefined;
  return { mint, symbol, decimals };
}

function parseTokens(t: any): { tokenA?: TokenInfo; tokenB?: TokenInfo } {
  if (!t) return {};
  if (Array.isArray(t) && t.length >= 2) {
    return { tokenA: asToken(t[0]), tokenB: asToken(t[1]) };
  }
  if (t && typeof t === 'object') {
    if (t.a || t.b) return { tokenA: asToken(t.a), tokenB: asToken(t.b) };
    if (t.tokenA || t.tokenB) return { tokenA: asToken(t.tokenA), tokenB: asToken(t.tokenB) };
    const vals = Object.values(t);
    if (vals.length >= 2) return { tokenA: asToken(vals[0]), tokenB: asToken(vals[1]) };
  }
  return {};
}

function parseBody(raw: any) {
  const body: Incoming = (raw && typeof raw === 'object') ? raw : {};
  const wallet = String(body.wallet || '').trim();
  const { tokenA, tokenB } = parseTokens(body.tokens);

  const h = Number.isFinite(body.freqHours) ? Number(body.freqHours)
            : Number.isFinite(body.frequencyHours) ? Number(body.frequencyHours)
            : undefined;
  let cadence: '2h' | '6h' | '12h' | '24h' | undefined = undefined;
  if (h === 2 || h === 6 || h === 12 || h === 24) cadence = (h + 'h') as any;

  const status = typeof body.status === 'string' ? body.status : undefined;
  const vault = typeof body.vault === 'string' ? body.vault : undefined;
  return { wallet, tokenA, tokenB, cadence, status, vault };
}

export async function POST(req: NextRequest) {
  const guard = await requireOwnerSession(req as any);
  if (guard.ok === false) return guard.res;

  try {
    const raw = await req.json().catch(() => ({}));
    const hdrWallet = (req.headers.get('x-wallet') || '').trim();
    const { wallet: bodyWallet, tokenA, tokenB, cadence } = parseBody(raw);
    const wallet = (bodyWallet || hdrWallet).trim();

    if (!wallet) {
      return NextResponse.json({ ok: false, error: 'wallet required' }, { status: 400 });
    }

    // 1) Create a bare set (SOL is enforced/seeded on the store side)
    const set = await createRebalanceSet(wallet);

    // 2) If legacy payload provided tokens/cadence, PATCH them via the canonical /api/rebalance/set
    //    (store rules: Token A must be SOL; 2–6 tokens; cadence one of '2h'|'6h'|'12h'|'24h').
    try {
      const mints: string[] = [];
      // Ensure SOL is first
      mints.push(SOL_MINT);
      // If tokenA isn't SOL, ignore it; only tokenB onward is variable in current design
      if (tokenB?.mint && tokenB.mint !== SOL_MINT) mints.push(tokenB.mint);

      if (mints.length >= 2 || cadence) {
        const payload: any = { setId: set.id };
        if (mints.length >= 2) payload.mints = mints;
        if (cadence) payload.cadence = cadence;

        const url = new URL('/api/rebalance/set', req.url).toString();
        await fetch(url, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-wallet': wallet },
          body: JSON.stringify(payload),
          cache: 'no-store',
        }).then(r => r.json()).catch(() => ({}));
      }
    } catch {}

    // 3) Tag kind = 'rebalance' (best effort)
    try { await markSetKind(set.id, 'rebalance'); } catch {}

    return NextResponse.json({ ok: true, set });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
