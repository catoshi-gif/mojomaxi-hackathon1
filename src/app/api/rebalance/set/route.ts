// filepath: src/app/api/rebalance/set/route.ts
// FULL FILE REPLACEMENT — Pro-aware set create/update with daily limits
// - Preserves legacy API shapes: POST=create/upsert, PATCH=update, DELETE=delete.
// - Storage compatibility: JSON first; Hash and String fallbacks unchanged.
// - Wallet index mirrors maintained.
// - Daily create limit retained.
// - **Pro gating**: Pro can use cadence "1h" and keep Token #1 non‑SOL (order preserved) + up to 20 tokens at vault-create stage.
//   Free users keep SOL-first normalization and the default cadence set.
// - Adds **immutability** for rebalancing mints[] once a vault exists, with **clear allowed only if vault is empty on-chain**.
// - No UI/UX changes.

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { markSetKind } from '@/lib/set-kind';
import { getSubscription } from '@/lib/strategy.store';
import { enforceRebalanceImmutability } from '@/lib/immutability.guard';
import { requireOwnerSession } from "@/lib/auth/guards";
import { redis } from "@/lib/redis";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


// ---- types ----
type Cadence = '1h' | '2h' | '6h' | '12h' | '24h';
type RebalanceSet = {
  id: string;
  wallet: string;
  mints: string[];
  cadence?: Cadence | string | null;
  createdAt: number;
  vaultId?: string | null;
  type: 'rebalance';
};

// ---- constants ----
const KEY_SET = (id: string) => `mm:rebal:set:${id}`;
const KEY_WALLET_SETS = (wallet: string) => `mm:rebal:wallet:${wallet}:sets`;
const KEY_WALLET_SETS_LEGACY = (wallet: string) => `WALLET_REBAL_SETS:${wallet}`;
const KEY_IDEMP = (key: string) => `mm:rebal:idemp:${key}`;
const KEY_CREATE_ZSET = (walletLower: string) => `mm:wallet:${walletLower}:creates`;

const WINDOW_SEC = Number(process.env.MM_CREATES_WINDOW_SEC || 86400);
const CREATE_LIMIT = Number(process.env.MM_MAX_CREATES_PER_24H || 12);

// Rebalancing defaults: Free expects Token A=SOL by convention; Pro may reorder.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CADENCES_PRO = new Set(['1h','2h','6h','12h','24h']);
const CADENCES_FREE = new Set(['2h','6h','12h','24h']);

// ---- helpers ----
function now() { return Date.now(); }

async function isMojoProActive(wallet: string): Promise<boolean> {
  try {
    const sub = await getSubscription('mojo-pro', wallet);
    return !!sub && Number(sub.expiresAt || 0) > Date.now();
  } catch {
    return false;
  }
}

function normalizeWallet(x: any): string {
  const w = String(x || '').trim();
  // Display must remain case-sensitive; indexes use exact wallet string.
  return w;
}
function normalizeId(x: any): string {
  return String(x || '').trim();
}
function toArray(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  return [val];
}
function dedupePreserveOrder(arr: string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const x of arr) {
    if (!x) continue;
    const s = String(x).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function normalizeMints(mints: any, pro: boolean): string[] {
  const arr = toArray(mints).map((m) => String((m && (m.mint || m)) || '').trim()).filter(Boolean);
  let out = dedupePreserveOrder(arr);
  if (pro) {
    // Pro: preserve order as provided by client (cap to 20 at vault-create stage elsewhere).
    return out;
  }
  // Free: ensure SOL present & first
  const withoutSol = out.filter(x => x !== SOL_MINT);
  out = [SOL_MINT, ...withoutSol];
  return out;
}
function parseCadence(x: any, pro: boolean): Cadence | undefined {
  if (x == null) return undefined;
  const s = String(x || '').trim() as Cadence;
  return (pro ? CADENCES_PRO : CADENCES_FREE).has(s) ? s : undefined;
}
function uuidLike() {
  try { const u = (globalThis as any)?.crypto?.randomUUID?.(); if (u) return u; } catch {}
  return 'rb_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---- storage helpers (JSON first, Hash & String fallbacks) ----
async function loadSet(id: string): Promise<RebalanceSet | null> {
  if (!id) return null;
  const k = KEY_SET(id);
  // JSON first
  try {
    const j = await (redis as any).json.get(k);
    if (j && typeof j === 'object' && (j as any).id) {
      const jj = j as any;
      const mints: string[] = Array.isArray(jj.mints) ? jj.mints.map((s:any)=>String(s||'').trim()).filter(Boolean) : [];
      const cadence = typeof jj.cadence === 'string' ? jj.cadence : undefined;
      const createdAt = Number(jj.createdAt ?? 0) || now();
      const wallet = String(jj.wallet || '').trim();
      const vaultId = (jj.vaultId ?? null) || null;
      return { id, wallet, mints, cadence, createdAt, vaultId, type: 'rebalance' };
    }
  } catch {}
  // Hash fallback
  try {
    const h = await (redis as any).hgetall(k);
    if (h && Object.keys(h).length) {
      const wallet = String((h as any).wallet || '').trim();
      let mints: string[] = [];
      try {
        const raw = (h as any).mints;
        if (Array.isArray(raw)) mints = raw as string[];
        else if (typeof raw === 'string' && raw.startsWith('[')) mints = JSON.parse(raw);
      } catch {}
      const cadence = (() => { const s = String((h as any).cadence ?? '').trim(); return s ? s : undefined; })();
      const createdAt = Number((h as any).createdAt || 0) || now();
      const vaultId = String((h as any).vaultId ?? '').trim() || null;
      return { id, wallet, mints, cadence, createdAt, vaultId, type: 'rebalance' };
    }
  } catch {}
  // String fallback (very old): JSON blob in GET
  try {
    const s = await (redis as any).get(k);
    if (typeof s === 'string' && s.trim().startsWith('{')) {
      const j = JSON.parse(s);
      if (j && j.id) return j as RebalanceSet;
    }
  } catch {}
  return null;
}

async function saveSet(doc: RebalanceSet): Promise<void> {
  const k = KEY_SET(doc.id);
  const payload: RebalanceSet = { ...doc, type: 'rebalance' };
  // JSON
  try { await (redis as any).json.set(k, '$', payload); } catch {}
  // Hash mirror
  try {
    await (redis as any).hset(k, {
      id: doc.id,
      wallet: doc.wallet,
      mints: JSON.stringify(doc.mints || []),
      cadence: doc.cadence ?? '',
      createdAt: String(doc.createdAt || now()),
      vaultId: doc.vaultId ?? '',
      type: 'rebalance',
    });
  } catch {}
  // Tag meta
  try { await markSetKind(doc.id, 'rebalance'); } catch {}
}

async function safeAddToWalletIndex(wallet: string, id: string): Promise<void> {
  const idx = KEY_WALLET_SETS(wallet);
  // Detect and migrate index to SET
  let typ = 'none';
  try { typ = await (redis as any).type(idx); } catch {}
  if (typ === 'set') {
    await (redis as any).sadd(idx, id);
  } else if (typ === 'string') {
    // convert JSON-stringified array -> set
    let members: string[] = [];
    try {
      const prior = await (redis as any).get(idx);
      if (typeof prior === 'string' && prior.length) {
        try {
          const arr = JSON.parse(prior);
          if (Array.isArray(arr)) members = arr.map((x:any)=>String(x||'').trim()).filter(Boolean);
        } catch {}
      }
    } catch {}
    try { await (redis as any).del(idx); } catch {}
    if (members.length) { try { await (redis as any).sadd(idx, ...members); } catch {} }
    await (redis as any).sadd(idx, id);
  } else if (typ === 'list') {
    let members: string[] = [];
    try {
      const l = await (redis as any).lrange(idx, 0, -1);
      if (Array.isArray(l)) members = l.map((x:any)=>String(x||'').trim()).filter(Boolean);
    } catch {}
    try { await (redis as any).del(idx); } catch {}
    if (members.length) { try { await (redis as any).sadd(idx, ...members); } catch {} }
    await (redis as any).sadd(idx, id);
  } else {
    // Unknown type: try to salvage
    try {
      const s = await (redis as any).smembers(idx);
      if (Array.isArray(s) && s.length) {
        await (redis as any).del(idx);
        await (redis as any).sadd(idx, ...s);
      }
    } catch {}
    try {
      const l = await (redis as any).lrange(idx, 0, -1);
      if (Array.isArray(l) && l.length) {
        await (redis as any).del(idx);
        await (redis as any).sadd(idx, ...l);
      }
    } catch {}
    await (redis as any).sadd(idx, id);
  }
  // Mirror to legacy
  try { await (redis as any).sadd(KEY_WALLET_SETS_LEGACY(wallet), id); } catch {}
}

async function removeFromWalletIndex(wallet: string, id: string) {
  try { await (redis as any).srem(KEY_WALLET_SETS(wallet), id); } catch {}
  try { await (redis as any).srem(KEY_WALLET_SETS_LEGACY(wallet), id); } catch {}
}

// ---- idempotency helpers ----
async function getIdemSetId(idemKey: string): Promise<string | null> {
  try {
    const v = await (redis as any).get(KEY_IDEMP(idemKey));
    return v ? String(v) : null;
  } catch { return null; }
}
async function setIdem(idemKey: string, setId: string) {
  try { await (redis as any).set(KEY_IDEMP(idemKey), setId, { ex: WINDOW_SEC }); } catch {}
}

// ---- daily limit helpers ----
async function pruneAndCountCreates(walletLower: string): Promise<number> {
  const key = KEY_CREATE_ZSET(walletLower);
  const nowMs = now();
  const min = 0;
  const maxExpired = nowMs - WINDOW_SEC * 1000;
  try { await (redis as any).zremrangebyscore(key, min, maxExpired); } catch {}
  try {
    const n = await (redis as any).zcard(key);
    return typeof n === 'number' ? n : (Array.isArray(n) ? n.length : Number(n || 0));
  } catch {
    try {
      const a = await (redis as any).zrange(key, 0, -1);
      return Array.isArray(a) ? a.length : Number(a || 0);
    } catch { return 0; }
  }
}
async function commitCreateEvent(walletLower: string, memberHint?: string) {
  const key = KEY_CREATE_ZSET(walletLower);
  const score = now();
  const member = memberHint || `${score}:${Math.random().toString(36).slice(2)}`;
  try { await (redis as any).zadd(key, { score, member }); } catch {}
}

// ---- handlers ----
export async function POST(req: NextRequest) {
  const guard = await requireOwnerSession(req as any);
  if (guard.ok === false) return guard.res;

  try {
    const body = await req.json().catch(() => ({} as any));
    const wallet = normalizeWallet(body?.wallet || req.headers.get('x-wallet'));
    if (!wallet) return NextResponse.json({ ok: false, error: 'missing wallet' }, { status: 400 });

    const pro = await isMojoProActive(wallet);

    // Idempotency: if we already mapped this key, return the prior set.
    const idemKey = (req.headers.get('x-idempotency-key') || '').trim();
    if (idemKey) {
      const prevId = await getIdemSetId(idemKey);
      if (prevId) {
        const prev = await loadSet(prevId);
        if (prev) return NextResponse.json({ ok: true, set: prev, id: prev.id }, { status: 200 });
      }
    }

    const idFromBody = normalizeId(body?.id || body?.setId);
    const incomingMints = Array.isArray(body?.mints) ? body.mints :
                          (Array.isArray(body?.tokens) ? body.tokens : undefined);
    const cadence = parseCadence(body?.cadence || body?.freqHours, pro);

    // IMMUTABILITY GUARD (POST upsert): if an id was provided and the set already has a vault,
    // and the request includes mints[], reject or allow clear-if-empty.
    if (idFromBody) {
      const existing = await loadSet(idFromBody);
      if (existing && existing.vaultId && Array.isArray(incomingMints)) {
        const guard = await enforceRebalanceImmutability({ setId: idFromBody, incomingMints });
        if (guard.ok === false) {
          return NextResponse.json({ ok: false, error: guard.reason || 'immutable_mints_array', canonical: guard.canonical, vault: guard.vault }, { status: guard.status || 409 });
        }
        if ((guard as any).allowClear) {
          const next: RebalanceSet = { ...existing, mints: [] };
          await saveSet(next);
          try { if (guard.vault) await (redis as any).del(`mm:vaultmints:${guard.vault}`); } catch {}
          // idempotency record still stands; return cleared doc
          if (idemKey) await setIdem(idemKey, next.id);
          await safeAddToWalletIndex(wallet, next.id);
          return NextResponse.json({ ok: true, set: next, id: next.id, cleared: true }, { status: 200 });
        }
      }
    }

    // If this is an upsert (existing id), do not consume create quota.
    if (idFromBody) {
      const existing = await loadSet(idFromBody);
      if (existing) {
        const frozen = !!existing.vaultId;
        const next: RebalanceSet = { ...existing };
        if (!frozen && Array.isArray(incomingMints)) {
          const nm = normalizeMints(incomingMints, pro);
          if (!pro && nm[0] !== SOL_MINT) {
            return NextResponse.json({ ok: false, error: 'Token A must be SOL for rebalancing' }, { status: 400 });
          }
          next.mints = nm;
        }
        if (!frozen && typeof cadence !== 'undefined') next.cadence = cadence;
        if (!next.createdAt) next.createdAt = now();
        next.type = 'rebalance';
        await saveSet(next);
        await safeAddToWalletIndex(wallet, next.id);
        if (idemKey) await setIdem(idemKey, next.id);
        return NextResponse.json({ ok: true, set: next, id: next.id }, { status: 200 });
      }
      // No existing: this path is a true create with provided id -> apply create limit.
      const walletLower = wallet.toLowerCase();
      const count = await pruneAndCountCreates(walletLower);
      if (count >= CREATE_LIMIT) {
        return NextResponse.json(
          { ok: false, error: 'daily_create_limit_exceeded', limit: CREATE_LIMIT, remaining: 0, windowSeconds: WINDOW_SEC },
          { status: 429 },
        );
      }
      const nm = Array.isArray(incomingMints) ? normalizeMints(incomingMints, pro) : [SOL_MINT, USDC_MINT];
      if (!pro && nm[0] !== SOL_MINT) {
        return NextResponse.json({ ok: false, error: 'Token A must be SOL for rebalancing' }, { status: 400 });
      }
      const doc: RebalanceSet = { id: idFromBody, wallet, mints: nm, cadence, createdAt: now(), vaultId: null, type: 'rebalance' };
      await saveSet(doc);
      await safeAddToWalletIndex(wallet, doc.id);
      await commitCreateEvent(walletLower, `${doc.createdAt}:${doc.id}`);
      if (idemKey) await setIdem(idemKey, doc.id);
      return NextResponse.json({ ok: true, set: doc, id: doc.id }, { status: 200 });
    }

    // Create new id (no id provided) -> applies create limit.
    const walletLower = wallet.toLowerCase();
    const count = await pruneAndCountCreates(walletLower);
    if (count >= CREATE_LIMIT) {
      return NextResponse.json(
        { ok: false, error: 'daily_create_limit_exceeded', limit: CREATE_LIMIT, remaining: 0, windowSeconds: WINDOW_SEC },
        { status: 429 },
      );
    }
    const nm = Array.isArray(incomingMints) ? normalizeMints(incomingMints, pro) : [SOL_MINT, USDC_MINT];
    if (!pro && nm[0] !== SOL_MINT) {
      return NextResponse.json({ ok: false, error: 'Token A must be SOL for rebalancing' }, { status: 400 });
    }
    const id = uuidLike();
    const doc: RebalanceSet = { id, wallet, mints: nm, cadence, createdAt: now(), vaultId: null, type: 'rebalance' };
    await saveSet(doc);
    await safeAddToWalletIndex(wallet, doc.id);
    await commitCreateEvent(walletLower, `${doc.createdAt}:${doc.id}`);
    if (idemKey) await setIdem(idemKey, doc.id);
    return NextResponse.json({ ok: true, set: doc, id }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'internal error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireOwnerSession(req as any);
  if (guard.ok === false) return guard.res;

  try {
    const body = await req.json().catch(() => ({} as any));
    const wallet = normalizeWallet(body?.wallet || req.headers.get('x-wallet'));
    const id = normalizeId(body?.id || body?.setId);
    if (!wallet || !id) return NextResponse.json({ ok: false, error: 'missing wallet or id' }, { status: 400 });

    const pro = await isMojoProActive(wallet);
    const existing = await loadSet(id);
    if (!existing) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

    const frozen = !!existing.vaultId;

    // IMMUTABILITY GUARD (PATCH): reject attempts to change mints[] when a vault exists
    const incomingMints = Array.isArray(body?.mints) ? body.mints :
                          (Array.isArray(body?.tokens) ? body.tokens : undefined);
    if (Array.isArray(incomingMints)) {
      const guard = await enforceRebalanceImmutability({ setId: id, incomingMints });
      if (guard.ok === false) {
        return NextResponse.json({ ok: false, error: guard.reason || 'immutable_mints_array', canonical: guard.canonical, vault: guard.vault }, { status: guard.status || 409 });
      }
      if ((guard as any).allowClear) {
        const next: RebalanceSet = { ...existing, mints: [] };
        await saveSet(next);
        try { if (guard.vault) await (redis as any).del(`mm:vaultmints:${guard.vault}`); } catch {}
        await safeAddToWalletIndex(wallet, id);
        return NextResponse.json({ ok: true, set: next, id, cleared: true }, { status: 200 });
      }
    }

    const next: RebalanceSet = { ...existing };

    if (!frozen && Array.isArray(incomingMints)) {
      const nm = normalizeMints(incomingMints, pro);
      if (!pro && nm[0] !== SOL_MINT) {
        return NextResponse.json({ ok: false, error: 'Token A must be SOL for rebalancing' }, { status: 400 });
      }
      next.mints = nm;
    }
    const cadence = parseCadence(body?.cadence || body?.freqHours, pro);
    if (!frozen && typeof cadence !== 'undefined') next.cadence = cadence;

    await saveSet(next);
    await safeAddToWalletIndex(wallet, id);
    return NextResponse.json({ ok: true, set: next, id }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'internal error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireOwnerSession(req as any);
  if (guard.ok === false) return guard.res;

  try {
    const body = await req.json().catch(() => ({} as any));
    const wallet = normalizeWallet(body?.wallet || req.headers.get('x-wallet'));
    const id = normalizeId(body?.id || body?.setId);
    if (!wallet || !id) return NextResponse.json({ ok: false, error: 'missing wallet or id' }, { status: 400 });

    try { await (redis as any).del(KEY_SET(id)); } catch {}
    try { await removeFromWalletIndex(wallet, id); } catch {}

    return NextResponse.json({ ok: true, id }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'internal error' }, { status: 500 });
  }
}
