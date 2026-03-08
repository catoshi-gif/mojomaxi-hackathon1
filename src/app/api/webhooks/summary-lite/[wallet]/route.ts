// filepath: src/app/api/webhooks/summary-lite/[wallet]/route.ts
// Hardened: returns full webhook IDs/URLs only for the wallet owner (session cookie). Otherwise,
// preserves the JSON shape but redacts buyId/sellId/urls. UI/UX unchanged.

import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSetsByWallet, ensureSetHasIds } from '@/lib/store';
import { redis } from "@/lib/redis";
import { getSessionWalletFromRequest } from '@/lib/auth/session.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AnyObj = Record<string, any>;

function noStoreJsonHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, private, must-revalidate',
    Pragma: 'no-cache',
    Vary: 'Cookie',
  };
}

function canonSetId(s: string): string {
  return String(s || '').trim();
}

function baseUrlFromReq(req: NextRequest): string {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '';
  if (envUrl) return envUrl.replace(/\/+$/, '');
  try { const u = new URL(req.url); return `${u.protocol}//${u.host}`; } catch { return ''; }
}

export async function GET(req: NextRequest, ctx: any) {
  try {
    const wallet = String(ctx?.params?.wallet || '').trim();
    if (!wallet) return NextResponse.json({ ok: false, error: 'missing_wallet' }, { status: 400, headers: noStoreJsonHeaders() });

    const base = baseUrlFromReq(req);
    const sessionWallet = await getSessionWalletFromRequest(req);
    const isOwner = !!sessionWallet && sessionWallet === wallet;

    const raw = await getSetsByWallet(wallet);
    const ensured = await Promise.all((raw || []).map((s) => ensureSetHasIds(s)));

    const sets = ensured.map((s: any) => {
      const setId = canonSetId(String(s?.setId || ''));
      const createdAt = Number((s as any).createdAt || 0) || undefined;
      const createdOn = createdAt ? new Date(createdAt).toISOString() : undefined;

      const buyId = String(s?.buyId || '');
      const sellId = String(s?.sellId || '');

      const urls = {
        buy:  buyId ? (base ? `${base}/buy/${buyId}` : `/buy/${buyId}`) : undefined,
        sell: sellId ? (base ? `${base}/sell/${sellId}` : `/sell/${sellId}`) : undefined,
        legacy: {
          buy:  buyId ? (base ? `${base}/api/webhooks/ingest/${buyId}` : `/api/webhooks/ingest/${buyId}`) : undefined,
          sell: sellId ? (base ? `${base}/api/webhooks/ingest/${sellId}` : `/api/webhooks/ingest/${sellId}`) : undefined,
        }
      };

      const redacted = !isOwner;
      return {
        setId,
        wallet: String(s?.wallet || wallet),
        label: typeof s?.label === 'string' ? s.label : '',
        prefs: s?.prefs ?? {},
        buyId: redacted ? undefined : (buyId || undefined),
        sellId: redacted ? undefined : (sellId || undefined),
        urls: redacted ? { buy: undefined, sell: undefined, legacy: { buy: undefined, sell: undefined } } : urls,
        createdAt,
        createdOn,
      };
    });

    // Optional: vaultIds sticky map — single mget round-trip instead of N individual gets.
    const vaultIds: Record<string, string | null> = {};
    if (sets.length) {
      try {
        const statusKeys = sets.map((s) => `mm:set:${s.setId}:status`);
        const statusVals = await (redis as any).mget(...statusKeys).catch(() => null) as any[] | null;
        sets.forEach((s, i) => {
          try {
            const st = statusVals && Array.isArray(statusVals) ? statusVals[i] : null;
            const v = st && (st as any).vault ? String((st as any).vault) : null;
            vaultIds[s.setId] = v;
          } catch { vaultIds[s.setId] = null; }
        });
      } catch {
        // Fallback: individual gets (preserves original behaviour on mget failure)
        await Promise.all(
          sets.map(async (s) => {
            try {
              const st = await redis.get(`mm:set:${s.setId}:status`);
              const v = st && (st as any).vault ? String((st as any).vault) : null;
              vaultIds[s.setId] = v;
            } catch { vaultIds[s.setId] = null; }
          })
        );
      }
    }

    sets.sort((a, b) => (Number(a.createdAt || 0) < Number(b.createdAt || 0) ? 1 : -1));

    return NextResponse.json({ ok: true, wallet, sets, vaultIds }, { status: 200, headers: noStoreJsonHeaders() });
  } catch (e: any) {
    const msg = (e && (e.message || e.toString())) || 'internal_error';
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: noStoreJsonHeaders() });
  }
}
