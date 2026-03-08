// filepath: src/lib/ensure-authority-atas.client.ts
"use client";

/**
 * Client-side idempotent helper to create ATAs for the **vault authority** PDA.
 * This preserves the public API and UI/UX. It only optimizes RPC usage by
 * switching to the batched cache in '@/lib/rpc-cache'.
 */
import {
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC,
  TOKEN_2022_PROGRAM_ID as TOKEN_PROGRAM_2022,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  cachedGetAccountInfoOwner,
  cachedGetAccountInfo,
} from "@/lib/rpc-cache";
import {
  deriveVaultPda as deriveVaultPdaSdk,
  deriveVaultAuthorityPda as deriveAuthorityFromVault,
} from "@/lib/vault-sdk";

// ---------------------------------------------------------------------------

type WalletLike = {
  publicKey: PublicKey;
  sendTransaction: (tx: Transaction, conn: Connection, opts?: any) => Promise<string>;
};

function setIdToBytes16(setId: string): Uint8Array {
  const raw = (setId || "").trim();
  const m = raw.match(/^[0-9a-f]{32}$/i);
  if (m) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // Lightweight, stable hash for client-only derivations (server remains authoritative)
  const enc = new TextEncoder().encode(raw);
  let h1 = 0x9747b28c, k = 0;
  for (let i = 0; i < enc.length; i++) {
    k = enc[i];
    k = Math.imul(k, 0x5bd1e995);
    k ^= k >>> 24;
    k = Math.imul(k, 0x5bd1e995);
    h1 = Math.imul(h1 ^ k, 0x5bd1e995);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = (h1 >>> ((i % 4) * 8)) & 0xff;
  return out;
}

async function detectTokenProgramId(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await cachedGetAccountInfoOwner(conn, mint, "confirmed");
  if (!info.exists) throw new Error("mint_not_found");
  return info.owner!.equals(TOKEN_PROGRAM_2022) ? TOKEN_PROGRAM_2022 : TOKEN_PROGRAM_CLASSIC;
}

/**
 * Ensure ATAs for the vault authority PDA exist for the provided mints.
 * Returns a signature if it had to create any accounts; otherwise null.
 */
export async function ensureAuthorityAtasClient(args: {
  connection: Connection;
  walletLike: WalletLike;
  programId: PublicKey;
  setId: string;
  mints: (string | PublicKey)[];
}): Promise<string | null> {
  const { connection, walletLike, programId, setId, mints } = args;

  // derive vault + authority PDAs
  const setId16 = setIdToBytes16(setId);
  const v = (deriveVaultPdaSdk as any)(programId, walletLike.publicKey, setId16);
  const vault: PublicKey = Array.isArray(v) ? v[0] : v;
  const a = (deriveAuthorityFromVault as any)(programId, vault);
  const authority: PublicKey = Array.isArray(a) ? a[0] : a;

  const ixs = [];
  for (const m of mints || []) {
    if (!m) continue;
    const mintPk = typeof m === "string" ? new PublicKey(m) : m;
    const prog = await detectTokenProgramId(connection, mintPk);
    const ata = getAssociatedTokenAddressSync(
      mintPk,
      authority,
      true,
      prog,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const info = await cachedGetAccountInfo(connection, ata, "confirmed");
    if (!info) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          walletLike.publicKey,
          ata,
          authority,
          mintPk,
          prog,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }

  if (!ixs.length) return null;

  const tx = new Transaction().add(...ixs);
  tx.feePayer = walletLike.publicKey;
  const { blockhash } = await connection.getLatestBlockhash({ commitment: "processed" });
  tx.recentBlockhash = blockhash;
  const sig = await walletLike.sendTransaction(tx, connection, { skipPreflight: false });
  return sig;
}

// Compatibility alias for existing imports:
export const ensureAuthorityAtasForMintsClient = (args: any) =>
  ensureAuthorityAtasClient(args as any);
