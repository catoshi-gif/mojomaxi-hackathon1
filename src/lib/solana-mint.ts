// src/lib/solana-mint.ts
// Full file replacement (surgical).
// Goal: preserve existing behavior while adding Token-2022 compatibility for mint
// decimal lookups (required for correct Activity/PnL display on Token-2022 mints like PUMP).
//
// Notes:
// - No UI changes. Safe to use in API routes or server utilities.
// - Uses server-preferred RPC (HELIUS_RPC_URL / SOLANA_RPC_URL) with a safe public fallback.
// - If a Connection is provided, we use it (non-breaking for existing call sites).
// - We detect the mint's owning program (TOKEN_PROGRAM_ID vs TOKEN_2022_PROGRAM_ID)
//   and pass the correct programId to getMint().

import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import { getMint, Mint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const DEFAULT_COMMITMENT: Commitment = "confirmed";

function resolveRpcUrl(): string {
  // Server-preferred envs first; fall back to client-safe/public mainnet
  return (
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.SOLANA_MAINNET_RPC ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}

export function getServerConnection(commitment: Commitment = DEFAULT_COMMITMENT): Connection {
  const url = resolveRpcUrl();
  return new Connection(url, commitment);
}

function isPubkeyEqual(a: PublicKey, b: PublicKey): boolean {
  // PublicKey.equals exists, but keep this ultra-safe for any polyfill edge
  try {
    return a.equals(b);
  } catch {
    return a.toBase58() === b.toBase58();
  }
}

async function resolveMintProgramId(conn: Connection, mintPk: PublicKey): Promise<PublicKey> {
  // Default to legacy SPL token program to preserve prior behavior.
  // If the mint account is owned by token-2022, we switch.
  try {
    const ai = await conn.getAccountInfo(mintPk, DEFAULT_COMMITMENT);
    const owner = ai?.owner;
    if (owner) {
      if (isPubkeyEqual(owner, TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
      if (isPubkeyEqual(owner, TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
      // Unknown owner: keep legacy default.
    }
  } catch {
    // If RPC fails, keep legacy default.
  }
  return TOKEN_PROGRAM_ID;
}

/**
 * Returns the decimals for a given SPL mint address.
 * If a Connection is passed, it will be used; otherwise we create one from env.
 *
 * Supports both legacy SPL Token and Token-2022 mints.
 */
export async function getMintDecimals(mintAddress: string, connection?: Connection): Promise<number> {
  const conn = connection ?? getServerConnection();
  const mintPk = new PublicKey(mintAddress);

  // Detect owning token program to ensure Token-2022 mints decode correctly.
  const programId = await resolveMintProgramId(conn, mintPk);

  // getMint signature supports optional programId parameter; we pass it explicitly.
  const info: Mint = await getMint(conn, mintPk, DEFAULT_COMMITMENT, programId);
  return info.decimals;
}

/**
 * Try variant that returns null on error (no throw), useful for diagnostics flows.
 */
export async function tryGetMintDecimals(mintAddress: string, connection?: Connection): Promise<number | null> {
  try {
    return await getMintDecimals(mintAddress, connection);
  } catch {
    return null;
  }
}

/**
 * Back-compat alias for older imports.
 * Some code imports { fetchMintDecimals } from "@/lib/solana-mint".
 * We point it to getMintDecimals to avoid breaking changes.
 */
export const fetchMintDecimals = getMintDecimals;

export type { Mint };
