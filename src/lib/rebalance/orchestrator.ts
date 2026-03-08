// File: src/lib/rebalance/orchestrator.ts
// Purpose: Robust, sequential rebalance orchestrator that retries failed swaps patiently
// Notes:
// - Pure front-end safe (no Node APIs); usable in client components or server actions.
// - Does NOT change any UI. You can import and use from your existing /rebalanceinlinepanel start handler.
// - Works with your existing routes:
//     • POST /api/rebalance/rebalance-now  (kicks the first pass and/or returns the plan + results)
//     • POST /api/rebalance/execute-swap  (executes a single swap)
// - Keeps the JSON shape you already return (ok, swaps[], nextRebalanceAt).
// - Retries each swap (1×1) with exponential backoff and small adaptive hints derived from the error logs you shared.
// - Tolerates Jupiter Lite vs Pro differences and ensures onlyDirectRoutes is passed as a boolean when needed.
// - Ensures platformFeeBps is always > 0 if a feeAccount is being used (prevents Jupiter 'NOT_SUPPORTED' 400).
// - Margin of error: when re-running a final /rebalance-now pass, we stop if there are no remaining swaps or all
//   residual swapUsdValues are tiny (<= $5) — server route may already implement this, we only short-circuit on our side.
//
// You do NOT have to move your existing logic; simply call rebalanceNowOrchestrator() from your current start button handler.
// Example usage:
//   const result = await rebalanceNowOrchestrator({ setId, onUpdate: console.log });
//
// This module is intentionally dependency-free.


export type SwapInput = {
  setId: string;
  ownerWallet: string;            // relayer signer
  inMint: string;
  outMint: string;
  amountIn: string;               // string atoms UI from your logs
  platformFeeBps?: number;        // we default to 25 if missing
  autoSlippage?: boolean;         // default true
  vault: string;
  vaultAuthority: string;
  programId: string;
  setKind: "rebalance" | "webhook";
  wrapAndUnwrapSol?: boolean;
  preferNativeSolInput?: boolean;
  ownerPubkey?: string;
  inputMint?: string;
  outputMint?: string;
  amountInAtoms?: string;
  // Optional "hints" that the /api/rebalance/execute-swap route can forward to Jupiter
  // (they are no-ops if your route ignores them — safe to send)
  onlyDirectRoutes?: boolean;
  useTokenLedger?: boolean;
};

export type SwapAttemptDiag = unknown;

export type SwapResponse = {
  ok: boolean;
  signature?: string | null;
  slot?: number | null;
  quote?: any | null;
  routeSummary?: any | null;
  diag?: {
    debugId?: string;
    stage?: string;
    attempts?: any[];
    caught?: any;
    input?: SwapInput;
  };
  inputMint?: string;
  outputMint?: string;
};

export type RebalanceNowResponse = {
  ok: boolean;
  swaps: SwapResponse[];
  nextRebalanceAt?: number;
};

// ---- injected: resolve owner wallet for a set (used to satisfy x-wallet header) ----
const __ownerBySetId: Record<string, string> = Object.create(null);
async function __getOwnerForSet(setId: string): Promise<string | null> {
  if (__ownerBySetId[setId]) return __ownerBySetId[setId];
  try {
    const res = await fetch(`/api/rebalance/set/${encodeURIComponent(setId)}`, { method: "GET", cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    const set = j?.set || {};
    const owner = String(set?.wallet || set?.ownerWallet || set?.owner || set?.owner_wallet || "").trim();
    if (owner) __ownerBySetId[setId] = owner;
    return owner || null;
  } catch {
    return null;
  }
}
// ---- end injected helper ----

export type OrchestratorOptions = {
  setId: string;
  /**
   * If you already have the initial response from /api/rebalance/rebalance-now
   * (the one you pasted from DevTools), pass it to avoid re-hitting that route.
   */
  initial?: RebalanceNowResponse;
  /**
   * Cap total time spent before we return control to the UI (ms).
   * We keep trying patiently but never block the UI indefinitely.
   */
  maxTotalMs?: number; // default 600_000 (10 minutes)
  /**
   * How many attempts per *single* swap before we give up on that one.
   */
  maxAttemptsPerSwap?: number; // default 8
  /**
   * First backoff delay in ms. Grows with multiplier.
   */
  baseBackoffMs?: number; // default 1200
  /**
   * Backoff growth factor.
   */
  backoffFactor?: number; // default 1.6
  /**
   * Optional AbortSignal to cancel early (e.g., when user clicks "Stop").
   */
  signal?: AbortSignal | null;
  /**
   * Receive progress snapshots to reflect in the panel.
   */
  onUpdate?: (u: {
    phase:
      | "kick"
      | "retry-start"
      | "retry-progress"
      | "retry-success"
      | "retry-failed"
      | "round-complete"
      | "complete";
    swapIndex?: number;
    attempt?: number;
    lastError?: string | null;
    lastSignature?: string | null;
    pending?: number;
    completed?: number;
    total?: number;
    data?: any;
  }) => void;
  /**
   * If true (default), we do a final light pass against /api/rebalance/rebalance-now
   * to clean up any residual USD drift (<= ~$5 target tolerance).
   */
  finalPass?: boolean;
};

/**
 * Call your existing route: /api/rebalance/rebalance-now
 * We expect the usual shape: { ok, swaps: [ ... ] }
 */
function _mmAbortAfter(ms: number, outer?: AbortSignal): AbortController {
  const ac = new AbortController();
  const t = setTimeout(() => {
    try { ac.abort(); } catch {}
  }, ms);
  // Clear timer when aborted for any reason
  ac.signal.addEventListener("abort", () => {
    try { clearTimeout(t as any); } catch {}
  }, { once: true } as any);

  if (outer) {
    if (outer.aborted) {
      try { ac.abort(); } catch {}
    } else {
      outer.addEventListener("abort", () => {
        try { ac.abort(); } catch {}
      }, { once: true } as any);
    }
  }
  return ac;
}

async function callRebalanceNow(setId: string, signal?: AbortSignal): Promise<RebalanceNowResponse> {
  const ac = _mmAbortAfter(55_000, signal);
  const res = await fetch("/api/rebalance/rebalance-now", {
    method: "POST",
    headers: { "content-type": "application/json", "x-wallet": (await __getOwnerForSet(setId)) || "" },
    body: JSON.stringify({ setId }),
    cache: "no-store",
    signal: ac.signal as any,
  });
  if (!res.ok) {
    throw new Error(`rebalance-now HTTP ${res.status}`);
  }
  return (await res.json()) as RebalanceNowResponse;
}

/**
 * Execute a *single* swap by calling your existing route: /api/rebalance/execute-swap
 * We forward a few adaptive hints derived from previous failures:
 *  - onlyDirectRoutes is coerced to boolean to avoid Jupiter parse errors
 *  - ensure platformFeeBps > 0 whenever feeAccount is in play (your route decides that)
 *  - can toggle useTokenLedger=false for InvalidAccountData-type failures
 */
async function callExecuteSwapOnce(input: SwapInput): Promise<SwapResponse> {
  // Normalize a few fields Jupiter is picky about:
  const payload: SwapInput = {
    ...input,
    autoSlippage: input.autoSlippage ?? true,
    platformFeeBps: input.platformFeeBps ?? 25,
    inputMint: input.inputMint ?? input.inMint,
    outputMint: input.outputMint ?? input.outMint,
    amountInAtoms: input.amountInAtoms ?? input.amountIn,
    // Important: boolean, not "1"
    onlyDirectRoutes:
      typeof input.onlyDirectRoutes === "boolean"
        ? input.onlyDirectRoutes
        : undefined,
  };

  const res = await fetch("/api/rebalance/execute-swap", { method: "POST", headers: { "content-type": "application/json", "x-wallet": (payload.ownerPubkey || (await __getOwnerForSet(payload.setId)) || "") }, body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!res.ok) {
    // We still try to read body for diagnostics.
    let text: any = null;
    try {
      text = await res.text();
    } catch {}
    const err = new Error(`execute-swap HTTP ${res.status}: ${text ?? ""}`);
    (err as any).__http__ = text;
    throw err;
  }
  return (await res.json()) as SwapResponse;
}

/**
 * Smart retry around a single swap.
 * We look at the prior attempt's diag to adapt the next try:
 *   • If "onlyDirectRoutes cannot be parsed" -> ensure boolean true on next call.
 *   • If "platformFee must be greater than 0 when feeAccount is set" -> bump platformFeeBps to 25.
 *   • If "invalid account data for instruction" -> try useTokenLedger=false in the next attempt.
 */
async function retryExecuteSwap(
  baseInput: SwapInput,
  opts: Pick<
    OrchestratorOptions,
    "maxAttemptsPerSwap" | "baseBackoffMs" | "backoffFactor" | "signal" | "onUpdate"
  >
): Promise<SwapResponse> {
  const maxAttempts = opts.maxAttemptsPerSwap ?? 8;
  const baseDelay = opts.baseBackoffMs ?? 1200;
  const growth = opts.backoffFactor ?? 1.6;

  let input = { ...baseInput };
  let last: SwapResponse | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      const aborted: SwapResponse = {
        ok: false,
        signature: null,
        diag: { caught: { message: "aborted" }, input },
      };
      return aborted;
    }

    try {
      opts.onUpdate?.({
        phase: attempt === 1 ? "retry-start" : "retry-progress",
        attempt,
        swapIndex: undefined,
        lastError: last?.diag as any,
        lastSignature: last?.signature ?? null,
        pending: undefined,
        completed: undefined,
        total: undefined,
        data: { input },
      });

      const res = await callExecuteSwapOnce(input);

      if (res.ok && res.signature) {
        opts.onUpdate?.({
          phase: "retry-success",
          attempt,
          lastSignature: res.signature,
          data: res,
        });
        return res;
      }

      // Adaptive tweaks based on diag/errors before the next attempt.
      const errStrings: string[] = [];
      const attempts = (res.diag as any)?.attempts as any[] | undefined;
      if (attempts && attempts.length > 0) {
        const lastAttempt = attempts[attempts.length - 1];
        for (const k of [
          "sendErr",
          "packErr",
          "packLiteErr",
          "packProErr",
          "quoteProErr",
        ]) {
          if (lastAttempt?.[k]) errStrings.push(String(lastAttempt[k]));
        }
        const errBody =
          lastAttempt?.quoteProErrBody || lastAttempt?.packProErrBody;
        if (errBody?.error) errStrings.push(String(errBody.error));
      }
      const errCombined = errStrings.join(" | ");

      // 1) Fix onlyDirectRoutes parse issue by forcing a boolean
      if (errCombined.includes("onlyDirectRoutes cannot be parsed")) {
        input = {
          ...input,
          onlyDirectRoutes: true,
        };
      }
      // 2) Ensure non-zero platform fee when feeAccount is set (route will map to its treasury ATA)
      if (
        errCombined.includes(
          "platformFee must be greater than 0 when feeAccount is set"
        )
      ) {
        input = {
          ...input,
          platformFeeBps: input.platformFeeBps && input.platformFeeBps > 0 ? input.platformFeeBps : 25,
        };
      }
      // 3) If token-ledger / account-data errors, try disabling ledger on next attempt
      if (errCombined.includes("invalid account data for instruction")) {
        input = {
          ...input,
          useTokenLedger: false,
        };
      }

      last = res;
    } catch (e: any) {
      last = {
        ok: false,
        signature: null,
        diag: { caught: { message: String(e?.message ?? e) }, input },
      };
    }

    // Patient exponential backoff before the next attempt
    const delay = Math.floor(baseDelay * Math.pow(growth, attempt - 1));
    await new Promise((r) => setTimeout(r, delay));
  }

  // Return the last observed result (with rich diag) if all attempts exhausted.
  if (last) {
    return last;
  }
  return {
    ok: false,
    signature: null,
    diag: { caught: { message: "exhausted_without_response" }, input: baseInput },
  };
}


/**
 * High level orchestrator.
 * 1) Kick a single /rebalance-now pass (server computes plan, attempts swaps).
 * 2) Gather failures from that pass and retry them sequentially, one-by-one, patiently.
 * 3) Optionally run one last /rebalance-now pass to clean up any USD drift within ~$5 tolerance.
 */
export async function rebalanceNowOrchestrator(opts: OrchestratorOptions): Promise<RebalanceNowResponse> {
  const start = Date.now();
  const deadline = start + (opts.maxTotalMs ?? 600_000);
  const result: RebalanceNowResponse = {
    ok: true,
    swaps: [],
  };

  // Step 1 — Kick the first pass (or use provided one)
  opts.onUpdate?.({ phase: "kick", data: { setId: opts.setId } });
  let firstPass: RebalanceNowResponse = opts.initial ?? (await callRebalanceNow(opts.setId, opts.signal));

  result.swaps.push(...firstPass.swaps);

  // Collect failed ones from the first pass
  const pendingQueue: SwapInput[] = [];
  for (const s of firstPass.swaps) {
    if (!s?.signature) {
      const input = (s?.diag as any)?.input as SwapInput | undefined;
      if (input) pendingQueue.push(input);
    }
  }

  // Step 2 — Sequentially retry each failed swap with patience
  let completed = 0;
  const total = pendingQueue.length;

  for (let i = 0; i < pendingQueue.length; i++) {
    if (opts.signal?.aborted) break;
    if (Date.now() > deadline) break;

    const baseInput = pendingQueue[i];
    const retryRes = await retryExecuteSwap(baseInput, {
      maxAttemptsPerSwap: opts.maxAttemptsPerSwap,
      baseBackoffMs: opts.baseBackoffMs,
      backoffFactor: opts.backoffFactor,
      signal: opts.signal ?? null,
      onUpdate: (u) => {
        opts.onUpdate?.({
          ...u,
          swapIndex: i,
          pending: total - completed - 1,
          completed,
          total,
        });
      },
    });

    result.swaps.push(retryRes);

    if (retryRes.ok && retryRes.signature) {
      completed += 1;
    } else {
      // We keep going to the next swap even if this one failed all attempts,
      // so other tokens can still succeed. This improves "overall" success rate.
      opts.onUpdate?.({
        phase: "retry-failed",
        swapIndex: i,
        data: retryRes,
        pending: total - completed - 1,
        completed,
        total,
      });
    }

    // Small grace pause between swaps so the vault's balances settle on chain.
    if (i < pendingQueue.length - 1) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  opts.onUpdate?.({ phase: "round-complete", data: { completed, total } });

  // Step 3 — optional final clean-up pass
  if (opts.finalPass !== false) {
    if (opts.signal?.aborted) return result;
    try {
      const finalPass = await callRebalanceNow(opts.setId, opts.signal);
      result.swaps.push(...finalPass.swaps);

      // If that pass returns no pending swap signatures AND either swaps array is empty
      // or all swaps have very small USD values (<= ~$5), consider it "balanced enough".
      const stillPending = finalPass.swaps.filter((s) => !s.signature);
      const tinyUsd = finalPass.swaps.every((s) => {
        const usd = Number((s?.quote as any)?.swapUsdValue ?? (s?.routeSummary as any)?.swapUsdValue ?? 0);
        return isFinite(usd) ? usd <= 5 : true;
      });

      if (stillPending.length === 0 || tinyUsd) {
        // good enough
      }
    } catch (e) {
      // Best-effort only; ignore errors in final pass.
    }
  }

  opts.onUpdate?.({ phase: "complete", data: result });
  return result;
}
