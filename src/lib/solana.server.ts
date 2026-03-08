// src/lib/solana.server.ts
// Server-only Solana connection helper.
//
// Consolidated: the no-argument case (all 5 server callers) now delegates to the
// global singleton in @/lib/rpc, avoiding thousands of duplicate Connections under
// concurrent load.  Explicit rpcUrl/rpcHeaders overrides are cached by URL.
import { Connection } from "@solana/web3.js";
import { ensureConnection as sharedSingleton } from "@/lib/rpc";

/** Cache for explicitly-overridden RPC URLs (rare path). */
const _overrideCache = new Map<string, Connection>();

/**
 * Server-side RPC URL preference chain (secret RPCs first).
 */
function serverRpcUrl(): string {
  const url = (
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_MAINNET_RPC ||
    process.env.SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    ""
  ).trim();
  if (!url) throw new Error("SOLANA_RPC_URL not set");
  return url;
}

/**
 * Provide a Connection using env:
 *   HELIUS_RPC_URL / SOLANA_MAINNET_RPC / SOLANA_RPC_URL (preferred, server-only)
 *   SOLANA_RPC_HEADERS (optional, JSON object string)
 *
 * No-arg calls (common case) return the global singleton from @/lib/rpc.
 * Explicit overrides are cached by URL to avoid duplicate Connections.
 */
export function getConnection(
  rpcUrl?: string | undefined,
  rpcHeaders?: Record<string, string>
): Connection {
  // --- Common path: no overrides -> global singleton ---
  if (!rpcUrl && !rpcHeaders) {
    return sharedSingleton({ endpoint: serverRpcUrl() });
  }

  // --- Rare path: explicit URL or headers override ---
  const url = (
    (rpcUrl || "").trim() ||
    serverRpcUrl()
  );
  const headers =
    rpcHeaders ||
    (process.env.SOLANA_RPC_HEADERS
      ? (JSON.parse(process.env.SOLANA_RPC_HEADERS) as Record<string, string>)
      : undefined);

  const cacheKey = url + (headers ? JSON.stringify(headers) : "");
  let conn = _overrideCache.get(cacheKey);
  if (!conn) {
    conn = new Connection(url, { commitment: "confirmed", httpHeaders: headers });
    _overrideCache.set(cacheKey, conn);
  }
  return conn;
}
