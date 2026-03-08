// filepath: src/app/api/rebalance/execute-swap/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { applyMojoPointsFromEvent } from "@/lib/mojopoints.server";
import { pushRecentEvent, getSetById } from "@/lib/store";
import { normalizeWebhookMintsFromDoc } from "@/lib/immutability.guard";
import { redis } from "@/lib/redis";
import { classifySwapRetryDisposition, enqueueSwapJob, kickSwapWorker } from "@/lib/swap-queue.server";
import { tokenMeta } from "@/lib/price-lite";

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function safeStr(x: any) {
  return typeof x === "string" ? x : String(x ?? "");
}

function isInternal(req: NextRequest): boolean {
  const auth = safeStr(req.headers.get("authorization") || "").trim();
  const cron = safeStr(process.env.CRON_SECRET || "").trim();
  if (cron && auth === `Bearer ${cron}`) return true;

  const bypass = safeStr(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass && safeStr(req.headers.get("x-vercel-protection-bypass") || "").trim() === bypass) return true;

  return false;
}


function isWorkerRetry(req: NextRequest): boolean {
  return !!safeStr(req.headers.get("x-mm-swap-job-id") || "").trim();
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
// Goal: under burst concurrency, serialize swaps per set/owner so they "eventually land"
// instead of colliding on RPC/Jupiter/relayer resources.
// This is additive and does not alter successful paths.
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
async function waitForLock(key: string, totalMs: number, leaseMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await acquireLock(key, leaseMs)) return true;
    // jittered backoff
    const left = totalMs - (Date.now() - start);
    const step = Math.min(450, Math.max(125, Math.floor(left / 8)));
    await sleep(step + Math.floor(Math.random() * 120));
  }
  return false;
}
function normalizeDirection(d: any): "BUY" | "SELL" | "REBALANCE" | "" {
  const s = safeStr(d).trim().toUpperCase();
  if (s === "BUY") return "BUY";
  if (s === "SELL") return "SELL";
  if (s === "REBALANCE") return "REBALANCE";
  return "";
}

type ExecArgs = {
  runId?: string;
  setId?: string;
  ownerWallet?: string;
  ownerPubkey?: string;
  wallet?: string;
  inMint?: string;
  outMint?: string;
  inputMint?: string;
  outputMint?: string;
  amountIn?: string;
  amountInAtoms?: string;
  platformFeeBps?: number;
  clientRef?: string;
  autoSlippage?: boolean;
  preferDirect?: boolean;
  /** Explicit override for direct-only routing. */
  directOnly?: boolean;
  preferNativeSolInput?: boolean;
  vault?: string;
  vaultAuthority?: string;
  programId?: string;
  setKind?: string;
  direction?: string;
};

type ExecArgsNormalized = {
  runId?: string;
  setId: string;
  ownerWallet: string;
  inMint: string;
  outMint: string;
  amountInAtoms: string;
  platformFeeBps: number;
  clientRef: string;
  autoSlippage: boolean;
  preferDirect: boolean;
  /** Explicit override (undefined if not provided). */
  directOnly?: boolean;
  preferNativeSolInput: boolean;
  setKind: string;
  direction: "BUY" | "SELL" | "REBALANCE" | "";
  vault?: string;
  vaultAuthority?: string;
  programId?: string;
};

function normalize(body: ExecArgs): ExecArgsNormalized {
  const setId = safeStr(body.setId || "").trim();
  const ownerWallet = safeStr(body.ownerWallet || body.ownerPubkey || body.wallet || "").trim();
  const inMint = safeStr(body.inMint || body.inputMint || "").trim();
  const outMint = safeStr(body.outMint || body.outputMint || "").trim();
  const amountInAtoms = safeStr(body.amountInAtoms || body.amountIn || "").trim();
  const platformFeeBps = Number.isFinite(Number(body.platformFeeBps)) ? Number(body.platformFeeBps) : 50;
  const clientRef = safeStr(body.clientRef || "rebalance").trim() || "rebalance";
  const autoSlippage = body.autoSlippage !== false;
  const preferDirect = body.preferDirect === true;
  const directOnly = typeof (body as any).directOnly === "boolean" ? Boolean((body as any).directOnly) : undefined;
  const preferNativeSolInput = body.preferNativeSolInput !== false;
  const setKind = safeStr(body.setKind || "rebalance").trim() || "rebalance";
  const direction = normalizeDirection(body.direction);

  return {
    runId: body.runId ? safeStr(body.runId) : undefined,
    setId,
    ownerWallet,
    inMint,
    outMint,
    amountInAtoms,
    platformFeeBps,
    clientRef,
    autoSlippage,
    preferDirect,
    directOnly,
    preferNativeSolInput,
    setKind,
    direction,
    vault: body.vault ? safeStr(body.vault).trim() : undefined,
    vaultAuthority: body.vaultAuthority ? safeStr(body.vaultAuthority).trim() : undefined,
    programId: body.programId ? safeStr(body.programId).trim() : undefined,
  };
}

function shouldLogActivity(normalized: ExecArgsNormalized): boolean {
  // Prevent duplicate activity items: /api/ingest/[id] is the source of truth for webhook activity + P/L.
  const cref = (normalized.clientRef || "").toLowerCase();
  if (cref.startsWith("ingest")) return false;
  return true;
}


async function symbolsByMint(reqUrl: string, mints: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const uniq = Array.from(new Set((mints || []).map((m) => safeStr(m).trim()).filter(Boolean)));
    if (!uniq.length) return out;

    const base = new URL(reqUrl);
    const u = new URL("/api/tokens/meta", base);
    u.searchParams.set("mints", uniq.join(","));

    const r = await fetch(u.toString(), { cache: "no-store" } as any);
    if (!r.ok) return out;

    const j: any = await r.json().catch(() => ({}));
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    for (const it of items) {
      const mint = safeStr(it?.mint || it?.address || "").trim();
      const sym = safeStr(it?.symbol || "").trim();
      if (mint && sym) out[mint] = sym;
    }
  } catch {}
  return out;
}

/**
 * For webhook sets, ensure BUY always displays TokenB -> TokenA and SELL displays TokenA -> TokenB.
 * This mirrors the ingest path's consistent A/B mapping for activity rows.
 */
async function ensureWebhookDisplayOrdering(
  normalized: ExecArgsNormalized,
  ev: any,
): Promise<any> {
  const dir = normalized.direction;
  if (dir !== "BUY" && dir !== "SELL") return ev;
  try {
    const set: any = await getSetById(normalized.setId);
    if (!set) return ev;

    const m = normalizeWebhookMintsFromDoc(set || {});
    const A = safeStr(m.mintA || m.mintIn || "").trim();
    const B = safeStr(m.mintB || m.mintOut || "").trim();
    if (!A || !B) return ev;

    const expectedIn = dir === "BUY" ? B : A;
    const expectedOut = dir === "BUY" ? A : B;

    const inMint = safeStr(ev?.inputMint || ev?.inMint || "").trim();
    const outMint = safeStr(ev?.outputMint || ev?.outMint || "").trim();
    if (inMint === expectedIn && outMint === expectedOut) return ev;

    const out2: any = { ...ev };

    // swap mint identifiers
    const tmpMint = out2.inputMint;
    out2.inputMint = out2.outputMint;
    out2.outputMint = tmpMint;

    if ("inMint" in out2 || "outMint" in out2) {
      const t = out2.inMint;
      out2.inMint = out2.outMint;
      out2.outMint = t;
    }

    // swap symbols
    const tmpSym = out2.inputSymbol;
    out2.inputSymbol = out2.outputSymbol;
    out2.outputSymbol = tmpSym;

    if ("inSymbol" in out2 || "outSymbol" in out2) {
      const t = out2.inSymbol;
      out2.inSymbol = out2.outSymbol;
      out2.outSymbol = t;
    }

    // swap amounts
    const tmpAi = out2.amountInAtoms;
    out2.amountInAtoms = out2.amountOutAtoms;
    out2.amountOutAtoms = tmpAi;

    const tmpAu = out2.amountInUi;
    out2.amountInUi = out2.amountOutUi;
    out2.amountOutUi = tmpAu;

    // swap USD
    const tmpT = out2.inTotalUsd;
    out2.inTotalUsd = out2.outTotalUsd;
    out2.outTotalUsd = tmpT;

    const tmpP = out2.inUsdPrice;
    out2.inUsdPrice = out2.outUsdPrice;
    out2.outUsdPrice = tmpP;

    out2.unitPriceUsd =
      (typeof out2.inUsdPrice === "number" ? out2.inUsdPrice : undefined) ||
      (typeof out2.outUsdPrice === "number" ? out2.outUsdPrice : undefined);

    // enforce expected in/out mints (in case the swap above didn't match expected ordering)
    out2.inputMint = expectedIn;
    out2.outputMint = expectedOut;
    if (out2.inMint) out2.inMint = expectedIn;
    if (out2.outMint) out2.outMint = expectedOut;

    return out2;
  } catch {
    return ev;
  }
}

async function bestEffortSymbols(
  reqUrl: string,
  setId: string,
  inMint: string,
  outMint: string,
  direction: "BUY" | "SELL" | "REBALANCE" | "",
): Promise<{ inSymbol: string; outSymbol: string }> {
  const short = (m: string) => (m.length > 8 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);
  let inSymbol = short(inMint);
  let outSymbol = short(outMint);

  try {
    const set: any = await getSetById(setId);
    if (set) {
      const tokenA = (set as any)?.tokenA || (set as any)?.token_a || null;
      const tokenB = (set as any)?.tokenB || (set as any)?.token_b || null;
      const symA = safeStr(tokenA?.symbol || "").trim();
      const symB = safeStr(tokenB?.symbol || "").trim();

      const m = normalizeWebhookMintsFromDoc(set || {});
      const A = safeStr(m.mintA || m.mintIn || "").trim();
      const B = safeStr(m.mintB || m.mintOut || "").trim();

      if (direction === "BUY" && symA && symB && A && B) {
        if (inMint === B) inSymbol = symB;
        if (outMint === A) outSymbol = symA;
      } else if (direction === "SELL" && symA && symB && A && B) {
        if (inMint === A) inSymbol = symA;
        if (outMint === B) outSymbol = symB;
      } else {
        const mintA = safeStr(tokenA?.mint || tokenA?.address || "").trim();
        const mintB = safeStr(tokenB?.mint || tokenB?.address || "").trim();
        if (symA && mintA && mintA === inMint) inSymbol = symA;
        if (symB && mintB && mintB === inMint) inSymbol = symB;
        if (symA && mintA && mintA === outMint) outSymbol = symA;
        if (symB && mintB && mintB === outMint) outSymbol = symB;
      }
    }
  } catch {}

  // Prefer price-lite tokenMeta (same source used by ingest) for stable symbols.
  try {
    const short2 = (m: string) => (m.length > 8 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);
    const looksShort2 = (s: string, m: string) => !s || s === short2(m);
    if (looksShort2(inSymbol, inMint)) {
      const mi = await tokenMeta(inMint).catch(() => null);
      const sym = safeStr(mi?.sym || mi?.symbol || "").trim();
      if (sym) inSymbol = sym;
    }
    if (looksShort2(outSymbol, outMint)) {
      const mo = await tokenMeta(outMint).catch(() => null);
      const sym = safeStr(mo?.sym || mo?.symbol || "").trim();
      if (sym) outSymbol = sym;
    }
  } catch {}

  // If still falling back to short mints, consult /api/tokens/meta as a last resort.
  try {
    const short = (m: string) => (m.length > 8 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);
    const looksShort = (s: string, m: string) => !s || s === short(m);
    if (looksShort(inSymbol, inMint) || looksShort(outSymbol, outMint)) {
      const sm = await symbolsByMint(reqUrl, [inMint, outMint]);
      if (looksShort(inSymbol, inMint) && sm[inMint]) inSymbol = sm[inMint];
      if (looksShort(outSymbol, outMint) && sm[outMint]) outSymbol = sm[outMint];
    }
  } catch {}

  return { inSymbol, outSymbol };
}

async function fetchMintDecimals(mint: string): Promise<number | null> {
  try {
    const mod = await import("@/lib/solana-mint");
    const n = await mod.fetchMintDecimals(mint);
    return Number.isFinite(n) ? Number(n) : null;
  } catch {
    return null;
  }
}

async function pricesByMint(mints: string[]): Promise<Record<string, number>> {
  try {
    const mod: any = await import("@/lib/price-lite");
    const r = await (mod.pricesByMintNoCache || mod.pricesByMint)(mints);
    const out: Record<string, number> = {};
    for (const k of Object.keys(r || {})) {
      const v = Number((r as any)[k]);
      if (Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Mirror webhook ingest position bookkeeping so Manual Swap affects P/L the same way.
async function updateWebhookPositionFromEvent(
  setId: string,
  kindLower: "buy" | "sell",
  ev: any,
): Promise<void> {
  try {
    const posKey = `mm:set:${setId}:pos`;
    const posRaw = await redis.get(posKey).catch(() => null);
    const pos =
      posRaw && typeof posRaw === "string" ? JSON.parse(posRaw) : (posRaw as any) || { qtyTokens: 0, costUsd: 0 };
    const qty = Number(pos.qtyTokens || 0);
    const cost = Number(pos.costUsd || 0);

    const uiIn2 = typeof ev.amountInUi === "number" ? ev.amountInUi : null;
    const uiOut2 = typeof ev.amountOutUi === "number" ? ev.amountOutUi : null;
    const inTotalUsd2 = typeof ev.inTotalUsd === "number" ? ev.inTotalUsd : null;
    const outTotalUsd2 = typeof ev.outTotalUsd === "number" ? ev.outTotalUsd : null;

    if (kindLower === "buy") {
      if (typeof uiOut2 === "number" && typeof uiIn2 === "number" && uiOut2 > 0 && uiIn2 > 0) {
        const newQty = qty + uiOut2;
        const newCost = cost + (inTotalUsd2 != null ? inTotalUsd2 : uiIn2);
        await redis.set(posKey, JSON.stringify({ qtyTokens: newQty, costUsd: newCost }));
      }
    } else {
      if (typeof uiOut2 === "number" && typeof uiIn2 === "number" && uiOut2 > 0 && uiIn2 > 0) {
        const avg = qty > 0 ? cost / qty : 0;
        const sellQty = Math.min(uiIn2, qty);
        const realizedCost = avg * sellQty;
        const proceedsUsd = (outTotalUsd2 != null ? outTotalUsd2 : uiOut2) * (sellQty / uiIn2);
        const pnlUsd = proceedsUsd - realizedCost;
        const newQty = qty - sellQty;
        const newCost = cost - realizedCost;
        await redis.set(posKey, JSON.stringify({ qtyTokens: newQty, costUsd: newCost }));
        await redis.lpush(
          `mm:set:${setId}:pnl`,
          JSON.stringify({
            ts: Date.now(),
            pnlUsd,
            pnlPct: realizedCost > 0 ? pnlUsd / realizedCost : undefined,
          }),
        );
        await redis.ltrim(`mm:set:${setId}:pnl`, 0, 60);
      }
    }
  } catch {}
}

export async function POST(req: NextRequest) {
  if (!isInternal(req)) {
    return json(404, { ok: false, error: "not_found" });
  }

  const body = (await req.json().catch(() => ({}))) as ExecArgs;
  const normalized = normalize(body);

  if (!normalized.setId || !normalized.ownerWallet || !normalized.inMint || !normalized.outMint || !normalized.amountInAtoms) {
    return json(400, { ok: false, error: "invalid_request" });
  }

  try {
    // Burst-safety: serialize swaps per set to reduce collision under load.
    const lockLeaseMs = lockLeaseMsFromEnv();
    const lockWaitMs = lockWaitMsFromEnv();

    const lockKeys: string[] = [];
    if (normalized.setId) lockKeys.push(`mm:swaplock:set:${normalized.setId}`);

    // Acquire locks in a stable order to avoid deadlocks.
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
              execPath: "/api/rebalance/execute-swap",
              body,
              ownerWallet: normalized.ownerWallet,
              setId: normalized.setId,
              vault: normalized.vault,
              kind: safeStr(body?.clientRef || "swap"),
              clientRef: safeStr(body?.clientRef || ""),
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

    // All swap side-effects (events/points/P&L) happen inside this inner try.
    // Locks are released in the finally no matter what.
    try {
      // NOTE: executeSwapCPI expects { ownerPubkey, inputMint, outputMint, amountInAtoms }
    const args: any = {
      setId: normalized.setId,
      ownerWallet: normalized.ownerWallet,
      ownerPubkey: normalized.ownerWallet,
      inMint: normalized.inMint,
      outMint: normalized.outMint,
      inputMint: normalized.inMint,
      outputMint: normalized.outMint,
      amountIn: normalized.amountInAtoms,
      amountInAtoms: normalized.amountInAtoms,
      platformFeeBps: normalized.platformFeeBps,
      setKind: normalized.setKind,
      clientRef: normalized.clientRef,
      preferNativeSolInput: normalized.preferNativeSolInput,
      wrapAndUnwrapSol: true,
      autoSlippage: normalized.autoSlippage,
      // Only honor preferDirect -> directOnly in non-webhook, non-ingest contexts.
      // For webhooks/ingest, forcing direct-only can accidentally kill routing for long-tail pairs.
      directOnly:
        typeof normalized.directOnly === "boolean"
          ? normalized.directOnly
          : (normalized.preferDirect && normalized.setKind !== "webhook" && !normalized.clientRef.toLowerCase().startsWith("ingest"))
            ? true
            : undefined,
      vault: normalized.vault,
      vaultAuthority: normalized.vaultAuthority,
      programId: normalized.programId,
      direction: normalized.direction ? normalized.direction.toLowerCase() : undefined,
    };

    const executeSwapCPI = (await import("@/lib/executeSwapCPI.server")).default;
    let res: any = null;
    const maxSyncRetries = isWorkerRetry(req) ? 0 : syncRetryCountFromEnv();
    for (let attempt = 0; attempt <= maxSyncRetries; attempt++) {
      res = await executeSwapCPI(args);
      const sigNow = safeStr(res?.signature || "").trim();
      if (res?.ok && sigNow) break;
      const disposition = classifySwapRetryDisposition(500, res, attempt);
      if (!disposition.retryable || attempt >= maxSyncRetries) break;
      await sleep(syncRetryDelayMs(attempt + 1));
    }

    // SUCCESS-ONLY gating: failed attempts must not create volume, points, or P/L.
    const sig = safeStr(res?.signature || "").trim();
    if (!res?.ok || !sig) {
      const disposition = classifySwapRetryDisposition(500, res, maxSyncRetries);
      const queueEnabled = isQueueEnabled();
      if (disposition.retryable && !isWorkerRetry(req) && queueEnabled) {
        const job = await enqueueSwapJob({
          execPath: "/api/rebalance/execute-swap",
          body,
          ownerWallet: normalized.ownerWallet,
          setId: normalized.setId,
          vault: normalized.vault,
          kind: safeStr(body?.clientRef || "swap"),
          clientRef: safeStr(body?.clientRef || ""),
          requestedAtMs: originalRequestedAt(req),
        }).catch(() => null);
        if (job?.ok) kickSwapWorker({ maxJobs: 1 }).catch(() => {});

        return json(500, {
          ok: false,
          error: "swap_failed",
          diag: res?.diag || undefined,
          reason: res?.reason || undefined,
          queued: !!job?.ok,
          jobId: job?.ok ? job.jobId : undefined,
        });
      }

      return json(500, {
        ok: false,
        error: disposition.terminal ? "swap_failed_terminal" : "swap_failed",
        diag: res?.diag || undefined,
        reason: res?.reason || undefined,
      });
    }

    const doLog = shouldLogActivity(normalized);
    const eventTs = originalRequestedAt(req);

    if (doLog) {
      const direction = normalized.direction;
      const kindLower: "buy" | "sell" | "rebalance" =
        direction === "BUY" ? "buy" : direction === "SELL" ? "sell" : "rebalance";
      const eventKind = kindLower === "buy" ? "swap_buy" : kindLower === "sell" ? "swap_sell" : "swap_rebalance";

      const sym = await bestEffortSymbols(req.url, normalized.setId, normalized.inMint, normalized.outMint, direction);

      // amounts
      let outAtoms = safeStr(res?.outAmountAtoms ?? res?.amountOutAtoms ?? res?.amountOut ?? "");
      // executeSwapCPI may omit out amounts; prefer Jupiter quote for deterministic UI/P+L enrichment
      try {
        const q: any = res?.quote || null;
        const qOut = safeStr(q?.outAmountWithSlippage ?? q?.outAmount ?? q?.outAmountRaw ?? q?.otherAmountThreshold ?? "").trim();
        if (!outAtoms && qOut) outAtoms = qOut;
      } catch {}

      const [decIn, decOut] = await Promise.all([
        fetchMintDecimals(normalized.inMint),
        fetchMintDecimals(normalized.outMint),
      ]);
      const uiIn = decIn != null ? Number(normalized.amountInAtoms) / Math.pow(10, decIn) : null;
      const uiOut =
        decOut != null && outAtoms ? Number(outAtoms) / Math.pow(10, decOut) : null;

      // price snapshot (best-effort) for display + P/L parity
      const pxAlways = await pricesByMint([normalized.inMint, normalized.outMint]);
      const inUsdPrice = Number.isFinite(pxAlways[normalized.inMint]) ? Number(pxAlways[normalized.inMint]) : null;
      const outUsdPrice = Number.isFinite(pxAlways[normalized.outMint]) ? Number(pxAlways[normalized.outMint]) : null;

      // usd (best-effort)
      const q: any = res?.quote || null;
      let inTotalUsd: number | null =
        typeof q?.inAmountUsd === "number"
          ? q.inAmountUsd
          : typeof q?.inTotalUsd === "number"
            ? q.inTotalUsd
            : null;
      let outTotalUsd: number | null =
        typeof q?.outAmountUsd === "number"
          ? q.outAmountUsd
          : typeof q?.outTotalUsd === "number"
            ? q.outTotalUsd
            : null;

      // If quote did not provide USD, fallback to price-lite for current notional.
      if (inTotalUsd == null || outTotalUsd == null) {
        const pIn = inUsdPrice;
        const pOut = outUsdPrice;
        if (inTotalUsd == null && uiIn != null && pIn != null) inTotalUsd = uiIn * pIn;
        if (outTotalUsd == null && uiOut != null && pOut != null) outTotalUsd = uiOut * pOut;
      }

      // derive price from totals if price service didn't return a value (prevents $0 UI/P+L on manual swaps)
      let inUsdPrice2: number | null = inUsdPrice;
      let outUsdPrice2: number | null = outUsdPrice;
      try {
        if ((inUsdPrice2 == null || !Number.isFinite(inUsdPrice2)) && typeof inTotalUsd === "number" && typeof uiIn === "number" && uiIn > 0) {
          inUsdPrice2 = inTotalUsd / uiIn;
        }
        if ((outUsdPrice2 == null || !Number.isFinite(outUsdPrice2)) && typeof outTotalUsd === "number" && typeof uiOut === "number" && uiOut > 0) {
          outUsdPrice2 = outTotalUsd / uiOut;
        }
      } catch {}

      const ev: any = {
        ts: eventTs,
        wallet: normalized.ownerWallet,
        setId: normalized.setId,
        direction: direction || undefined,

        // Canonical fields used by /api/events/recent for display + pnl hydration
        inMint: normalized.inMint,
        outMint: normalized.outMint,
        inSymbol: sym.inSymbol,
        outSymbol: sym.outSymbol,
        inputMint: normalized.inMint,
        outputMint: normalized.outMint,
        inputSymbol: sym.inSymbol,
        outputSymbol: sym.outSymbol,
        amountInAtoms: normalized.amountInAtoms,
        amountOutAtoms: outAtoms || null,
        amountInUi: uiIn,
        amountOutUi: uiOut,
        inUsdPrice: typeof inUsdPrice2 === "number" ? inUsdPrice2 : undefined,
        outUsdPrice: typeof outUsdPrice2 === "number" ? outUsdPrice2 : undefined,
        unitPriceUsd: direction === "BUY" ? (typeof outUsdPrice2 === "number" ? outUsdPrice2 : undefined) : direction === "SELL" ? (typeof inUsdPrice2 === "number" ? inUsdPrice2 : undefined) : (typeof inUsdPrice2 === "number" ? inUsdPrice2 : (typeof outUsdPrice2 === "number" ? outUsdPrice2 : undefined)),
        inTotalUsd: typeof inTotalUsd === "number" ? inTotalUsd : undefined,
        outTotalUsd: typeof outTotalUsd === "number" ? outTotalUsd : undefined,

        ok: true,
        tx: sig,
        txUrl: `https://solscan.io/tx/${sig}`,
        clientRef: normalized.clientRef,
        source: normalized.setKind === "webhook" ? "webhook" : "rebalance",
      };

      // For webhook sets, normalize display ordering to match Token A/B mapping.
      let evFinal: any = ev;
      if (normalized.setKind === "webhook") {
        try { evFinal = await ensureWebhookDisplayOrdering(normalized, evFinal); } catch {}
      }

      // NOTE: use store.pushRecentEvent to maintain the shared {message,...} schema
      await pushRecentEvent(normalized.setId, eventKind, evFinal);

      // Mojo points volume should be SUCCESS-only; pass best-effort USD notional.
      await applyMojoPointsFromEvent({
        wallet: String(evFinal?.wallet || ""),
        setId: normalized.setId,
        kind: eventKind,
        ts: evFinal.ts,
        tx: sig,
        inTotalUsd: typeof evFinal?.inTotalUsd === "number" ? evFinal.inTotalUsd : null,
      } as any);

      // Manual swaps should track P/L exactly like webhook ingest.
      const cref = (normalized.clientRef || "").toLowerCase();
      if (normalized.setKind === "webhook" && (cref.startsWith("manual") || cref.startsWith("manual-swap"))) {
        if (kindLower === "buy" || kindLower === "sell") {
          await updateWebhookPositionFromEvent(normalized.setId, kindLower, evFinal);
        }
      }
    }

    return json(200, { ok: true, ...res, runId: normalized.runId });
    } finally {
      // Release locks (best-effort)
      try {
        for (const k of lockKeys) await releaseLock(k);
      } catch {}
    }

  } catch (e: any) {
    if (isQueueEnabled()) {
      const job = await enqueueSwapJob({
        execPath: "/api/rebalance/execute-swap",
        body,
        ownerWallet: safeStr((body as any)?.ownerWallet || (body as any)?.ownerPubkey || ""),
        setId: safeStr((body as any)?.setId || ""),
        vault: safeStr((body as any)?.vault || ""),
        kind: safeStr((body as any)?.clientRef || "swap"),
        clientRef: safeStr((body as any)?.clientRef || ""),
      }).catch(() => null);
      if (job?.ok) kickSwapWorker({ maxJobs: 1 }).catch(() => {});

      return json(500, {
        ok: false,
        error: "swap_failed",
        reason: e?.message || null,
        queued: !!job?.ok,
        jobId: job?.jobId || undefined,
      });
    }

    return json(500, {
      ok: false,
      error: "swap_failed",
      reason: e?.message || null,
    });
  }
}
