// src/lib/program.server.ts
import * as anchor from "@coral-xyz/anchor";
import type { Idl, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, VersionedTransaction, Connection } from "@solana/web3.js";
import { getConnection } from "@/lib/solana.server";
import fs from "fs";
import path from "path";

/** Resolve & validate program ID from env, throw explicit error if invalid. */
function getValidatedProgramId(): PublicKey {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID as string) ||
    (process.env.VAULT_PROGRAM_ID as string) ||
    "";
  if (!raw) {
    throw new Error(
      "missing_program_id: Set NEXT_PUBLIC_VAULT_PROGRAM_ID or VAULT_PROGRAM_ID to your vault program address."
    );
  }
  try {
    return new PublicKey(raw);
  } catch (e: any) {
    throw new Error(
      `invalid_program_id:${raw.substring(0,8)}… -> ${e?.message || String(e)}`
    );
  }
}

/** Export the address string (for other modules that expect Address-like). */
export const VAULT_PROGRAM_ID: anchor.Address = getValidatedProgramId().toBase58();

/** Minimal wallet wrapper for Anchor provider */
class KpWallet implements anchor.Wallet {
  payer: Keypair;

  constructor(kp: Keypair) {
    this.payer = kp;
  }

  get publicKey() {
    return this.payer.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if ("sign" in (tx as any) && typeof (tx as any).sign === "function") {
      (tx as any).sign([this.payer]);
    } else {
      (tx as Transaction).partialSign(this.payer);
    }
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    for (const tx of txs) {
      if ("sign" in (tx as any) && typeof (tx as any).sign === "function") {
        (tx as any).sign([this.payer]);
      } else {
        (tx as Transaction).partialSign(this.payer);
      }
    }
    return txs;
  }
}

/** Build Anchor provider with RPC + optional headers */
function buildProvider(): anchor.AnchorProvider {
  const conn: Connection = getConnection();
  const dummy = Keypair.generate();
  const wallet = new KpWallet(dummy);
  // processed is fine for our use; change if you prefer finalized
  return new anchor.AnchorProvider(conn, wallet as any, {
    commitment: "processed",
  } as any);
}

/** Try IDL on-chain first; fall back to local vault_v2.json if present. */
async function loadIdl(provider: anchor.AnchorProvider): Promise<Idl> {
  const programId = getValidatedProgramId();
  // Try on-chain
  try {
    const idl = await anchor.Program.fetchIdl(programId, provider);
    if (idl) return idl as Idl;
  } catch {}
  // Fallback to local file at project root
  try {
    const root = process.cwd();
    const p = path.join(root, "vault_v2.json");
    const txt = fs.readFileSync(p, "utf8");
    const idl = JSON.parse(txt);
    if (idl && idl.metadata && !idl.metadata.address) {
      idl.metadata.address = programId.toBase58();
    }
    return idl as Idl;
  } catch {
    throw new Error(
      "idl_not_found: On-chain fetch failed and no vault_v2.json present next to package.json."
    );
  }
}

/**
 * Create the Program — ensure idl.metadata.address is set so Anchor
 * uses the (idl, provider) overload correctly.
 */
export async function getProgram(): Promise<Program<Idl>> {
  const provider = buildProvider();
  const idl = await loadIdl(provider);
  if (!idl) throw new Error("idl_null: Vault program IDL not found");
  if (!idl.metadata) (idl as any).metadata = {};
  if (!(idl.metadata as any).address) (idl.metadata as any).address = String(VAULT_PROGRAM_ID);
  return new anchor.Program(idl as Idl, provider);
}

/** PDA derivations */
export function deriveVaultPda(owner: PublicKey, setId16: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), Buffer.from(setId16)],
    getValidatedProgramId()
  )[0];
}

export function deriveVaultAuthorityPda(vaultPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), vaultPda.toBuffer()],
    getValidatedProgramId()
  )[0];
}
