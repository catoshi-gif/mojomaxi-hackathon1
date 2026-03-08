// filepath: src/app/api/webhooks/summary/[wallet]/route.ts
import 'server-only';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
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

function getBaseUrl(req: NextRequest): string {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '';
  if (envUrl) return envUrl.replace(/\/+$/, '');
  try { const u = new URL(req.url); return `${u.protocol}//${u.host}`; } catch { return ''; }
}

function canonSetId(s: string): string {
  const raw = String(s || '').trim();
  const m = raw.match(/^(?:set[_-])?(.+)$/i);
  return m ? m[1] : raw;
}
function normPrefs(v: any): AnyObj {
  if (!v) return {};
  if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
  return typeof v === 'object' ? (v || {}) : {};
}
function coerceCreated(row: AnyObj): { createdAt: number; createdOn: string } {
  const ra: any = row?.createdAt;
  const ro: any = row?.createdOn;
  const num = typeof ra === 'number' ? ra : (typeof ra === 'string' && /^\d+$/.test(ra) ? Number(ra) : NaN);
  const isoMs = typeof ro === 'string' ? Date.parse(ro) : NaN;
  const createdAt = Number.isFinite(num) && num > 0 ? num : (Number.isFinite(isoMs) ? isoMs : Date.now());
  const createdOn = typeof ro === 'string' ? ro : new Date(createdAt).toISOString();
  return { createdAt, createdOn };
}

export async function GET(req: NextRequest, ctx: any) {
  try {
    const wallet = String(ctx?.params?.wallet || '').trim();
    if (!wallet) return NextResponse.json({ ok: false, error: 'wallet_required' }, { status: 400, headers: noStoreJsonHeaders() });

    const base = getBaseUrl(req);
    const sessionWallet = await getSessionWalletFromRequest(req);
    const isOwner = !!sessionWallet && sessionWallet === wallet;

    const r = await fetch(`${base}/api/webhooks/for/${encodeURIComponent(wallet)}`, { cache: 'no-store' });
    const j = await r.json().catch(() => null) as AnyObj | null;
    if (!j?.ok) return NextResponse.json({ ok: false, error: j?.error || 'load_failed' }, { status: 500, headers: noStoreJsonHeaders() });

    const rawSets: AnyObj[] = Array.isArray(j.sets) ? j.sets : [];
    const sets = rawSets.map((s) => {
      const canonId = canonSetId(String(s?.setId || ''));
      const cc = coerceCreated(s);
      const redacted = !isOwner;
      const urls = s?.urls && typeof s.urls === 'object' ? s.urls : undefined;
      return {
        setId: canonId,
        wallet: String(s?.wallet || wallet),
        label: typeof s?.label === 'string' ? s.label : '',
        prefs: normPrefs(s?.prefs),
        buyId: redacted ? undefined : String(s?.buyId || ''),
        sellId: redacted ? undefined : String(s?.sellId || ''),
        urls: redacted ? undefined : urls,
        createdAt: cc.createdAt,
        createdOn: cc.createdOn,
      };
    });

    // Batch vault+deletable lookup — single call to /api/sets/bulk/vault-deletable
    // instead of one HTTP round-trip per set to /api/sets/:id/deletable.
    // Falls back to the original per-set fetch loop if the bulk endpoint fails.
    const deletable: Record<string, boolean> = {};
    const vaultIds: Record<string, string | null> = {};
    const statusMap: Record<string, string | null> = {};

    if (sets.length) {
      let bulkOk = false;
      try {
        const ids = sets.map((s) => s.setId).join(',');
        const bulkR = await fetch(`${base}/api/sets/bulk/vault-deletable?ids=${encodeURIComponent(ids)}`, { cache: 'no-store' });
        const bulkJ = await bulkR.json().catch(() => null) as AnyObj | null;
        if (bulkJ?.ok) {
          for (const s of sets) {
            deletable[s.setId] = !!(bulkJ.deletableMap?.[s.setId]);
            vaultIds[s.setId] = bulkJ.vaultMap?.[s.setId] ?? null;
            // status not returned by bulk endpoint — leave null (same as before for non-deletable callers)
            statusMap[s.setId] = null;
          }
          bulkOk = true;
        }
      } catch { bulkOk = false; }

      if (!bulkOk) {
        // Fallback: original per-set fetch (preserves full behaviour including status field)
        const entries = await Promise.all(sets.map(async (s) => {
          try {
            const rr = await fetch(`${base}/api/sets/${encodeURIComponent(s.setId)}/deletable`, { cache: 'no-store' });
            const jj = await rr.json().catch(() => null) as AnyObj | null;
            const del = !!(jj?.ok && jj?.deletable);
            const vault: string | null = (jj?.vault || null) ? String(jj?.vault) : null;
            const status: string | null = (jj?.status || null) ? String(jj?.status) : null;
            return [s.setId, del, vault, status] as const;
          } catch { return [s.setId, false, null, null] as const; }
        }));
        for (const [sid, del, v, st] of entries) {
          deletable[sid] = del;
          vaultIds[sid] = v;
          statusMap[sid] = st;
        }
      }
    }

    const sets2 = sets.map((s) => ({ ...s, vault: vaultIds[s.setId] ?? null }));

    return NextResponse.json({ ok: true, wallet, sets: sets2, deletable, vaultIds, status: statusMap }, { headers: noStoreJsonHeaders() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'internal_error' }, { status: 500, headers: noStoreJsonHeaders() });
  }
}
