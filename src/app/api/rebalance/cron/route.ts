
// filepath: src/app/api/rebalance/cron/route.ts
// Robust cron runner that triggers /api/rebalance/rebalance-now for due sets.
// == DO NOT CHANGE UI/UX ==
// Behavior preserved; additive fixes only:
//  - Resolve owner wallet from the set doc.
//  - Pass that wallet BOTH as `x-wallet` header (case‑sensitive) and as `wallet` in the JSON body.
//  - Forward `x-set-id` header to help downstream logging.
//  - Forward Authorization / internal bypass headers when present.

import 'server-only';
import { redis } from "@/lib/redis";
import { NextRequest, NextResponse } from 'next/server';
import { isTrustedInternalRequest } from '@/lib/auth/internal';

function isInternal(req: NextRequest): boolean {
  return isTrustedInternalRequest(req);
}


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';




async function acquireCronLock(): Promise<boolean> {
  try {
    const ok = await (redis as any).set("mm:cron:rebalance:lock", String(Date.now()), { nx: true, px: 110000 });
    return !!ok;
  } catch {
    return false;
  }
}

// --- keys (kept consistent with other routes) ---
const INDEX_KEY = 'mm:rebal:index';
const KEY       = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_OLD   = (setId: string) => `REBAL_SET:${setId}`;

type AnyObj = Record<string, any>;

function nowMs() { return Date.now(); }

// Infer origin for server-to-self fetches
function inferOrigin(req: NextRequest): string {
  try {
    const url = new URL(req.url);
    if (url.origin && url.origin !== 'null') return url.origin;
  } catch {}
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL || '';
  if (envUrl) return envUrl.startsWith('http') ? envUrl : `https://${envUrl}`;
  return 'http://localhost:3000';
}

// Build internal headers and forward WAF/preview bypasses
function buildInternalHeaders(req: NextRequest, wallet: string, setId: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-wallet': wallet,                 // case-sensitive, never lowercase
    'x-set-id': setId,
  };
  try {
    const auth =
      req.headers.get('authorization') ||
      (process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : '') ||
      '';
    if (auth) h['authorization'] = auth;
  } catch {}
  try {
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
    if (bypass) h['x-vercel-protection-bypass'] = bypass;
  } catch {}
  try {
    const token = process.env.X_MM_INTERNAL_TOKEN || process.env.INTERNAL_FETCH_TOKEN || '';
    if (token) h['x-mm-internal-token'] = token;
  } catch {}
  // Optional Cloudflare Zero Trust service auth
  try {
    const cid  = process.env.CF_ACCESS_CLIENT_ID;
    const csec = process.env.CF_ACCESS_CLIENT_SECRET;
    const svc  = process.env.CF_ACCESS_SERVICE_TOKEN;
    if (cid && csec) {
      h['CF-Access-Client-Id'] = cid;
      h['CF-Access-Client-Secret'] = csec;
    } else if (svc) {
      h['Authorization'] = `Bearer ${svc}`;
    }
  } catch {}
  return h;
}

async function getJSON(redisKey: string): Promise<AnyObj | null> {
  try {
    const j = await (redis as any).json?.get?.(redisKey);
    if (j && typeof j === 'object') return j as AnyObj;
  } catch {}
  try {
    const raw = await redis.get<string>(redisKey as any);
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
      try { return JSON.parse(raw) as AnyObj; } catch {}
    }
  } catch {}
  try {
    const h = await redis.hgetall<Record<string, any>>(redisKey as any);
    if (h && Object.keys(h).length) return h as AnyObj;
  } catch {}
  return null;
}

async function loadSet(setId: string): Promise<AnyObj | null> {
  return (await getJSON(KEY(setId))) || (await getJSON(KEY_OLD(setId)));
}

async function handle(req: NextRequest) {
  try {
    const gotLock = await acquireCronLock();
    if (!gotLock) return NextResponse.json({ ok: true, skipped: true });

    // 1) Enumerate candidate sets
    let setIds: string[] = [];
    try {
      const s = await redis.smembers<string[]>(INDEX_KEY as any);
      if (Array.isArray(s)) setIds = s.filter(Boolean).map(String);
    } catch {}
    // No sets to process
    if (!setIds.length) return NextResponse.json({ ok: true, checked: 0, due: 0, triggered: 0, details: [] });

    // 2) Evaluate due sets
    const now = nowMs();
    const details: AnyObj[] = [];
    let checked = 0, due = 0, triggered = 0;
    for (const setId of setIds) {
      checked++;
      const doc = await loadSet(setId);
      if (!doc) { details.push({ setId, status: 'missing' }); continue; }
      const nextAt = Number(doc?.nextRebalanceAt ?? doc?.next_rebalance_at ?? 0);
      const wallet = String(doc?.wallet || doc?.owner || doc?.walletAddress || '').trim();
      if (!wallet) { details.push({ setId, status: 'no_wallet' }); continue; }
      if (!Number.isFinite(nextAt) || nextAt <= 0) { details.push({ setId, status: 'no_schedule' }); continue; }
      if (now < nextAt) { details.push({ setId, status: 'not_due', nextAt }); continue; }
      due++;

      // 3) Trigger rebalancing atomically (one set at a time here)
      try {
        const origin = inferOrigin(req);
        const res = await fetch(new URL('/api/rebalance/rebalance-now', origin), {
          method: 'POST',
          headers: buildInternalHeaders(req, wallet, setId),
          body: JSON.stringify({ setId, wallet }),
          cache: 'no-store',
        });
        const j = await res.json().catch(() => ({} as any));
        const ok = !!(res.ok && (j as any)?.ok);
        details.push({ setId, triggered: ok, status: ok ? 'ok' : 'failed', http: res.status, error: ok ? null : (j as any)?.error || (j as any)?.reason || null });
        if (ok) triggered++;
      } catch (e: any) {
        details.push({ setId, triggered: false, status: 'error', error: String(e?.message || e) });
      }
    }

    return NextResponse.json({ ok: true, checked, due, triggered, details });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!isInternal(req)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
 return handle(req); }
export async function POST(req: NextRequest) {
  if (!isInternal(req)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
 return handle(req); }
