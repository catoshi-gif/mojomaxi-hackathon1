// File: src/lib/anchorClient.ts
// Anchor client helpers compatible with Next.js 14.2.5.
// Fixes previous typing issues by avoiding problematic tuple types and using explicit option shapes.

import type { Idl, Program } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey, Connection } from '@solana/web3.js';

/** Minimal wallet shape Anchor needs */
export type WalletLike = {
  publicKey: PublicKey;
  signTransaction?: (tx: any) => Promise<any>;
  signAllTransactions?: (txs: any[]) => Promise<any[]>;
  // AnchorProvider will use `connection` to send; sendTransaction is optional here.
};

/** Provider options (explicit to avoid tuple-index types) */
export type ProviderOpts = {
  commitment?: anchor.web3.Commitment;
  preflightCommitment?: anchor.web3.Commitment;
};

/** Build an AnchorProvider in a Next-friendly way */
export function makeProvider(
  connection: Connection,
  wallet: WalletLike,
  opts?: ProviderOpts
): AnchorProvider {
  const commitment = opts?.commitment ?? 'confirmed';
  const preflightCommitment = opts?.preflightCommitment ?? 'confirmed';
  const provider = new anchor.AnchorProvider(connection, wallet as any, {
    commitment,
    preflightCommitment,
  });
  anchor.setProvider(provider);
  return provider;
}

/**
 * Load a typed Program<Idl> from a plain JSON idl.
 * Cast idl to unknown first to satisfy TS structural checks.
 */
export function loadProgram(params: {
  programId: PublicKey;
  connection: Connection;
  walletLike: WalletLike;
  idl: any; // pass your JSON IDL here (e.g., import vaultIdl from '@/lib/vault_v2.json')
}): Program<Idl> {
  const { programId, connection, walletLike, idl } = params;
  const provider = makeProvider(connection, walletLike);
  const safeIdl = (idl as unknown) as Idl;
  const program = new (anchor as any).Program(safeIdl, programId, provider) as Program<Idl>;
  return program;
}

export default loadProgram;
