// File: src/app/rebalance/_components/hooks/useStartRebalance.ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rebalanceNowOrchestrator, type RebalanceNowResponse } from "@/lib/rebalance/orchestrator";

export type UseStartRebalanceOptions = {
  /**
   * (Optional) Set id for hydration. If provided, the hook will re-hydrate an in-flight
   * rebalance banner across accidental page refreshes.
   */
  setId?: string;

  /**
   * Called on each internal status update so you can stream progress into your Activity panel.
   * Keep it lightweight; it's invoked often.
   */
  onUpdate?: (evt: Parameters<Parameters<typeof rebalanceNowOrchestrator>[0]["onUpdate"]>[0]) => void;

  /**
   * Optional timeout; defaults to 600_000 (10m).
   * Reason: real-world rebalances can take a few minutes; a 2m cap can end before the final
   * /rebalance-now pass runs, which prevents the aggregated Activity row from being appended.
   */
  maxTotalMs?: number;

  /**
   * Max attempts per swap; defaults to 8.
   */
  maxAttemptsPerSwap?: number;

  /**
   * How long a hydrated "in flight" marker should be kept, in ms.
   * Defaults to 12 minutes.
   */
  hydrateTtlMs?: number;
};

type InFlightMarker = { startedAt: number };

function safeKey(setId: string) {
  return `mm:rebalance:inflight:${String(setId || "").trim()}`;
}

function readMarker(setId: string): InFlightMarker | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(safeKey(setId));
    if (!raw) return null;
    const j = JSON.parse(raw);
    const startedAt = Number(j?.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
    return { startedAt };
  } catch {
    return null;
  }
}

function writeMarker(setId: string, marker: InFlightMarker) {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(safeKey(setId), JSON.stringify(marker));
  } catch {}
}

function clearMarker(setId: string) {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(safeKey(setId));
  } catch {}
}

export function useStartRebalance(opts?: UseStartRebalanceOptions) {
  const [inFlight, setInFlight] = useState(false);
  const [lastResult, setLastResult] = useState<RebalanceNowResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const setIdRef = useRef<string>("");

  const hydrateSetId = useMemo(() => String(opts?.setId || "").trim(), [opts?.setId]);
  const hydrateTtlMs = Number(opts?.hydrateTtlMs ?? 12 * 60_000);

  // Hydrate an in-flight marker to keep the "Please wait, rebalancing…" banner visible after refreshes.
  useEffect(() => {
    if (!hydrateSetId) return;

    const marker = readMarker(hydrateSetId);
    if (!marker) return;

    const ttl = Number.isFinite(hydrateTtlMs) && hydrateTtlMs > 10_000 ? hydrateTtlMs : 12 * 60_000;
    const age = Date.now() - marker.startedAt;
    if (!Number.isFinite(age) || age < 0 || age > ttl) {
      clearMarker(hydrateSetId);
      return;
    }

    // Show the in-flight state so the user doesn't think the rebalance finished.
    setIdRef.current = hydrateSetId;
    setInFlight(true);

    const t = window.setTimeout(() => {
      // If we never observed a completion, expire the banner conservatively.
      clearMarker(hydrateSetId);
      setInFlight(false);
    }, Math.max(1_000, ttl - age));

    return () => window.clearTimeout(t);
  }, [hydrateSetId, hydrateTtlMs]);

  useEffect(() => {
    return () => {
      // Abort any outstanding work when unmounting
      abortRef.current?.abort();
    };
  }, []);

  const start = useCallback(
    async (setId: string) => {
      const sid = String(setId || "").trim();
      if (!sid) return null;
      if (inFlight) return null; // prevent double-clicks

      const ac = new AbortController();
      abortRef.current = ac;
      setIdRef.current = sid;

      // Persist marker immediately so a hard refresh doesn't hide the banner mid-run.
      writeMarker(sid, { startedAt: Date.now() });

      setInFlight(true);
      setLastResult(null);

      try {
        const result = await rebalanceNowOrchestrator({
          setId: sid,
          maxTotalMs: opts?.maxTotalMs ?? 600_000,
          maxAttemptsPerSwap: opts?.maxAttemptsPerSwap ?? 8,
          signal: ac.signal,
          onUpdate: (u) => {
            // bubble to caller
            opts?.onUpdate?.(u);
          },
        });

        setLastResult(result);
        return result;
      } finally {
        // Always clear marker on completion (success or failure).
        clearMarker(sid);
        setInFlight(false);
        abortRef.current = null;
      }
    },
    [inFlight, opts?.maxAttemptsPerSwap, opts?.maxTotalMs, opts?.onUpdate]
  );

  const stop = useCallback(() => {
    try {
      const sid = String(setIdRef.current || "").trim();
      if (sid) clearMarker(sid);
    } catch {}
    abortRef.current?.abort();
    setInFlight(false);
  }, []);

  return { start, stop, inFlight, lastResult };
}
