// src/lib/events.ts
import { createHash } from "crypto";
import { redis } from "./redis";

// Retain up to N items per list
const MAX_EVENTS = Number.parseInt(process.env.MM_SET_EVENTS_MAX || "", 10) || 200;

export type ActivityEvent = {
  id: string;
  setId: string;
  path: string;      // canonical pathname only (no host/query), no trailing slash except "/"
  kind: string;      // canonical UPPERCASED kind: BUY/SELL/...
  source?: string;
  ok?: boolean;
  error?: string | null;
  t?: number;        // ms since epoch (alias: ts)
  ts?: number;       // ms since epoch
  tx?: string | null;
  txUrl?: string | null;
  wallet?: string;
  amount?: number;
  price?: number | null;
  mint?: string;
  note?: string | null;
  ingestId?: string | null;
  setIdCanonical?: string | null;
  feeBps?: number;
  feeChargedUi?: number;
  pnl?: number | null;
};

const lw = (s: string) => (s || "").toLowerCase();
const uw = (s: string) => (s || "").toUpperCase();

function normalizeKind(kind: string): "BUY" | "SELL" | string {
  const k = uw(kind || "");
  if (k.includes("BUY")) return "BUY";
  if (k.includes("SELL")) return "SELL";
  return k;
}

function normalizePath(raw: string): string {
  const s = String(raw || "");
  try {
    const url = new URL(s, "https://dummy.local");
    let pathname = url.pathname || "/";
    if (pathname !== "/" && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return pathname;
  } catch {
    let pathname = s || "/";
    if (!pathname.startsWith("/")) pathname = "/" + pathname;
    if (pathname !== "/" && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return pathname;
  }
}

function dedupeSetKey(setId: string, kindCanon: string, pathCanon: string, tsMs: number) {
  const secondBucket = Math.floor(tsMs / 1000);
  const h = createHash("sha1").update(`${setId}|${kindCanon}|${pathCanon}|${secondBucket}`).digest("hex");
  return `mm:events:dedupe:${h}`;
}
function listKeyV2(setId: string) { return `mm:set:${setId}:recent`; }
function listKeyV1(setId: string) { return `mm:events:${setId}`; }

function walletDedupeKey(wallet: string, kindCanon: string, tsMs: number) {
  const secondBucket = Math.floor(tsMs / 1000);
  const h = createHash("sha1").update(`${wallet}|${kindCanon}|${secondBucket}`).digest("hex");
  return `mm:wallet:events:dedupe:${h}`;
}
function walletListKey(wallet: string) { return `mm:wallet:${wallet}:events`; }

/** Push to the set activity feed (writes both new and legacy keys); idempotent within a 1s bucket. */
export async function pushRecentEvent(
  setId: string,
  rawPath: string,
  meta: Omit<ActivityEvent, "id" | "setId" | "path" | "ts" | "t"> & { ts?: number; t?: number }
): Promise<{ ok: true; deduped: boolean; id: string }> {
  const ts = Number(meta.ts ?? meta.t ?? Date.now());
  const kindCanon = normalizeKind((meta as any).kind || "");
  const pathCanon = normalizePath(rawPath);
  const id = createHash("sha1")
    .update(`${setId}|${kindCanon}|${pathCanon}|${ts}|${JSON.stringify(meta)}`)
    .digest("hex");

  const v2 = listKeyV2(setId);
  const v1 = listKeyV1(setId);
  const payload: ActivityEvent = {
    id,
    setId,
    path: pathCanon,
    kind: kindCanon,
    ok: (meta as any).ok,
    error: (meta as any).error ?? null,
    tx: (meta as any).tx ?? null,
    txUrl: (meta as any).txUrl ?? null,
    source: (meta as any).source,
    wallet: (meta as any).wallet,
    amount: (meta as any).amount,
    price: (meta as any).price ?? null,
    mint: (meta as any).mint,
    note: (meta as any).note ?? null,
    ingestId: (meta as any).ingestId ?? null,
    setIdCanonical: (meta as any).setIdCanonical ?? null,
    feeBps: (meta as any).feeBps,
    feeChargedUi: (meta as any).feeChargedUi,
    pnl: (meta as any).pnl ?? null,
    ts,
    t: ts,
  };

  const dedupeKey = dedupeSetKey(setId, kindCanon, pathCanon, ts);
  const wasNew = await redis.set(dedupeKey, "1", { nx: true, ex: 2 }).catch(() => null);
  const deduped = wasNew !== "OK";

  await Promise.all([
    redis.lpush(v2, JSON.stringify(payload)).catch(() => null),
    redis.lpush(v1, JSON.stringify(payload)).catch(() => null),
  ]);
  if (MAX_EVENTS > 0) {
    await Promise.all([
      redis.ltrim(v2, 0, MAX_EVENTS - 1).catch(() => null),
      redis.ltrim(v1, 0, MAX_EVENTS - 1).catch(() => null),
    ]);
  }

  if (payload.wallet) {
    const wKey = walletListKey(lw(payload.wallet));
    const wDedupe = walletDedupeKey(lw(payload.wallet), kindCanon, ts);
    await redis.set(wDedupe, "1", { nx: true, ex: 2 }).catch(() => null);
    await redis.lpush(wKey, JSON.stringify(payload)).catch(() => null);
    if (MAX_EVENTS > 0) await redis.ltrim(wKey, 0, MAX_EVENTS - 1).catch(() => null);
  }

  return { ok: true as const, deduped, id };
}

/** Read recent set events (prefers new key, falls back to legacy). */
export async function getRecentEvents(setId: string, limit = 50): Promise<ActivityEvent[]> {
  const rows1 = (await redis.lrange(listKeyV2(setId), 0, Math.max(0, limit - 1))) as string[];
  const rows = rows1?.length ? rows1 : ((await redis.lrange(listKeyV1(setId), 0, Math.max(0, limit - 1))) as string[]);
  const out: ActivityEvent[] = [];
  for (const r of rows || []) {
    try {
      const e = JSON.parse(r) as ActivityEvent;
      e.kind = normalizeKind(e.kind);
      e.path = normalizePath(e.path);
      out.push(e);
    } catch {}
  }
  return out;
}

// ---- Back-compat exports (do not remove) ----
export async function appendRecentEvent(setId: string, path: string, meta: any) {
  return pushRecentEvent(setId, path, meta);
}
export async function getRecentSetEvents(setId: string, limit = 50) {
  return getRecentEvents(setId, limit);
}
/** Legacy name expected by some API routes */
export async function appendEvent(setId: string, path: string, meta: any) {
  return pushRecentEvent(setId, path, meta);
}
