// filepath: src/lib/vault-atas.server.ts
// Server-only helpers to ensure Associated Token Accounts (ATAs) for the **vault authority**.
// This module is intentionally self-contained (no Anchor dependency) and production safe.
// It supports both classic SPL-Token and Token-2022 mints and is idempotent.

import 'server-only';

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { getConnection } from '@/lib/solana.server';
import { getRelayer } from '@/lib/relayer.server';
import {
  deriveVaultPda as deriveVaultPdaProgram,
  deriveVaultAuthorityPda as deriveAuthorityPdaProgram,
} from '@/lib/program.server';

/** --- utilities --- */

function setIdToBytes16(setId: string): Uint8Array {
  // If already 32 hex chars (16 bytes), use directly; else MD5 of input
  const raw = (setId || '').trim();
  const hex32 = /^[0-9a-f]{32}$/i;
  if (hex32.test(raw)) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.createHash('md5').update(raw, 'utf8').digest();
}

async function detectTokenProgramId(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const ai = await conn.getAccountInfo(mint, { commitment: 'confirmed' });
  if (!ai) throw new Error(`mint_not_found:${mint.toBase58()}`);
  const owner = ai.owner?.toBase58?.() || '';
  if (owner === TOKEN_PROGRAM_CLASSIC.toBase58()) return TOKEN_PROGRAM_CLASSIC;
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  // Defensive default: treat unknown as classic to avoid breaking callers.
  return TOKEN_PROGRAM_CLASSIC;
}

/** Exported helper so routes can fetch addresses without side-effects. */
export async function deriveVaultAndAuthorityForSet(setId: string): Promise<{ vault: string; authority: string }> {
  const relayer = getRelayer();
  const seed16 = setIdToBytes16(setId);
  const vaultPda = deriveVaultPdaProgram(relayer.publicKey, seed16);
  const authPda = deriveAuthorityPdaProgram(vaultPda);
  return { vault: vaultPda.toBase58(), authority: authPda.toBase58() };
}

/** Core creator that ensures ATAs for a given *authority* PDA. */
async function ensureAtasForAuthority(params: {
  authority: PublicKey;
  mints: string[];
}): Promise<{ created: string[]; existed: string[]; authority: string }> {
  const uniqueMints = Array.from(new Set((params.mints || []).filter(Boolean)));
  const relayer = getRelayer();
  const conn = getConnection();
  const created: string[] = [];
  const existed: string[] = [];
  const ixs: any[] = [];

  for (const mint58 of uniqueMints) {
    const mintPk = new PublicKey(mint58);
    const tokenProgramId = await detectTokenProgramId(conn, mintPk);
    const ata = getAssociatedTokenAddressSync(
      mintPk,
      params.authority,
      true /* owner off-curve (PDA) */,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const info = await conn.getAccountInfo(ata, { commitment: 'confirmed' });
    if (info) {
      existed.push(ata.toBase58());
    } else {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          relayer.publicKey /* payer */,
          ata /* ata */,
          params.authority /* owner */,
          mintPk /* mint */,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      created.push(ata.toBase58());
    }
  }

  if (ixs.length) {
    const MAX_ATA_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_ATA_RETRIES; attempt++) {
      try {
        const tx = new Transaction().add(...ixs);
        tx.feePayer = relayer.publicKey;
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash({ commitment: 'processed' });
        tx.recentBlockhash = blockhash;
        tx.partialSign(relayer);
        const sig = await conn.sendTransaction(tx, [relayer] as unknown as Keypair[], { preflightCommitment: 'processed' });
        // Mandatory confirmation: downstream swaps depend on ATAs existing on-chain
        try {
          await conn.confirmTransaction(
            { signature: sig, blockhash, lastValidBlockHeight },
            'confirmed'
          );
        } catch (e: any) {
          console.warn('[vault-atas] confirmTransaction failed (ATA may still have landed):', e?.message || e);
        }
        break; // success — exit retry loop
      } catch (e: any) {
        const isRetriable = /timeout|502|503|429|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(e?.message || e));
        if (!isRetriable || attempt === MAX_ATA_RETRIES - 1) {
          console.error(`[vault-atas] send failed after ${attempt + 1} attempt(s):`, e?.message || e);
          throw e;
        }
        // Exponential backoff: 500ms, 1500ms, 3500ms
        const backoff = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        console.warn(`[vault-atas] send attempt ${attempt + 1} failed, retrying in ${backoff}ms:`, e?.message || e);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  return { created, existed, authority: params.authority.toBase58() };
}

/**
 * Primary API: ensure ATAs for the authority derived from (relayer_pubkey, setId).
 * This is kept intact for rebalance flows that operate by setId only.
 */
export async function ensureVaultAuthorityAtas(params: {
  setId: string;
  mints: string[]; // can include duplicates; they are de-duped internally
}): Promise<{ created: string[]; existed: string[]; authority: string }> {
  const { setId } = params;
  const { authority } = await deriveVaultAndAuthorityForSet(setId);
  return ensureAtasForAuthority({ authority: new PublicKey(authority), mints: params.mints });
}

/**
 * Compatibility alias for callers expecting ensureVaultAtasForMints.
 * ✅ FIXED behavior:
 *    • If args.setId is provided -> use setId derivation (existing behavior).
 *    • Else if args.vault is provided -> derive authority from *vault* PDA and ensure ATAs.
 *    • Else if args.authority is provided -> use it directly.
 *    • Otherwise, throw a clear error (previously would silently derive from an empty seed).
 */
export async function ensureVaultAtasForMints(
  args: { setId?: string; vault?: string; authority?: string; mints: string[] } & Record<string, unknown>
): Promise<{ created: string[]; existed: string[]; authority: string }> {
  const conn = getConnection(); // ensure RPC is initialized for downstream helpers

  const mints = Array.from(new Set((args.mints || []).filter(Boolean)));
  if (!mints.length) {
    // Still return authority if derivable, else empty string
    if (args.setId) {
      const { authority } = await deriveVaultAndAuthorityForSet(args.setId);
      return { created: [], existed: [], authority };
    }
    if (args.vault) {
      const auth = deriveAuthorityPdaProgram(new PublicKey(args.vault));
      return { created: [], existed: [], authority: auth.toBase58() };
    }
    if (args.authority) {
      return { created: [], existed: [], authority: new PublicKey(args.authority).toBase58() };
    }
    throw new Error('ensure_vault_atas_missing_params');
  }

  if (args.setId) {
    return ensureVaultAuthorityAtas({ setId: String(args.setId), mints });
  }

  if (args.vault) {
    const auth = deriveAuthorityPdaProgram(new PublicKey(String(args.vault)));
    return ensureAtasForAuthority({ authority: auth, mints });
  }

  if (args.authority) {
    const auth = new PublicKey(String(args.authority));
    return ensureAtasForAuthority({ authority: auth, mints });
  }

  // Last-resort explicit error (prevents silent wrong-PDA behavior).
  throw new Error('ensure_vault_atas_missing_params');
}
