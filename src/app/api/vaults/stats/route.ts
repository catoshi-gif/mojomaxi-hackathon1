// src/app/api/vaults/stats/route.ts
// Faster "running vaults" counter with multi-layer caching and index-aware reads.
// - Keeps response shape identical: { ok, running, paused, stopped, total }
// - Prefers compact indexes (mm:rebal:index for rebal bots; cached status key list for webhook bots)
// - Falls back to SCAN when needed, but only once every 5 minutes (cached key list)

import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";


type AnyObj = Record<string, any>;
type State = "running" | "paused" | "stopped";

const STATS_CACHE_KEY = "mm:cache:vaults:stats";
const KEYS_CACHE_KEY  = "mm:cache:vaults:status_keys";
const STATS_TTL_MS = 30_000;   // users want freshness
const KEYS_TTL_MS  = 5 * 60_000; // scan at most once every 5 minutes

const REBAL_INDEX   = "mm:rebal:index";        // maintained by /api/rebalance/start|stop
const REBAL_PATTERN = "mm:rebal:set:*";        // safety fallback for old sets
const WH_STATUS_PTRN= "mm:set:*:status";       // webhook-bot status keys
const WH_RUNNING_INDEX = "mm:webhooks:running:index"; // running webhook-bot setIds (maintained by /api/vaults/status)

async function getJson<T=any>(key: string): Promise<T | null> {
  try {
    const raw = await (redis as any).get(key);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) as T : (raw as T);
  } catch { return null; }
}
async function setJson(key: string, v: any, ttlMs: number) {
  try {
    await (redis as any).set(key, JSON.stringify({ t: Date.now(), v }), { ex: Math.ceil(ttlMs / 1000) });
  } catch {}
}

async function cachedStats(): Promise<AnyObj | null> {
  const j = await getJson(STATS_CACHE_KEY);
  if (!j) return null;
  if (Number(Date.now() - Number(j.t || 0)) < STATS_TTL_MS) return j.v as AnyObj;
  return null;
}

async function cachedStatusKeys(): Promise<string[] | null> {
  const j = await getJson(KEYS_CACHE_KEY);
  if (!j) return null;
  if (Number(Date.now() - Number(j.t || 0)) < KEYS_TTL_MS) return (Array.isArray(j.v) ? j.v : []) as string[];
  return null;
}

async function scanAll(pattern: string): Promise<string[]> {
  let cursor = 0;
  const out: string[] = [];
  for (let i=0; i<1000; i++) {
    const res: any = await (redis as any).scan(cursor, { match: pattern, count: 200 }).catch(() => null);
    if (!res) break;
    // Upstash returns [cursor, keys[]]
    cursor = Number(res?.[0] ?? res?.cursor ?? 0);
    const keys: string[] = Array.isArray(res?.[1]) ? res[1] : Array.isArray(res?.keys) ? res.keys : [];
    if (keys?.length) out.push(...keys);
    if (!cursor) break;
  }
  return out;
}

function normState(s: unknown): State {
  const t = String(s || "").toLowerCase();
  return (t === "running" || t === "paused" || t === "stopped") ? (t as State) : "paused";
}

export async function GET(_req: NextRequest) {
  try {
    // 1) Fast path: cached numbers
    const cached = await cachedStats();
    if (cached) return NextResponse.json({ ok: true, ...cached });

    let running = 0, paused = 0, stopped = 0;

    // 2) Rebalance bots — prefer index
    const rebalIds: string[] = (await (redis as any).smembers(REBAL_INDEX).catch(() => [])) as string[];
    const rebalKeys = rebalIds.length ? rebalIds.map((id) => `mm:rebal:set:${id}`) : await scanAll(REBAL_PATTERN);

    // Read status for each rebal set.
    // Rebalance sets are written by savePatch() which uses json.set() (Upstash JSON type) as the
    // primary path, falling back to plain redis.set() for older keys.
    // IMPORTANT: Upstash REST client returns NULL when you call get() or hgetall() on a JSON-type
    // key — you MUST use json.get() to read them. This was the root cause of the undercount.
    //
    // Strategy: fire json.get() AND get() in parallel for every key (one round-trip total),
    // then read status from whichever returns data. hgetall is NOT used here since it also
    // returns null on JSON-type keys.
    if (rebalKeys.length) {
      const [jsonResults, getResults] = await Promise.all([
        Promise.all(rebalKeys.map((k) =>
          (redis as any).json?.get?.(k).catch(() => null) as Promise<AnyObj | null>
        )),
        Promise.all(rebalKeys.map((k) =>
          (redis as any).get?.(k).catch(() => null) as Promise<any>
        )),
      ]);

      for (let i = 0; i < rebalKeys.length; i++) {
        try {
          // json.get() result — covers all sets written by current savePatch()
          const jsonDoc: AnyObj | null = jsonResults[i] ?? null;
          const jsonStatus = String(jsonDoc?.status || jsonDoc?.state || '');

          // get() result — covers sets written by legacy plain SET path
          const raw: any = getResults[i] ?? null;
          let rawStatus = '';
          if (raw) {
            const parsed = typeof raw === 'string'
              ? (() => { try { return JSON.parse(raw); } catch { return null; } })()
              : (typeof raw === 'object' ? raw : null);
            rawStatus = String(parsed?.status || parsed?.state || '');
          }

          const status = jsonStatus || rawStatus;
          const s = normState(status || 'stopped');
          if (s === 'running') running++; else if (s === 'paused') paused++; else stopped++;
        } catch {}
      }
    }

    // 3) Webhook + strategy-style bots — states in mm:set:*:status
    // We keep SCAN-key caching but read each hash individually for robustness.
    let whKeys = await cachedStatusKeys();
    if (!whKeys) {
      whKeys = await scanAll(WH_STATUS_PTRN);
      await setJson(KEYS_CACHE_KEY, whKeys, KEYS_TTL_MS);
    }

    // Running webhook-bot index (cheap). When SCAN/hgetall undercounts, this keeps the homepage "Running Vaults" accurate.
    const whIndexCount = Number(await (redis as any).scard?.(WH_RUNNING_INDEX).catch(() => 0)) || 0;
    let whRunning = 0, whPaused = 0, whStopped = 0;

    if (whKeys.length) {
      // Batch all hgetall calls in parallel — one round-trip instead of N sequential calls.
      const whHgetallResults = await Promise.all(
        whKeys.map((key) => (redis as any).hgetall?.(key).catch(() => null) as Promise<AnyObj | null>)
      );

      // Fire-and-forget pipeline for running index updates so they never block the response.
      const indexUpdatePipe = (redis as any).pipeline?.() || null;

      for (let i = 0; i < whKeys.length; i++) {
        const key = whKeys[i];
        try {
          const row: AnyObj | null = whHgetallResults[i] ?? null;
          let val: unknown = row && (row.state ?? (row as any).status);

          // Fallback: some very old sets stored state directly on mm:set:<setId>
          if (!val) {
            const prefix = "mm:set:";
            const suffix = ":status";
            if (key.startsWith(prefix) && key.endsWith(suffix)) {
              const setId = key.slice(prefix.length, key.length - suffix.length);
              try {
                const legacyState = await (redis as any)
                  .hget?.(`mm:set:${setId}`, "state")
                  .catch(() => null);
                if (legacyState) val = legacyState;
              } catch {
                // ignore legacy errors
              }
            }
          }

          const ns = normState(val);
          if (ns === "running") whRunning++;
          else if (ns === "paused") whPaused++;
          else whStopped++;

          // Best-effort: keep the running index warm (batched, never blocks response).
          try {
            const prefix = "mm:set:";
            const suffix = ":status";
            if (indexUpdatePipe && key.startsWith(prefix) && key.endsWith(suffix)) {
              const sid = key.slice(prefix.length, key.length - suffix.length);
              if (ns === "running") indexUpdatePipe.sadd(WH_RUNNING_INDEX, sid);
              else indexUpdatePipe.srem(WH_RUNNING_INDEX, sid);
            }
          } catch {
            /* best-effort */
          }

        } catch {
          // best-effort only; ignore per-key errors
        }
      }

      // Execute the index update pipeline in the background.
      if (indexUpdatePipe && typeof indexUpdatePipe.exec === 'function') {
        indexUpdatePipe.exec().catch(() => null);
      }
    }


    // Fold webhook counts into totals. Prefer the running index if it indicates more running bots than our scan path found.
    const whRunningFinal = whIndexCount > 0 ? Math.max(whRunning, whIndexCount) : whRunning;
    running += whRunningFinal;
    paused  += whPaused;
    stopped += whStopped;

    const payload = { running, paused, stopped, total: running + paused + stopped };
    await setJson(STATS_CACHE_KEY, payload, STATS_TTL_MS);
    return NextResponse.json({ ok: true, ...payload });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "stats_error" }, { status: 500 });
  }
}
