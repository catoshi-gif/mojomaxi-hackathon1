// filepath: src/app/api/vaults/withdraw/route.ts
// BUILD_TAG: withdraw-dual-source-atas (authority-or-vault), Token-2022 compatible
// PURPOSE: Build a user-signed v0 transaction calling on-chain `withdraw` (transfer_checked)
//          selecting the correct custody source account **either** the Authority ATA or the Vault ATA.
// NOTE: This is an additive fix to handle cases where funds sit in the vault-owned ATA.
//       UI/UX unchanged. Route signature unchanged.
//
// Request JSON:
//   { admin, setId, mint, amountUi?, decimals? }
// Response JSON:
//   { ok, tx64, vault, mint, amountAtoms, userAta, vaultToken, vaultTokenOwner }
//
// This file intentionally avoids Anchor client and manually encodes the instruction discriminator.
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
import { ensureConnection } from "@/lib/rpc";
import crypto from "crypto";
import fs from "fs";
import path from "path";

function commitment(): "processed" | "confirmed" | "finalized" {
  return (process.env.SOLANA_COMMITMENT as any) || "confirmed";
}
function conn(): Connection {
  return ensureConnection();
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
  // Match client-side uuidToBytes16 (vault-sdk.ts) so that vault derivation is consistent across UI + server.
  const raw = String(setId || "").replace(/-/g, "");
  if (/^[0-9a-fA-F]{16,32}$/.test(raw)) {
    const hex = raw.slice(0, 32).padEnd(32, "0");
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  const enc = Buffer.from(String(setId || "mm"), "utf8");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = enc[i % enc.length] ^ ((i * 131) & 0xff);
  return out;
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
  if (!s) return 0n;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("bad_amount_ui");
  const [i, f = ""] = s.split(".");
  const frac = f.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(i) * (BigInt(10) ** BigInt(decimals)) + BigInt(frac || "0");
}

function encodeWithdrawIxData(amount: bigint): Buffer {
  // Anchor discriminator = sha256('global:withdraw').slice(0, 8)
  const disc = crypto.createHash("sha256").update("global:withdraw").digest().subarray(0, 8);
  const buf = Buffer.alloc(16);
  disc.copy(buf, 0);
  // write u64 LE at offset 8..15
  const a = BigInt.asUintN(64, amount);
  buf.writeUInt32LE(Number(a & 0xffffffffn), 8);
  buf.writeUInt32LE(Number((a >> 32n) & 0xffffffffn), 12);
  return buf;
}

async function readTokenBalance(pk: PublicKey): Promise<bigint> {
  try {
    const c = conn();
    const bal = await c.getTokenAccountBalance(pk, commitment());
    return BigInt(String(bal?.value?.amount || "0"));
  } catch {
    return 0n;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const walletHeader = String(req.headers.get("x-wallet") || "");
    const adminStr  = String(body.admin || body.owner || walletHeader || "");
    const mintStr   = String(body.mint || "");
    const setIdStr  = String(body.setId || body.set || "");
    const amountUiS = body.amountUi != null ? String(body.amountUi) : "";

    if (!adminStr || !mintStr || !setIdStr) {
      return NextResponse.json({ ok: false, error: "missing_params" }, { status: 400 });
    }

    const admin = new PublicKey(adminStr);
    const mint  = new PublicKey(mintStr);

    const { programId: tokenProgramId, decimals: chainDecimals } = await detectProgramAndDecimals(mint);
    const decimalsIn = typeof body.decimals === "number" ? Number(body.decimals) : chainDecimals;

    const [vault] = deriveVault(admin, setIdStr);
    const [auth]  = deriveAuth(vault);

    // Candidate custody sources: authority ATA vs vault ATA (both are valid in program)
    const vAtaAuth  = getAssociatedTokenAddressSync(mint, auth,  true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
    const vAtaVault = getAssociatedTokenAddressSync(mint, vault, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

    // Ensure user ATA (idempotent)
    const userAta = getAssociatedTokenAddressSync(mint, admin, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

    // If `amountUi` omitted, withdraw full balance from whichever custody has funds.
    const desiredAtoms = amountUiS ? uiToAtoms(amountUiS, decimalsIn) : 0n;

    // Read balances
    const balAuth  = await readTokenBalance(vAtaAuth);
    const balVault = await readTokenBalance(vAtaVault);

    // Choose source
    type Cand = { owner: "authority" | "vault", pk: PublicKey, bal: bigint };
    const cands: Cand[] = [
      { owner: "authority", pk: vAtaAuth,  bal: balAuth },
      { owner: "vault",     pk: vAtaVault, bal: balVault },
    ];
    let chosen: Cand | undefined;
    if (desiredAtoms > 0n) {
      chosen = cands.find(c => c.bal >= desiredAtoms) || cands.sort((a,b)=> (b.bal - a.bal) > 0n ? 1 : -1)[0];
    } else {
      chosen = cands.sort((a,b)=> (b.bal - a.bal) > 0n ? 1 : -1)[0];
    }
    if (!chosen || chosen.bal <= 0n) {
      return NextResponse.json({ ok: false, error: "no_funds" }, { status: 400 });
    }

    const fromVaultToken = chosen.pk;
    const amountAtoms = desiredAtoms > 0n ? desiredAtoms : chosen.bal;

    // Build ixs
    const ixs: TransactionInstruction[] = [];
    // ensure user ATA
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        admin, // payer
        userAta,
        admin, // owner
        mint,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    // program withdraw ix
    ixs.push(new TransactionInstruction({
      programId: getProgramId(),
      keys: [
        { pubkey: admin,          isSigner: true,  isWritable: true  },
        { pubkey: vault,          isSigner: false, isWritable: true  },
        { pubkey: auth,           isSigner: false, isWritable: false },
        { pubkey: fromVaultToken, isSigner: false, isWritable: true  },
        { pubkey: userAta,        isSigner: false, isWritable: true  },
        { pubkey: mint,           isSigner: false, isWritable: false },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      ],
      data: encodeWithdrawIxData(amountAtoms),
    }));

    // v0 tx
    const c = conn();
    const { blockhash } = await c.getLatestBlockhash({ commitment: "processed" });
    const msg = new TransactionMessage({
      payerKey: admin,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const tx64 = Buffer.from(tx.serialize()).toString("base64");

    return NextResponse.json({
      ok: true,
      tx64,
      vault: vault.toBase58(),
      mint: mint.toBase58(),
      amountAtoms: amountAtoms.toString(),
      userAta: userAta.toBase58(),
      vaultToken: fromVaultToken.toBase58(),
      vaultTokenOwner: chosen.owner,
      vaultTokenBalanceRaw: chosen.bal.toString(),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }
}
