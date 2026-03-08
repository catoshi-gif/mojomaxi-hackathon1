
"use client";

import React, { useCallback, useState } from "react";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const VAULT_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID ||
    process.env.VAULT_PROGRAM_ID ||
    "2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp"
);

// sha256("global:init_vault").slice(0,8)
const DISC_INIT_VAULT = Buffer.from("4d4f559621d9346a", "hex");

function setIdTo16Bytes(setId: string): Buffer {
  const hex = setId.replace(/-/g, "").toLowerCase();
  const h = hex.length >= 32 ? hex.slice(0, 32) : hex.padEnd(32, "0");
  return Buffer.from(h, "hex");
}

type Props = {
  setId: string;
  mintA: string;
  mintB: string;
  className?: string;
  onCreated?: (args: { vault: string; vaultAuthority: string }) => void;
  children?: React.ReactNode;
};

export default function CreateVaultButton({ setId, mintA, mintB, className, onCreated, children }: Props) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setErr(null);
    if (!wallet?.publicKey || !wallet.sendTransaction) {
      setErr("Connect wallet first.");
      return;
    }
    setBusy(true);
    try {
      const owner = wallet.publicKey;
      const set16 = setIdTo16Bytes(setId);

      // Derive PDAs
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.toBuffer(), set16],
        VAULT_PROGRAM_ID
      );
      const [vaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority"), vault.toBuffer()],
        VAULT_PROGRAM_ID
      );

      // If vault not program-owned, include init_vault
      const vInfo = await connection.getAccountInfo(vault, "confirmed");

      const ixs: TransactionInstruction[] = [];

      if (!vInfo || !vInfo.owner.equals(VAULT_PROGRAM_ID)) {
        const data = Buffer.concat([
          DISC_INIT_VAULT,
          owner.toBuffer(),
          set16,
        ]);
        const initIx = new TransactionInstruction({
          programId: VAULT_PROGRAM_ID,
          keys: [
            { pubkey: owner,        isWritable: true,  isSigner: true  }, // payer/admin
            { pubkey: owner,        isWritable: false, isSigner: false }, // owner
            { pubkey: vault,        isWritable: true,  isSigner: false },
            { pubkey: vaultAuthority, isWritable: false, isSigner: false },
            { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
          ],
          data,
        });
        ixs.push(initIx);
      }

      // Ensure both ATAs exist under vaultAuthority (A & B)
      const mA = new PublicKey(mintA);
      const mB = new PublicKey(mintB);
      const ataA = getAssociatedTokenAddressSync(mA, vaultAuthority, true);
      const ataB = getAssociatedTokenAddressSync(mB, vaultAuthority, true);

      const [infoA, infoB] = await Promise.all([
        connection.getAccountInfo(ataA, "confirmed"),
        connection.getAccountInfo(ataB, "confirmed"),
      ]);

      if (!infoA) {
        ixs.push(
          createAssociatedTokenAccountInstruction(
            owner, ataA, vaultAuthority, mA, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
      if (!infoB) {
        ixs.push(
          createAssociatedTokenAccountInstruction(
            owner, ataB, vaultAuthority, mB, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      if (!ixs.length) {
        setBusy(false);
        onCreated?.({ vault: vault.toBase58(), vaultAuthority: vaultAuthority.toBase58() });
        return;
      }

      const tx = new Transaction().add(...ixs);
      tx.feePayer = owner;
      const sig = await wallet.sendTransaction(tx, connection, { skipPreflight: false });
      await connection.confirmTransaction(sig, "confirmed");

      onCreated?.({ vault: vault.toBase58(), vaultAuthority: vaultAuthority.toBase58() });
      setBusy(false);
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || String(e));
      setBusy(false);
    }
  }, [wallet, connection, setId, mintA, mintB, onCreated]);

  return (
    <button
      className={className}
      onClick={handleClick}
      disabled={busy || !wallet?.publicKey}
      title={!wallet?.publicKey ? "Connect wallet first" : undefined}
    >
      {busy ? "Creating vault…" : (children ?? "Create Vault")}
      {err && <span className="ml-2 text-red-500 text-xs">{err}</span>}
    </button>
  );
}

