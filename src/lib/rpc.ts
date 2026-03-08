/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * src/lib/rpc.ts
 *
 * Singleton Connection creator for both client and server.
 * Surgical change: broaden env support so any of these drive the endpoint:
 *   - NEXT_PUBLIC_RPC_URL (preferred; Cloudflare Worker)
 *   - NEXT_PUBLIC_SOLANA_RPC_URL (legacy client var)
 *   - RPC_URL (legacy)
 * Fallback: clusterApiUrl('mainnet-beta') — no secret exposure.
 *
 * No UI changes; preserves existing exports and behavior.
 */
import { Connection, clusterApiUrl } from "@solana/web3.js";

type Cfg = {
  endpoint?: string;
  commitment?: "processed" | "confirmed" | "finalized";
};

declare global {
  // eslint-disable-next-line no-var
  var __mmSingletonConn__: Connection | undefined;
}

const DEFAULT_COMMITMENT: Cfg["commitment"] = "confirmed";

function endpointFromEnv(): string {
  // Prefer explicit, public client endpoints (Worker)
  const e =
    (process.env.NEXT_PUBLIC_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL.trim()) ||
    (process.env.NEXT_PUBLIC_SOLANA_RPC_URL && process.env.NEXT_PUBLIC_SOLANA_RPC_URL.trim()) ||
    (process.env.RPC_URL && process.env.RPC_URL.trim());
  if (e) return e;
  return clusterApiUrl("mainnet-beta");
}

/** Default RPC timeout (ms). Prevents hung connections under load. */
export const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS) || 15_000;

/**
 * Build a fetchMiddleware that aborts RPC calls after `timeoutMs`.
 * Compatible with @solana/web3.js v1.x ConnectionConfig.
 */
export function rpcFetchMiddleware(timeoutMs = RPC_TIMEOUT_MS) {
  return (url: string, options: any, fetch: (...a: any[]) => void) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const origSignal = options?.signal;
    // Compose with any existing signal (Node 20+ AbortSignal.any)
    let signal: AbortSignal;
    if (origSignal && typeof AbortSignal.any === "function") {
      signal = AbortSignal.any([origSignal, controller.signal]);
    } else {
      signal = controller.signal;
    }
    fetch(url, { ...options, signal });
    // Timer self-cleans on abort; leaking a short timer in serverless is acceptable.
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  };
}

/**
 * Create or return the singleton Connection (with RPC timeout).
 * Do not export the Connection class directly; always use this getter.
 */
export function ensureConnection(cfg?: Cfg): Connection {
  if (globalThis.__mmSingletonConn__) return globalThis.__mmSingletonConn__!;
  const endpoint = (cfg && cfg.endpoint) || endpointFromEnv();
  const commitment = (cfg && cfg.commitment) || DEFAULT_COMMITMENT;
  const conn = new Connection(endpoint, {
    commitment,
    fetchMiddleware: rpcFetchMiddleware(),
  } as any);
  globalThis.__mmSingletonConn__ = conn;
  return conn;
}

// Old name kept for compatibility
export const getConnection = ensureConnection;
