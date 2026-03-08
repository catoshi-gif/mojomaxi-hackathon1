// filepath: src/app/api/vaults/execute-swap/route.ts
// Runtime: nodejs
// PURPOSE: Execute a vault swap **after** verifying the set is RUNNING and
//          ensuring Authority ATAs for both input/output mints (idempotent).
// Notes:
//  • Preserves request/response shapes and behavior.
//  • No UI/UX or route path changes (Golden Rule respected).
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";


import { classifySwapRetryDisposition, enqueueSwapJob, kickSwapWorker } from "@/lib/swap-queue.server";
import { redis } from "@/lib/redis";

type AnyObj = Record<string, any>;
function json(status: number, body: AnyObj) {
  return NextResponse.json(body, { status });
}

function safeStr(v: any, max = 140): string {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function isInternal(req: NextRequest): boolean {
  const auth = String(req.headers.get("authorization") || "").trim();
  const cron = (process.env.CRON_SECRET || "").trim();
  if (cron && auth === `Bearer ${cron}`) return true;

  const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (
    bypass &&
    String(req.headers.get("x-vercel-protection-bypass") || "").trim() === bypass
  ) {
    return true;
  }
  return false;
}


function isWorkerRetry(req: NextRequest): boolean {
  return !!String(req.headers.get("x-mm-swap-job-id") || "").trim();
}

function isQueueEnabled(): boolean {
  const raw = safeStr(process.env.MM_SWAP_QUEUE_ENABLED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function syncRetryCountFromEnv(): number {
  const n = Number(process.env.MM_SWAP_SYNC_RETRIES || 2);
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(3, Math.floor(n)));
}

function syncRetryDelayMs(attempt: number): number {
  const base = 350;
  return Math.min(1800, base * Math.max(1, attempt) + Math.floor(Math.random() * 220));
}

function originalRequestedAt(req: NextRequest): number {
  const raw = Number(req.headers.get("x-mm-original-requested-at") || 0);
  return Number.isFinite(raw) && raw > 0 ? raw : Date.now();
}

function lockWaitMsFromEnv(): number {
  const n = Number(process.env.MM_SWAP_LOCK_WAIT_MS || 3_500);
  if (!Number.isFinite(n)) return 1_200;
  return Math.max(150, Math.min(5_000, Math.floor(n)));
}

function lockLeaseMsFromEnv(): number {
  const n = Number(process.env.MM_SWAP_LOCK_LEASE_MS || 90_000);
  if (!Number.isFinite(n)) return 90_000;
  return Math.max(15_000, Math.min(180_000, Math.floor(n)));
}

// ---------------- swap concurrency locks (Redis) ----------------
async function acquireLock(key: string, ms: number): Promise<boolean> {
  try {
    const ok = await (redis as any).set(key, "1", { nx: true, px: ms });
    return !!ok;
  } catch {
    return false;
  }
}
async function releaseLock(key: string) {
  try {
    await (redis as any).del(key);
  } catch {}
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitForLock(
  key: string,
  totalMs: number,
  leaseMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await acquireLock(key, leaseMs)) return true;
    const left = totalMs - (Date.now() - start);
    const step = Math.min(450, Math.max(125, Math.floor(left / 8)));
    await sleep(step + Math.floor(Math.random() * 120));
  }
  return false;
}

// ---------- Types & helpers ----------
type SwapInput = {
  ownerPubkey: string; // wallet that created the set (kept for compat)
  ownerWallet?: string; // alias; some callers use this name
  setId: string;
  inputMint: string;
  outputMint: string;
  amountInAtoms: string; // stringified integer
  slippageBps?: number;
  setKind?: "webhook" | "rebalance" | string; // optional; defaults to 'webhook'
  // Note: other fields may be present but are ignored here (we pass through as any to executor)
};

function normalizeBody(raw: AnyObj | null | undefined): SwapInput | null {
  const b = raw || {};
  const ownerPubkey = String(b.ownerPubkey ?? b.owner ?? b.ownerWallet ?? "").trim();
  const ownerWallet = String(b.ownerWallet ?? b.ownerPubkey ?? b.owner ?? "").trim();
  const setId = String(b.setId ?? b.set ?? "").trim();
  const inputMint = String(
    b.inputMint ?? b.input ?? b.mintIn ?? b.mint_in ?? ""
  ).trim();
  const outputMint = String(
    b.outputMint ?? b.output ?? b.mintOut ?? b.mint_out ?? ""
  ).trim();
  const amtRaw = b.amountInAtoms ?? b.amount ?? b.atoms ?? null;
  const amountInAtoms = amtRaw != null ? String(amtRaw) : "";
  const slippageBps =
    typeof b.slippageBps === "number"
      ? b.slippageBps
      : typeof b.slippage_bps === "number"
      ? b.slippage_bps
      : undefined;
  const setKind =
    typeof b.setKind === "string" && b.setKind ? b.setKind : undefined;

  if (!ownerPubkey || !setId || !inputMint || !outputMint || !amountInAtoms)
    return null;

  return {
    ownerPubkey,
    ownerWallet: ownerWallet || ownerPubkey,
    setId,
    inputMint,
    outputMint,
    amountInAtoms,
    slippageBps,
    setKind,
  };
}

// ---------- RUNNING guard (Upstash) ----------
async function isSetRunning(setId: string): Promise<boolean> {
  if (!setId) return false;
  try {
    // Primary key (current)
    const key = `mm:set:${setId}:status`;
    const state = await redis
      .hget<string>(key as any, "state")
      .catch(() => null);
    if (String(state || "").toLowerCase() === "running") return true;

    // Legacy fallback (older storage)
    const legacy = await redis
      .hget<string>(`mm:set:${setId}` as any, "state")
      .catch(() => null);
    if (String(legacy || "").toLowerCase() === "running") return true;

    // Developer override (local debug only — never in production)
    if (process.env.NODE_ENV !== "production") {
      if (String(process.env.DEBUG_SWAP_DIAG || "").toLowerCase() === "true")
        return true;
      if (String(process.env.MM_FORCE_RUNNING || "").trim() === "1") return true;
    }
  } catch {
    // Fail-closed on errors (treat as not running)
  }
  return false;
}

// ---------- Best-effort ATA ensure (idempotent) ----------
async function ensureAtasForSet(setId: string, mints: string[]): Promise<void> {
  const uniq = Array.from(new Set((mints || []).filter(Boolean)));
  if (!uniq.length) return;

  // Prefer direct helper if present (our overlay)
  try {
    const mod = await import("@/lib/vault-atas.server").catch(
      () => null as any
    );
    if (mod && typeof mod.ensureVaultAuthorityAtas === "function") {
      await mod
        .ensureVaultAuthorityAtas({ setId, mints: uniq })
        .catch(() => {});
      return;
    }
  } catch {}

  // Fallback path for older golden: require derived vault authority + generic ensure
  try {
    const mod = await import("@/lib/vault-atas.server").catch(
      () => null as any
    );
    const prog = await import("@/lib/program.server").catch(
      () => null as any
    );
    const vsdk = await import("@/lib/vault-sdk").catch(() => null as any);

    const deriveVaultAuthority = async (): Promise<string | null> => {
      try {
        const { PublicKey } = await import("@solana/web3.js");
        const relStr =
          (process.env.RELAYER_PUBKEY as string) ||
          (process.env.NEXT_PUBLIC_VAULT_ADMIN as string) ||
          "";
        if (!relStr) return null;
        const adminPk = new PublicKey(relStr);

        const setBytes =
          vsdk && typeof vsdk.uuidToBytes16 === "function"
            ? vsdk.uuidToBytes16(setId)
            : Uint8Array.from(
                Buffer.from(String(setId).replace(/-/g, ""), "hex")
              );

        const vaultPk = prog?.deriveVaultPda ? prog.deriveVaultPda(adminPk, setBytes) : null;
        const authPk =
          vaultPk && prog?.deriveVaultAuthorityPda
            ? prog.deriveVaultAuthorityPda(vaultPk)
            : null;
        return authPk ? authPk.toBase58() : null;
      } catch {
        return null;
      }
    };

    if (mod && typeof mod.ensureVaultAtasForMints === "function") {
      const auth = await deriveVaultAuthority();
      if (auth) {
        await mod
          .ensureVaultAtasForMints({
            wallet: "owner-unknown",
            vault: auth,
            mints: uniq,
          })
          .catch(() => {});
      }
    }
  } catch {
    // Swallow; executeSwapCPI.server also has in-swap guards for ATAs.
  }
}

// ---------- Handler ----------
export async function POST(req: NextRequest) {
  // Internal-only vault swap executor.
  // Must be invoked from trusted server routes that supply CRON_SECRET
  // and/or VERCEL_AUTOMATION_BYPASS_SECRET.
  if (!isInternal(req)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const raw = await req.json().catch(() => ({} as AnyObj));
  const body = normalizeBody(raw);
  if (!body) return json(400, { ok: false, error: "invalid_body" });

  // 1) Guard: only execute when vault is RUNNING (webhook-bot path)
  const running = await isSetRunning(body.setId);
  if (!running) {
    return json(200, {
      ok: false,
      error: "vault_not_running",
      detail: "Set status is not 'running' — swap skipped.",
    });
  }

  // 2) Safety net: ensure Authority ATAs for input/output mints
  await ensureAtasForSet(body.setId, [body.inputMint, body.outputMint]).catch(
    () => {}
  );

  // Burst-safety: serialize swaps per set + (best-effort) per owner to reduce collisions under load.
  const lockLeaseMs = lockLeaseMsFromEnv();
  const lockWaitMs = lockWaitMsFromEnv();
  const ownerKey = String(body.ownerWallet || body.ownerPubkey || "").trim();

  const lockKeys: string[] = [];
  if (body.setId) lockKeys.push(`mm:swaplock:set:${String(body.setId)}`);
  lockKeys.sort();

  for (const k of lockKeys) {
    const ok = await waitForLock(k, lockWaitMs, lockLeaseMs);
    if (!ok) {
      if (isWorkerRetry(req)) {
        return json(429, {
          ok: false,
          error: "busy",
          message: "Swap executor is busy; worker will retry.",
        });
      }

      const queueEnabled = isQueueEnabled();
      const job = queueEnabled
        ? await enqueueSwapJob({
            execPath: "/api/vaults/execute-swap",
            body: raw || body,
            ownerWallet: ownerKey,
            setId: String(body.setId || ""),
            vault: String((raw as any)?.vault || (raw as any)?.vaultAuthority || ""),
            kind: safeStr(body.setKind || (raw as any)?.clientRef || "swap"),
            clientRef: safeStr((raw as any)?.clientRef || ""),
            requestedAtMs: originalRequestedAt(req),
          }).catch(() => null)
        : null;
      if (job?.ok) kickSwapWorker({ maxJobs: 1 }).catch(() => {});

      return json(429, {
        ok: false,
        error: "busy",
        message: job?.ok ? "Swap executor is busy; queued for immediate retry." : "Swap executor is busy; try again momentarily.",
        queued: !!job?.ok,
        jobId: job?.ok ? job.jobId : undefined,
      });
    }
  }

  try {
    // 3) Execute swap via Jupiter Pro CPI
    const executeSwapFromVault = (await import("@/lib/executeSwapCPI.server")).default;

    let res: AnyObj | null = null;
    const maxSyncRetries = isWorkerRetry(req) ? 0 : syncRetryCountFromEnv();

    for (let attempt = 0; attempt <= maxSyncRetries; attempt++) {
      res = await executeSwapFromVault({
        ...body,
        setKind: body.setKind || "webhook",
      } as any);

      const ok = !!(res && (res as any).ok !== false);
      if (ok) break;

      const disposition = classifySwapRetryDisposition(500, res, attempt);
      if (!disposition.retryable || attempt >= maxSyncRetries) break;
      await sleep(syncRetryDelayMs(attempt + 1));
    }

    const ok = !!(res && (res as any).ok !== false);
    if (!ok) {
      const disposition = classifySwapRetryDisposition(500, res, maxSyncRetries);
      const queueEnabled = isQueueEnabled();
      if (disposition.retryable && !isWorkerRetry(req) && queueEnabled) {
        const job = await enqueueSwapJob({
          execPath: "/api/vaults/execute-swap",
          body: raw || body,
          ownerWallet: ownerKey,
          setId: String(body.setId || ""),
          vault: String((raw as any)?.vault || (raw as any)?.vaultAuthority || ""),
          kind: safeStr(body.setKind || (raw as any)?.clientRef || "swap"),
          clientRef: safeStr((raw as any)?.clientRef || ""),
          requestedAtMs: originalRequestedAt(req),
        }).catch(() => null);
        if (job?.ok) kickSwapWorker({ maxJobs: 1 }).catch(() => {});

        return json(500, {
          ...(((res as AnyObj) || { ok: false, error: "swap_failed" }) as AnyObj),
          queued: !!job?.ok,
          jobId: job?.ok ? job.jobId : undefined,
        });
      }

      return json(500, {
        ...(((res as AnyObj) || { ok: false, error: disposition.terminal ? "swap_failed_terminal" : "swap_failed" }) as AnyObj),
      });
    }

    return json(200, (res as AnyObj) || { ok: true });
  } catch (e: any) {
    const disposition = classifySwapRetryDisposition(0, { error: e?.message || "swap_error" }, 0);
    if (disposition.retryable && !isWorkerRetry(req) && isQueueEnabled()) {
      const job = await enqueueSwapJob({
        execPath: "/api/vaults/execute-swap",
        body: raw || body,
        ownerWallet: ownerKey,
        setId: String(body.setId || ""),
        vault: String((raw as any)?.vault || (raw as any)?.vaultAuthority || ""),
        kind: safeStr(body.setKind || (raw as any)?.clientRef || "swap"),
        clientRef: safeStr((raw as any)?.clientRef || ""),
        requestedAtMs: originalRequestedAt(req),
      }).catch(() => null);
      if (job?.ok) kickSwapWorker({ maxJobs: 1 }).catch(() => {});

      return json(500, {
        ok: false,
        error: e?.message || "swap_error",
        queued: !!job?.ok,
        jobId: job?.ok ? job.jobId : undefined,
      });
    }

    return json(500, {
      ok: false,
      error: e?.message || "swap_error",
    });
  } finally {
    try {
      for (const k of lockKeys) await releaseLock(k);
    } catch {}
  }
}
