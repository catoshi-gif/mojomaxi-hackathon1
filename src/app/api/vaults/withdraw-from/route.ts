// filepath: src/app/api/vaults/withdraw-from/route.ts
// PURPOSE: Build a withdraw tx that drains **a specific custody token account** (vaultToken) to the user's ATA.
//          Useful for healing non-canonical custody accounts (non-ATA under authority or any vault-owned account).
// INPUT: { admin, setId, mint, vaultToken, amountUi?, decimals? }
// OUTPUT: { ok, tx64, vault, userAta, vaultToken, amountAtoms }
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";
import crypto from "crypto";
import fs from "fs";
import path from "path";

function rpcUrl(): string {
  return (
    process.env.HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  ).trim();
}
function commitment(): "processed" | "confirmed" | "finalized" {
  return (process.env.SOLANA_COMMITMENT as any) || "confirmed";
}
function conn(): Connection {
  return new Connection(rpcUrl(), { commitment: commitment() });
}

function getProgramId(): PublicKey {
  try {
    const idlPath = path.resolve(process.cwd(), "src/idl/mojomaxi_vault.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const addr = idl?.metadata?.address || idl?.address;
    if (addr) return new PublicKey(addr);
  } catch {}
  const env = (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID || "").trim();
  if (env) return new PublicKey(env);
  return new PublicKey("2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp");
}

const VAULT_SEED = Buffer.from("vault");
const AUTH_SEED  = Buffer.from("vault_authority");

function setIdToBytes16(setId: string): Uint8Array {
  const s = String(setId || "").trim();
  const hex = /^[0-9a-fA-F]{32}$/.test(s) ? s : Buffer.from(s).toString("hex").slice(0, 32).padEnd(32, "0");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
function deriveVault(admin: PublicKey, setId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, admin.toBuffer(), Buffer.from(setIdToBytes16(setId))], getProgramId());
}
function deriveAuth(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AUTH_SEED, vault.toBuffer()], getProgramId());
}

async function detectProgramAndDecimals(mint: PublicKey): Promise<{ programId: PublicKey, decimals: number }> {
  const c = conn();
  const info = await c.getAccountInfo(mint, commitment());
  if (!info) throw new Error("mint_not_found");
  if (info.owner.equals(TOKEN_PROGRAM_CLASSIC)) {
    const m = await getMint(c, mint, commitment(), TOKEN_PROGRAM_CLASSIC);
    return { programId: TOKEN_PROGRAM_CLASSIC, decimals: m.decimals };
  } else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const m = await getMint(c, mint, commitment(), TOKEN_2022_PROGRAM_ID);
    return { programId: TOKEN_2022_PROGRAM_ID, decimals: m.decimals };
  }
  throw new Error("unsupported_mint_program");
}

function uiToAtoms(ui: string, decimals: number): bigint {
  const s = String(ui).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("bad_amount_ui");
  const [i, f = ""] = s.split(".");
  const frac = f.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(i) * (BigInt(10) ** BigInt(decimals)) + BigInt(frac || "0");
}
function encodeWithdrawIxData(amount: bigint): Buffer {
  const disc = crypto.createHash("sha256").update("global:withdraw").digest().subarray(0, 8);
  const buf = Buffer.alloc(8 + 8);
  const a = BigInt.asUintN(64, amount);
  disc.copy(buf, 0);
  buf.writeUInt32LE(Number(a & 0xffffffffn), 8);
  buf.writeUInt32LE(Number((a >> 32n) & 0xffffffffn), 12);
  return buf;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const adminStr  = String(body.admin || req.headers.get("x-wallet") || "");
    const mintStr   = String(body.mint || "");
    const setIdStr  = String(body.setId || body.set || "");
    const vaultStr  = body.vault ? String(body.vault) : "";
    const srcStr    = String(body.vaultToken || body.source || "");
    const amountUiS = body.amountUi != null ? String(body.amountUi) : "";
    const decimalsIn = typeof body.decimals === "number" ? Number(body.decimals) : undefined;

    if (!adminStr || !mintStr || (!vaultStr && !setIdStr) || !srcStr) {
      return NextResponse.json({ ok: false, error: "missing_params" }, { status: 400 });
    }
    const admin = new PublicKey(adminStr);
    const mint  = new PublicKey(mintStr);
    const src   = new PublicKey(srcStr);

    const { programId: tokenProgramId, decimals } = await detectProgramAndDecimals(mint);
    const usedDecimals = decimalsIn ?? decimals;

    const vault = vaultStr ? new PublicKey(vaultStr) : deriveVault(admin, setIdStr)[0];
    const [auth]  = deriveAuth(vault);
    const userAta = getAssociatedTokenAddressSync(mint, admin, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

    // Decide amount: withdraw full src balance unless amount specified
    let amountAtoms: bigint;
    if (amountUiS) {
      amountAtoms = uiToAtoms(amountUiS, usedDecimals);
    } else {
      try {
        const c = conn();
        const b = await c.getTokenAccountBalance(src, commitment());
        amountAtoms = BigInt(String(b?.value?.amount || "0"));
      } catch {
        amountAtoms = 0n;
      }
    }
    if (amountAtoms <= 0n) return NextResponse.json({ ok: false, error: "no_funds" }, { status: 400 });

    const ixs: TransactionInstruction[] = [];
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        admin, userAta, admin, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    ixs.push(new TransactionInstruction({
      programId: getProgramId(),
      keys: [
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: auth,  isSigner: false, isWritable: false },
        { pubkey: src,   isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: mint,  isSigner: false, isWritable: false },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      ],
      data: encodeWithdrawIxData(amountAtoms),
    }));

    const c = conn();
    const { blockhash } = await c.getLatestBlockhash({ commitment: "processed" });
    const msg = new TransactionMessage({ payerKey: admin, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const tx64 = Buffer.from(tx.serialize()).toString("base64");

    return NextResponse.json({
      ok: true,
      tx64,
      vault: vault.toBase58(),
      userAta: userAta.toBase58(),
      vaultToken: src.toBase58(),
      amountAtoms: amountAtoms.toString(),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }
}
