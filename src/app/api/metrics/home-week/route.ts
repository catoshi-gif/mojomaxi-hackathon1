// src/app/api/metrics/home-week/route.ts
// Homepage 7d metrics series with ultra-low write frequency and *perpetual retention*.
//
// Goals:
// - Save exactly 1 snapshot per UTC day (running vaults + 24h volume)
// - Retain daily snapshots forever (for MoM/YoY/etc. later)
// - Keep reads cheap (fetch last N days only)
//
// Storage (Upstash Redis):
// - mm:home:daily:last            -> "YYYY-MM-DD" (UTC) last day we wrote
// - mm:home:daily:index           -> ZSET of dates (member = YYYY-MM-DD, score = UTC day start ms)
// - mm:home:daily:bydate:<date>   -> JSON/object row { date, running, vol24h, t }
//
// Back-compat / migration:
// - If an older deployment wrote to LIST mm:home:daily, we migrate the most recent valid rows into the new scheme.
//
// Notes:
// - We reuse existing internal endpoints for correctness:
//    /api/vaults/stats     -> { ok, running, ... }
//    /api/events/volume24h -> { ok, volumeUsd, ... }
//
// Debugging:
// - Add ?debug=1 to include lightweight diagnostics.

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const K_LAST = "mm:home:daily:last";
const K_INDEX = "mm:home:daily:index";
const K_DAY_PREFIX = "mm:home:daily:bydate:";

// Legacy (older builds)
const K_LEGACY_LIST = "mm:home:daily";

type AnyObj = Record<string, any>;
type Row = { date: string; running: number; vol24h: number; t: number };

function clampNumber(n: any): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  return Math.min(x, 1e15);
}

function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function utcDayStartMs(date: string): number {
  // date is YYYY-MM-DD (UTC)
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : Date.now();
}

async function safeJson<T = any>(r: Response): Promise<T | null> {
  try {
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function getInternalToken(): string | null {
  const keys = [
    "X_MM_INTERNAL_TOKEN",
    "MM_INTERNAL_TOKEN",
    "MOJOMAXI_INTERNAL_TOKEN",
    "INTERNAL_SHARED_SECRET",
    "INTERNAL_GATEWAY_SECRET",
  ] as const;
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function fetchInternalJSON(
  req: NextRequest,
  path: string,
  diag?: AnyObj
): Promise<AnyObj | null> {
  const url = new URL(path, req.nextUrl.origin).toString();
  const token = getInternalToken();

  const headers: HeadersInit = token
    ? { "x-mm-internal": "1", "x-mm-internal-token": token }
    : {};

  const r = await fetch(url, { cache: "no-store", headers });
  if (diag) {
    diag._fetch = diag._fetch || {};
    diag._fetch[path] = { ok: r.ok, status: r.status };
  }
  if (!r.ok) return null;
  return await safeJson<AnyObj>(r);
}


// -----------------------------------------------------------------------------
// Running vaults snapshot (Redis-native) — avoids internal HTTP fetch fragility.
//
// Why: /api/vaults/stats is public and works in the browser, but in some Vercel
// cron/server contexts an internal self-fetch can fail (middleware, host routing,
// or platform edge peculiarities). Since both endpoints ultimately read Redis,
// we compute "running" directly from Redis once per day (very cheap at our cadence).
// -----------------------------------------------------------------------------

const REBAL_INDEX = "mm:rebal:index";
const REBAL_PATTERN = "mm:rebal:set:*";

const WH_STATUS_PTRN = "mm:set:*:status";
const WH_RUNNING_INDEX = "mm:webhooks:running:index";

type VaultState = "running" | "paused" | "stopped";

function normState(s: string): VaultState {
  const t = String(s || "").toLowerCase();
  return (t === "running" || t === "paused" || t === "stopped") ? (t as VaultState) : "paused";
}

async function scanAll(pattern: string, count = 500): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | number = "0";
  for (let guard = 0; guard < 2000; guard++) {
    const r = await (redis as any).scan(cursor, { match: pattern, count });
    const next = r?.[0];
    const keys = r?.[1] as string[] | undefined;
    if (Array.isArray(keys) && keys.length) out.push(...keys);
    cursor = next;
    if (String(cursor) === "0") break;
  }
  return out;
}

async function readStatusFromRebalKey(key: string): Promise<VaultState | null> {
  try {
    const doc = await (redis as any).json?.get?.(key).catch(() => null);
    const status = String(doc?.status || doc?.state || "");
    if (status) return normState(status);
  } catch {}
  try {
    // Hash fallback
    const status = await (redis as any).hget?.(key, "status").catch(() => null);
    if (status) return normState(String(status));
  } catch {}
  return null;
}

async function readStatusFromWebhookKey(key: string): Promise<VaultState | null> {
  // webhook status keys are typically hashes (mm:set:<id>:status)
  try {
    const status = await (redis as any).hget?.(key, "status").catch(() => null);
    if (status) return normState(String(status));
  } catch {}
  try {
    // JSON fallback (some deployments may store JSON docs)
    const doc = await (redis as any).json?.get?.(key).catch(() => null);
    const status = String(doc?.status || doc?.state || "");
    if (status) return normState(status);
  } catch {}
  return null;
}

async function getRunningVaultsFromRedis(diag?: AnyObj): Promise<number> {
  let running = 0;

  // Rebalance bots: prefer explicit index if present
  let rebalKeys: string[] = [];
  try {
    const ids = (await (redis as any).smembers?.(REBAL_INDEX).catch(() => [])) as string[];
    if (Array.isArray(ids) && ids.length) {
      rebalKeys = ids.map((id) => `mm:rebal:set:${id}`);
    }
  } catch {}

  if (!rebalKeys.length) {
    rebalKeys = await scanAll(REBAL_PATTERN);
  }

  let rebalRunning = 0;
  for (const k of rebalKeys) {
    const st = await readStatusFromRebalKey(k);
    if (st === "running") rebalRunning++;
  }

  // Webhook bots: scan status keys, but also consult the running index for accuracy
  const whKeys = await scanAll(WH_STATUS_PTRN);
  let whRunningScan = 0;
  for (const k of whKeys) {
    const st = await readStatusFromWebhookKey(k);
    if (st === "running") whRunningScan++;
  }

  const whIndexCount =
    Number(await (redis as any).scard?.(WH_RUNNING_INDEX).catch(() => 0)) || 0;

  const whRunning = Math.max(whRunningScan, whIndexCount);
  running = rebalRunning + whRunning;

  if (diag) {
    diag._running = {
      rebalKeys: rebalKeys.length,
      rebalRunning,
      whKeys: whKeys.length,
      whRunningScan,
      whIndexCount,
      whRunningUsed: whRunning,
    };
  }

  return running;
}
function coerceRow(v: any): Row | null {
  // Upstash can return either JSON strings or decoded objects.
  // Be liberal in what we accept (older deployments used slightly different field names).
  const normalize = (obj: any): Row | null => {
    if (!obj || typeof obj !== "object") return null;
    const date = typeof obj.date === "string" ? String(obj.date) : "";
    if (!date || date.length < 10) return null;

    const runningRaw =
      obj.running ??
      obj.runningVaults ??
      obj.running_vaults ??
      obj.vaultsRunning ??
      obj.vaults_running;

    const volRaw =
      obj.vol24h ??
      obj.vol24 ??
      obj.volume24h ??
      obj.volumeUsd ??
      obj.volUsd ??
      obj.vol_24h;

    const tRaw = obj.t ?? obj.ts ?? obj.timestamp;

    return {
      date,
      running: clampNumber(runningRaw),
      vol24h: clampNumber(volRaw),
      t: clampNumber(tRaw),
    };
  };

  if (v && typeof v === "object") return normalize(v);

  try {
    const s = String(v ?? "");
    if (!s || s[0] !== "{") return null;
    const j = JSON.parse(s);
    return normalize(j);
  } catch {
    return null;
  }
}

async function migrateLegacyIfNeeded(diag: AnyObj): Promise<void> {
  // If the new index is empty but legacy list has rows, migrate the last valid rows.
  const zc = (await (redis as any).zcard(K_INDEX)) as number | null;
  if (Number(zc) > 0) {
    diag.migrated = false;
    diag.zcard = Number(zc) || 0;
    return;
  }

  const legacyRaw = (await (redis as any).lrange(K_LEGACY_LIST, -2000, -1)) as any[];
  diag.legacyCount = Array.isArray(legacyRaw) ? legacyRaw.length : 0;

  if (!Array.isArray(legacyRaw) || legacyRaw.length === 0) {
    diag.migrated = false;
    return;
  }

  const byDate = new Map<string, Row>();
  for (const item of legacyRaw) {
    const row = coerceRow(item);
    if (!row) continue;
    const prev = byDate.get(row.date);
    if (!prev || (row.t || 0) >= (prev.t || 0)) byDate.set(row.date, row);
  }

  const rows = Array.from(byDate.values());
  rows.sort((a, b) => a.date.localeCompare(b.date));

  let wrote = 0;
  for (const r of rows) {
    await (redis as any).set(`${K_DAY_PREFIX}${r.date}`, JSON.stringify(r));
    await (redis as any).zadd(K_INDEX, { score: utcDayStartMs(r.date), member: r.date });
    wrote++;
  }

  diag.migrated = true;
  diag.migratedRows = wrote;

  // Best-effort: set K_LAST to the newest migrated date so we don't double-write in the same UTC day.
  if (rows.length) {
    await (redis as any).set(K_LAST, rows[rows.length - 1].date);
  }
}

async function writeTodayIfNeeded(req: NextRequest, diag: AnyObj): Promise<void> {
  const today = utcDateKey(new Date());
  const last = (await (redis as any).get(K_LAST)) as string | null;
  diag.today = today;
  diag.last = last;

  // Even if we've already written today, we may need to "repair" a missing field
  // (e.g., if one upstream endpoint transiently failed during the first write).
  // We keep this extremely cheap: at most one GET + (optional) one SET.
  const existingRaw = (await (redis as any).get(`${K_DAY_PREFIX}${today}`)) as any;
  const existing = coerceRow(existingRaw);

  const [stats, vol] = await Promise.all([
    ({ ok: true, running: await getRunningVaultsFromRedis(diag) } as any),
    fetchInternalJSON(req, "/api/events/volume24h"),
  ]);

  const statsOk = !!stats?.ok;
  const volOk = !!vol?.ok;


  diag.statsOk = statsOk;
  diag.volOk = volOk;

  const runningNow = statsOk ? clampNumber(stats?.running ?? stats?.runningVaults ?? 0) : NaN;
  const volNow = volOk ? clampNumber(vol?.volumeUsd ?? vol?.vol24h ?? vol?.volUsd ?? 0) : NaN;

  // Prefer newly fetched values when available; otherwise preserve existing.
  const running = Number.isFinite(runningNow) ? runningNow : clampNumber(existing?.running ?? 0);
  const vol24h = Number.isFinite(volNow) ? volNow : clampNumber(existing?.vol24h ?? 0);

  // If we already wrote today and nothing is changing, bail early.
  if (last === today && existing && existing.running === running && existing.vol24h === vol24h) {
    diag.wroteToday = false;
    diag.repaired = false;
    return;
  }

  // Write/repair today's row (perpetual retention)
  const row: Row = { date: today, running, vol24h, t: Date.now() };

  await (redis as any).set(`${K_DAY_PREFIX}${today}`, JSON.stringify(row));
  await (redis as any).zadd(K_INDEX, { score: utcDayStartMs(today), member: today });

  // Only advance the "last written day" pointer when BOTH upstream values are valid.
  // This prevents us from permanently locking in a 0 due to transient upstream failures.
  if (statsOk && volOk) {
    await (redis as any).set(K_LAST, today);
    diag.wroteToday = last !== today;
    diag.repaired = last === today;
  } else {
    diag.wroteToday = last !== today;
    diag.repaired = last === today;
    diag.note = "partial_write_no_last";
  }
}
async function readSeries(diag: AnyObj): Promise<Row[]> {
  // Get last ~60 days of keys (cheap) and then slice to last 35 for response safety.
  const dates = (await (redis as any).zrange(K_INDEX, -60, -1)) as any[];
  diag.indexCount = Array.isArray(dates) ? dates.length : 0;

  if (!Array.isArray(dates) || dates.length === 0) return [];

  const keys = dates.map((d) => `${K_DAY_PREFIX}${String(d)}`);
  const raw = (await (redis as any).mget(...keys)) as any[];

  const rows: Row[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const row = coerceRow(item);
      if (row) rows.push(row);
    }
  }

  // Dedup just in case (should be 1:1 with keys)
  const byDate = new Map<string, Row>();
  for (const r of rows) {
    const prev = byDate.get(r.date);
    if (!prev || (r.t || 0) >= (prev.t || 0)) byDate.set(r.date, r);
  }

  const out = Array.from(byDate.values());
  out.sort((a, b) => a.date.localeCompare(b.date));
  diag.parsedCount = out.length;
  diag.lastParsedDates = out.slice(-10).map((r) => r.date);

  return out.slice(-35);
}

export async function GET(req: NextRequest) {
  const diag: AnyObj = {};
  try {
    await migrateLegacyIfNeeded(diag);
    await writeTodayIfNeeded(req, diag);
    const series = await readSeries(diag);

    const debug = req.nextUrl.searchParams.get("debug") === "1";
    return NextResponse.json(debug ? { ok: true, series, diag } : { ok: true, series }, {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e || "unknown"), diag }, { status: 500 });
  }
}
