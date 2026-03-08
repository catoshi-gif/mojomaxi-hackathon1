// filepath: src/lib/swap-queue.server.ts
// Durable swap rescue queue (Upstash Redis) for high-concurrency reliability.
// - Additive: does not change existing swap behavior unless a caller chooses to enqueue.
// - Used as a safety net when synchronous swap execution fails under load.
//
// Keys:
//  - mm:swapjobs:due (ZSET) score=nextRunAtMs, member=jobId
//  - mm:swapjob:{jobId} (JSON record)
//  - mm:swapjob:lease:{jobId} (ephemeral lock to prevent double-processing)
//
// NOTE: Wallet addresses are case sensitive; we never lowercase owner / vault / set ids.

import "server-only";

type AnyObj = Record<string, any>;

export type SwapJobStatus = "queued" | "running" | "succeeded" | "dead";

export type SwapJobRecord = {
  jobId: string;
  status: SwapJobStatus;

  // the API endpoint to call (relative path, starting with /api/...)
  endpoint: string;

  // payload to POST
  payload: AnyObj;

  // when to run next
  nextRunAt: number; // ms epoch

  // attempts + last result
  attempt: number;
  createdAt: number;
  updatedAt: number;

  // optional metadata for locks / observability
  setId?: string;
  ownerWallet?: string;

  // last call status/result
  lastStatus?: number;
  lastResult?: any;
  lastError?: string;

  // original trigger timing for downstream activity/PnL coherence
  requestedAt?: number;

  // success info
  sig?: string;
  txUrl?: string;
};

export type ProcessSwapJobsResult = {
  ok: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  rescheduled: number;
  dead: number;
  notes?: string[];
};

const KEY_DUE = "mm:swapjobs:due";
const KEY_DONE = "mm:swapjobs:done"; // ZSET score=completedAtMs, member=jobId (succeeded/dead)
const KEY_PRUNE_LOCK = "mm:swapjobs:prune:lock";
const KEY_JOB = (jobId: string) => `mm:swapjob:${jobId}`;
const KEY_LEASE = (jobId: string) => `mm:swapjob:lease:${jobId}`;

function safeStr(x: any): string {
  return typeof x === "string" ? x : String(x ?? "");
}

function nowMs() {
  return Date.now();
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function randId(len = 18) {
  const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

function baseDelayMs(attempt: number) {
  // exponential backoff with cap + jitter
  const base = 1_500; // 1.5s
  const cap = 120_000; // 2m
  const pow = Math.min(10, Math.max(0, attempt)); // cap exponent
  const d = Math.min(cap, base * Math.pow(2, pow));
  const jitter = Math.floor(Math.random() * 1_000);
  return d + jitter;
}

function buildInternalHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const cron = safeStr(process.env.CRON_SECRET || "").trim();
  if (cron) h["authorization"] = `Bearer ${cron}`;

  const bypass = safeStr(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass) h["x-vercel-protection-bypass"] = bypass;

  return h;
}

async function inferOriginFromEnv(): Promise<string> {
  const env = safeStr(process.env.NEXT_PUBLIC_SITE_URL || "").trim();
  if (env) return env.replace(/\/$/, "");
  // best effort; Vercel provides VERCEL_URL without scheme
  const vercel = safeStr(process.env.VERCEL_URL || "").trim();
  if (vercel) return `https://${vercel}`.replace(/\/$/, "");
  return "http://localhost:3000";
}


async function acquireKickLease(): Promise<boolean> {
  try {
    const ttlMs = Number(process.env.MM_SWAP_WORKER_KICK_COOLDOWN_MS || 3_000);
    const ok = await (redis as any).set("mm:swapworker:kick", String(Date.now()), { nx: true, px: ttlMs });
    return !!ok;
  } catch {
    return false;
  }
}

export async function kickSwapWorker(opts?: { maxJobs?: number }): Promise<boolean> {
  const gotLease = await acquireKickLease();
  if (!gotLease) return false;

  try {
    const origin = await inferOriginFromEnv();
    const headers = {
      ...buildInternalHeaders(),
      "x-mm-worker-kick": "1",
    };
    const maxJobs = clamp(Number(opts?.maxJobs ?? 1), 1, 10);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Number(process.env.MM_SWAP_WORKER_KICK_TIMEOUT_MS || 1_500));
    try {
      const resp = await fetch(`${origin}/api/internal/worker/swaps?max=${maxJobs}`, {
        method: "POST",
        headers,
        signal: controller.signal,
      });
      return resp.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

function parseJSONMaybe(txt: string) {
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function extractMsg(result: any): string {
  if (typeof result === "string") return result;
  return safeStr(result?.error || result?.message || result?.reason || result?.diag || "");
}

function stableFingerprint(rec: SwapJobRecord): string {
  try {
    const payload = (rec as any)?.payload || {};
    const base = {
      endpoint: safeStr((rec as any)?.endpoint || ""),
      setId: safeStr((rec as any)?.setId || ""),
      ownerWallet: safeStr((rec as any)?.ownerWallet || ""),
      inputMint: safeStr(payload?.inputMint || payload?.inMint || payload?.mintIn || ""),
      outputMint: safeStr(payload?.outputMint || payload?.outMint || payload?.mintOut || ""),
      // Include a few knobs that can change route/accounting constraints
      maxAccounts: payload?.maxAccounts ?? payload?.routeHints?.maxAccounts ?? undefined,
      excludeDexes: payload?.excludeDexes ?? payload?.routeHints?.excludeDexes ?? undefined,
      // If caller includes an explicit route fingerprint, include it
      route: payload?.route ?? payload?.routeId ?? payload?.jupiterRouteId ?? undefined,
    };
    const raw = JSON.stringify(base);
    // lightweight hash to keep key short
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = (h * 31 + raw.charCodeAt(i)) >>> 0;
    }
    return h.toString(16);
  } catch {
    return randId(10);
  }
}

const KEY_CIRCUIT = (fp: string) => `mm:swap:circuit:${fp}`;

async function isCircuitOpen(fp: string): Promise<boolean> {
  try {
    const v = await (redis as any).get(KEY_CIRCUIT(fp));
    return !!v;
  } catch {
    return false;
  }
}

async function openCircuit(fp: string, ttlSec: number, note: string) {
  try {
    const key = KEY_CIRCUIT(fp);
    await (redis as any).set(key, note || "1");
    // Use expire for compatibility across Upstash clients
    await (redis as any).expire(key, ttlSec);
  } catch {
    // best effort
  }
}

function isTerminalSwapError(result: any): boolean {
  const msg = safeStr(extractMsg(result)).toLowerCase();
  if (!msg) return false;

  // Internal typed errors
  if (msg.includes("tx_too_large")) return true;
  if (msg.includes("tx too large")) return true;
  if (msg.includes("encoding overruns")) return true;
  if (msg.includes("packet") && msg.includes("too large")) return true;

  // "Literally not possible" / structural constraints
  if (msg.includes("transaction too large")) return true;
  if (msg.includes("tx too large")) return true;
  if (msg.includes("too many account")) return true;
  if (msg.includes("account keys")) return true;
  if (msg.includes("exceeds max")) return true;
  if (msg.includes("max accounts")) return true;
  if (msg.includes("address table") && msg.includes("full")) return true;
  if (msg.includes("insufficient") && msg.includes("accounts")) return true;

  // no route / quote situations (terminal after retries; handled outside)
  if (msg.includes("no route")) return true;
  if (msg.includes("no quote")) return true;
  if (msg.includes("route not found")) return true;

  return false;
}

function looksRetriable(status: number, result: any, attempt: number): boolean {
  // Network / fetch layer
  if (status === 0) return true;
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;

  const msg = safeStr(extractMsg(result)).toLowerCase();
  if (!msg) return false;

  // Transient-ish
  if (msg.includes("timeout") || msg.includes("timed out")) return true;
  if (msg.includes("blockhash") && msg.includes("not found")) return true;
  if (msg.includes("blockhash") && msg.includes("expired")) return true;
  if (msg.includes("node is behind")) return true;
  if (msg.includes("429")) return true;

  // slippage exceeded is often transient
  if (msg.includes("slippage")) return true;

  // "no route" can sometimes be transient if jup is warming caches; retry a couple times
  if (msg.includes("no route") || msg.includes("no quote") || msg.includes("route not found")) {
    return attempt < 2;
  }

  // insufficient funds might become true later (deposit comes in); retry a few times
  if (msg.includes("insufficient funds")) {
    return attempt < 3;
  }

  return false;
}

export function classifySwapRetryDisposition(status: number, result: any, attempt = 0) {
  const nextAttempt = Math.max(1, Number(attempt || 0) + 1);
  const terminal = isTerminalSwapError(result);
  const retryable = !terminal && looksRetriable(status, result, nextAttempt);
  return { terminal, retryable, nextAttempt };
}


// ---- Redis client ----
// P0: Use shared singleton from @/lib/redis to avoid connection exhaustion under burst.

import { redis } from "@/lib/redis";

// Compatibility: Upstash Redis client versions differ; some provide zrangebyscore,
// newer ones prefer zrange with byScore options. We support both.
async function zrangeByScoreMembers(key: string, min: number, max: number, count: number): Promise<string[]> {
  const r: any = redis as any;

  if (typeof r.zrangebyscore === "function") {
    // ioredis-like
    const out = await r.zrangebyscore(key, min, max, { limit: { offset: 0, count } });
    return (out || []).map((x: any) => safeStr(x));
  }

  if (typeof r.zrangeByScore === "function") {
    // some clients use camelCase
    const out = await r.zrangeByScore(key, min, max, { offset: 0, count });
    return (out || []).map((x: any) => safeStr(x));
  }

  if (typeof r.zrange === "function") {
    // Upstash @upstash/redis supports zrange with byScore
    const out = await r.zrange(key, min, max, { byScore: true, offset: 0, count });
    return (out || []).map((x: any) => safeStr(x));
  }

  throw new Error("Redis client missing ZRANGEBYSCORE/ZRANGE(byScore) support");
}

async function zaddDue(jobId: string, whenMs: number) {
  // zadd signature varies slightly; Upstash supports zadd(key, { score, member })
  await (redis as any).zadd(KEY_DUE, { score: whenMs, member: jobId });
}

async function zremDue(jobId: string) {
  await redis.zrem(KEY_DUE, jobId);
}

// ---- Job primitives ----

export async function updateSwapJob(jobId: string, patch: Partial<SwapJobRecord>): Promise<void> {
  const prev = await getSwapJob(jobId);
  const next: SwapJobRecord = {
    ...(prev || ({
      jobId,
      status: "queued",
      endpoint: "",
      payload: {},
      nextRunAt: 0,
      attempt: 0,
      createdAt: nowMs(),
      updatedAt: nowMs(),
    } as SwapJobRecord)),
    ...patch,
    updatedAt: nowMs(),
  };

  await redis.set(KEY_JOB(jobId), JSON.stringify(next));

  // Retention indexing: track terminal jobs in a done ZSET so we can prune without SCAN.
  if (next.status === "succeeded" || next.status === "dead") {
    try {
      await (redis as any).zadd(KEY_DONE, { score: next.updatedAt || nowMs(), member: jobId });
    } catch {
      // best effort
    }
  }

}

export async function getSwapJob(jobId: string): Promise<SwapJobRecord | null> {
  const raw = await redis.get<string>(KEY_JOB(jobId));
  if (!raw) return null;
  if (typeof raw === "string") return (parseJSONMaybe(raw) as SwapJobRecord) || null;
  // @upstash/redis sometimes parses JSON itself
  if (typeof raw === "object") return raw as any;
  return null;
}

async function acquireLease(jobId: string, ms: number): Promise<boolean> {
  const ok = await (redis as any).set(KEY_LEASE(jobId), "1", { nx: true, px: ms });
  return !!ok;
}

async function releaseLease(jobId: string) {
  try {
    await redis.del(KEY_LEASE(jobId));
  } catch {}
}


function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquirePruneLock(ms: number): Promise<boolean> {
  try {
    const ok = await (redis as any).set(KEY_PRUNE_LOCK, "1", { nx: true, px: ms });
    return !!ok;
  } catch {
    return false;
  }
}

async function releasePruneLock() {
  try {
    await redis.del(KEY_PRUNE_LOCK);
  } catch {}
}

export async function pruneSwapJobs(opts?: {
  retentionDays?: number;
  batchSize?: number;
  maxDelete?: number;
  lockMs?: number;
}): Promise<{ ok: true; deleted: number; scanned: number; skipped?: boolean } | { ok: false; error: string }> {
  const retentionDays = clamp(Number(opts?.retentionDays ?? 14), 1, 90);
  const batchSize = clamp(Number(opts?.batchSize ?? 200), 25, 500);
  const maxDelete = clamp(Number(opts?.maxDelete ?? 800), 50, 5000);
  const lockMs = clamp(Number(opts?.lockMs ?? 30_000), 5_000, 120_000);

  const got = await acquirePruneLock(lockMs);
  if (!got) return { ok: true, deleted: 0, scanned: 0, skipped: true };

  const cutoff = nowMs() - retentionDays * 24 * 60 * 60 * 1000;

  let deleted = 0;
  let scanned = 0;

  try {
    while (deleted < maxDelete) {
      const take = Math.min(batchSize, maxDelete - deleted);
      const jobIds = await zrangeByScoreMembers(KEY_DONE, 0, cutoff, take);
      if (!jobIds.length) break;

      scanned += jobIds.length;

      const pipe = (redis as any).pipeline?.();
      if (pipe && typeof pipe.exec === "function") {
        for (const id of jobIds) {
          pipe.del(KEY_JOB(id));
          pipe.del(KEY_LEASE(id));
          pipe.zrem(KEY_DUE, id);
          pipe.zrem(KEY_DONE, id);
        }
        await pipe.exec();
      } else {
        for (const id of jobIds) {
          await redis.del(KEY_JOB(id));
          await redis.del(KEY_LEASE(id));
          await redis.zrem(KEY_DUE, id);
          await redis.zrem(KEY_DONE, id);
        }
      }

      deleted += jobIds.length;

      // tiny yield under very large deletes
      if (jobIds.length >= batchSize) await sleep(2);
    }

    return { ok: true, deleted, scanned };
  } catch (e: any) {
    return { ok: false, error: safeStr(e?.message || e) };
  } finally {
    await releasePruneLock();
  }
}


async function reschedule(jobId: string, whenMs: number, patch?: Partial<SwapJobRecord>) {
  await updateSwapJob(jobId, {
    status: "queued",
    nextRunAt: whenMs,
    ...(patch || {}),
  });
  await zaddDue(jobId, whenMs);
}

// Backwards-compatible enqueue input:
// - New callers should use { endpoint, payload, ... }.
// - Older route overlays may still call { execPath, body, ... }.
// - Some callers include extra metadata fields (vault/kind/clientRef/etc). We accept and ignore them.
// Accepting extra fields is a TYPE-LEVEL compatibility shim only; stored job schema remains stable.

export type EnqueueSwapJobInputV2 = {
  endpoint: string;
  payload: AnyObj;
  setId?: string;
  ownerWallet?: string;
  nextRunAtMs?: number;

  // Optional metadata (ignored by queue, but commonly present in callers).
  vault?: string;
  kind?: string;
  clientRef?: string;

  // Allow additional metadata keys without breaking TS callers.
  [k: string]: any;
};

export type EnqueueSwapJobInputLegacy = {
  execPath: string;
  body: AnyObj;
  setId?: string;
  ownerWallet?: string;
  nextRunAtMs?: number;

  // Optional metadata (ignored by queue, but commonly present in callers).
  vault?: string;
  kind?: string;
  clientRef?: string;

  // Allow additional metadata keys without breaking TS callers.
  [k: string]: any;
};

export async function enqueueSwapJob(
  input: EnqueueSwapJobInputV2 | EnqueueSwapJobInputLegacy
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  const url = safeStr(process.env.UPSTASH_REDIS_REST_URL || "").trim();
  const tok = safeStr(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !tok) {
    return { ok: false, error: "Missing UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN" };
  }

  // Normalize legacy shape -> v2 shape
  const endpoint = safeStr((input as any).endpoint || (input as any).execPath || "").trim();
  const payload = ((input as any).payload ?? (input as any).body ?? {}) as AnyObj;

  if (!endpoint.startsWith("/api/")) return { ok: false, error: "endpoint must start with /api/" };

  const jobId = `job_${randId(22)}`;
  const t = nowMs();

  // Best-effort maintenance: prune old terminal jobs occasionally.
  if (Math.random() < 0.02) {
    pruneSwapJobs({ maxDelete: 300 }).catch(() => {});
  }

  const whenMs = Math.max(t, Number((input as any).nextRunAtMs ?? t));

  const rec: SwapJobRecord = {
    jobId,
    status: "queued",
    endpoint,
    payload: payload || {},
    nextRunAt: whenMs,
    attempt: 0,
    createdAt: t,
    updatedAt: t,
    requestedAt: Math.max(0, Number((input as any).requestedAtMs ?? t)),
    setId: (input as any).setId ? safeStr((input as any).setId) : undefined,
    ownerWallet: (input as any).ownerWallet ? safeStr((input as any).ownerWallet) : undefined,
  };

  // Perf 1.5: pipeline multi-op enqueue to reduce Redis RTT under load.
  const pipe = (redis as any).pipeline?.();
  if (pipe && typeof pipe.exec === "function") {
    pipe.set(KEY_JOB(jobId), JSON.stringify(rec));
    // zadd: KEY_DUE score member
    pipe.zadd(KEY_DUE, { score: whenMs, member: jobId });
    await pipe.exec();
  } else {
    await redis.set(KEY_JOB(jobId), JSON.stringify(rec));
    await zaddDue(jobId, whenMs);
  }



  // Best-effort maintenance: prune very old terminal jobs occasionally to prevent slow Redis growth.
  // This is intentionally non-blocking; pruning is guarded by a short Redis lock.
  if (Math.random() < 0.01) {
    pruneSwapJobs({ maxDelete: 400 }).catch(() => {});
  }
  return { ok: true, jobId };
}

// ---- Worker ----

export async function processSwapJobs(opts?: { maxJobs?: number }): Promise<ProcessSwapJobsResult> {
  const maxJobs = clamp(Number(opts?.maxJobs ?? 10), 1, 50);
  const t = nowMs();

  // Pull more than maxJobs to account for lease collisions.
  const candidates = await zrangeByScoreMembers(KEY_DUE, 0, t, maxJobs * 3);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let rescheduledCount = 0;
  let dead = 0;
  const notes: string[] = [];

  if (!candidates.length) {
    return { ok: true, processed: 0, succeeded: 0, failed: 0, rescheduled: 0, dead: 0 };
  }

  const origin = await inferOriginFromEnv();
  const headers = buildInternalHeaders();

  for (const jobId of candidates) {
    if (processed >= maxJobs) break;

    // Attempt to lease the job to avoid double-processing.
    const leased = await acquireLease(jobId, 90_000);
    if (!leased) continue;

    const rec = await getSwapJob(jobId);
    if (!rec) {
      await zremDue(jobId);
      await releaseLease(jobId);
      continue;
    }

    // Circuit breaker: if we already hit a known structural/terminal constraint for this route,
    // avoid draining relayer funds by repeatedly attempting.
    const fp = stableFingerprint(rec);
    if (await isCircuitOpen(fp)) {
      dead++;
      notes.push(`circuit:${jobId}`);
      await updateSwapJob(jobId, {
        status: "dead",
        lastStatus: rec.lastStatus ?? 0,
        lastResult: rec.lastResult ?? null,
        lastError: "circuit_open",
        updatedAt: nowMs(),
      });
      await zremDue(jobId);
      await releaseLease(jobId);
      continue;
    }

    // Remove from due set now; re-add if we reschedule.
    await zremDue(jobId);

    processed++;

    const attempt = Number(rec.attempt || 0);
    await updateSwapJob(jobId, { status: "running", attempt: attempt + 1 });

    const endpoint = safeStr(rec.endpoint);
    const url = `${origin}${endpoint}`;

    let status = 0;
    let parsed: any = null;
    let errMsg = "";

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "x-mm-swap-job-id": jobId,
          "x-mm-original-requested-at": String(rec.requestedAt || rec.createdAt || nowMs()),
        },
        body: JSON.stringify(rec.payload || {}),
      });
      status = resp.status;
      const txt = await resp.text();
      parsed = parseJSONMaybe(txt) ?? txt;

      const ok = typeof parsed === "object" && parsed && parsed.ok === true;
      if (ok) {
        succeeded++;
        await updateSwapJob(jobId, {
          status: "succeeded",
          lastStatus: status,
          lastResult: parsed,
          sig: safeStr(parsed?.sig || parsed?.signature || ""),
          txUrl: safeStr(parsed?.txUrl || ""),
        });
        await releaseLease(jobId);
        continue;
      }

      // Determine retry vs dead
      const nextAttempt = attempt + 1;
      const terminal = isTerminalSwapError(parsed);
      if (terminal) {
        // Open a circuit for structurally impossible routes to avoid draining relayer funds.
        const fp2 = stableFingerprint(rec);
        await openCircuit(fp2, 6 * 60 * 60, safeStr(extractMsg(parsed)).slice(0, 200));
      }
      const retryable = !terminal && looksRetriable(status, parsed, nextAttempt);

      if (retryable && nextAttempt <= 12) {
        failed++;
        const whenMs = nowMs() + baseDelayMs(nextAttempt);
        rescheduledCount++;
        await reschedule(jobId, whenMs, {
          lastStatus: status,
          lastResult: parsed,
          lastError: "",
        });
        notes.push(`retry:${jobId}`);
        await releaseLease(jobId);
        continue;
      }

      // dead letter
      dead++;
      errMsg = terminal ? "terminal swap error" : "max attempts exceeded";
      await updateSwapJob(jobId, {
        status: "dead",
        lastStatus: status,
        lastError: errMsg,
        lastResult: parsed,
        nextRunAt: 0,
      });
      notes.push(`dead:${jobId}`);
      await releaseLease(jobId);
    } catch (e: any) {
      failed++;
      errMsg = safeStr(e?.message || e);


      // If we threw on a structural/terminal condition, do not keep retrying.
      if (isTerminalSwapError({ error: errMsg, detail: errMsg, message: errMsg })) {
        const fp3 = stableFingerprint(rec);
        await openCircuit(fp3, 6 * 60 * 60, errMsg.slice(0, 200));
        dead++;
        await updateSwapJob(jobId, {
          status: "dead",
          lastStatus: 0,
          lastError: errMsg,
          nextRunAt: 0,
        });
        notes.push(`dead:${jobId}`);
        await releaseLease(jobId);
        continue;
      }

      const nextAttempt = attempt + 1;
      const whenMs = nowMs() + baseDelayMs(nextAttempt);

      if (nextAttempt <= 12) {
        rescheduledCount++;
        await reschedule(jobId, whenMs, {
          lastStatus: 0,
          lastError: errMsg,
        });
        notes.push(`retry:${jobId}`);
        await releaseLease(jobId);
        continue;
      }

      dead++;
      await updateSwapJob(jobId, {
        status: "dead",
        lastStatus: 0,
        lastError: errMsg,
        nextRunAt: 0,
      });
      notes.push(`dead:${jobId}`);
      await releaseLease(jobId);
    }
  }

  return {
    ok: true,
    processed,
    succeeded,
    failed,
    rescheduled: rescheduledCount,
    dead,
    notes: notes.length ? notes : undefined,
  };
}
