// filepath: src/app/api/vaults/deposit/route.ts
// RUNTIME: nodejs (edge-incompatible due to web3 imports)
// PURPOSE: Build a user-signed transaction that deposits tokens into the vault authority ATA.
// SAFETY ADDITIONS (preserve behavior):
//   - Idempotently create ATAs for user + authority for the deposit mint.
//   - Idempotently pre-create Authority ATAs for Token A and Token B of the set (when known).
//   - SOFT GUARD (additive): if we can read the set and its prefs (mintA/mintB or mintIn/mintOut),
//     only allow deposits for those mints (prevents "rogue" third mint ATAs). If prefs are missing,
//     we do NOT block (to avoid breaking existing flows).
//   - NOTE: This route *does not* execute swaps; "running" checks live in the swap routes
//           (e.g., src/app/api/vaults/execute-swap/route.ts and ingest/[id]/route.ts).
//
// Request body (backwards compatible keys):
//   {
//     ownerPubkey: string,     // user wallet (payer & owner of source ATA)
//     setId: string,           // 16-byte hex (preferred) or any string (md5/xor hashed to 16-bytes depending on setKind)
//     mint?: string,           // mint to deposit (Token B in your UX)  [alias: depositMint]
//     depositMint?: string,
//     amount?: string|number,  // ATOMS (preferred). If client only has UI, pass amountUi + decimals.
//     amountUi?: string,       // optional: UI units (string)
//     decimals?: number,       // optional override; server can auto-detect
//     tokenAMint?: string,     // optional: pre-create vault ATA for this mint (no transfer)
//     tokenBMint?: string,     // optional: pre-create vault ATA for this mint (no transfer)
//     setKind?: "webhook" | "rebalance" | string // optional; default "webhook"
//   }
//
// Response (unchanged shape; additive diagnostics):
//   { ok: true, txBase64, vaultPda, createdAtas: string[], deposit: { mint, authorityAta, amount, decimals } }
//   { ok: false, error, detail? }
//
// Golden rule respected: no UI/UX changes.

import { NextRequest, NextResponse } from "next/server";
import { PublicKey, Connection, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import { getSetById } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- Utilities ---------------------------------------------------------------

type IdlShape = { address?: string };

function getCommitment(): "processed" | "confirmed" | "finalized" {
  return (process.env.SOLANA_COMMITMENT as any) || "processed";
}

function getRpcUrl(): string {
  return (
    process.env.SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}

function getConn(): Connection {
  return new Connection(getRpcUrl(), { commitment: getCommitment() });
}

function getProgramId(): PublicKey {
  try {
    const env = (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID || "").trim();
    if (env) return new PublicKey(env);
  } catch {}
  // Try IDL
  try {
    const idlPath = path.resolve(process.cwd(), "src/idl/mojomaxi_vault.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8")) as IdlShape;
    if (idl && idl.address) return new PublicKey(idl.address);
  } catch {}
  // final fallback: program id from docs
  return new PublicKey("2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp");
}

const VAULT_SEED = Buffer.from("vault");
const VAULT_AUTH_SEED = Buffer.from("vault_authority");

/** 16-byte derivation — mirrors executeSwapCPI.server.ts behavior (default kind='webhook'). */
function setIdTo16BytesFlexible(setId: string, kind?: string): Uint8Array {
  const k = String(kind || "webhook").toLowerCase();
  const raw = String(setId || "").replace(/-/g, "");
  if (k === "webhook") {
    const hex = raw.toLowerCase();
    if (/^[0-9a-f]{32}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
    // md5 fallback for legacy/short ids (keeps stable derivation)
    return Uint8Array.from(crypto.createHash("md5").update(raw).digest());
  }
  // For non-webhook kinds (e.g., rebalance) keep stable 16 bytes with xor+ascii scheme
  const ascii = Buffer.from(raw.substring(0, 32), "utf8");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = ascii[i % ascii.length] ^ ((i * 131) & 0xff);
  return out;
}

function deriveVaultPda(owner: PublicKey, setId: string, kind?: string): [PublicKey, number] {
  const pid = getProgramId();
  const seed16 = setIdTo16BytesFlexible(setId, kind);
  return PublicKey.findProgramAddressSync([VAULT_SEED, owner.toBuffer(), Buffer.from(seed16)], pid);
}

function deriveVaultAuthorityPda(vault: PublicKey): [PublicKey, number] {
  const pid = getProgramId();
  return PublicKey.findProgramAddressSync([VAULT_AUTH_SEED, vault.toBuffer()], pid);
}

async function detectMintProgramAndDecimals(conn: Connection, mint: PublicKey): Promise<{ programId: PublicKey; decimals: number }> {
  const info = await conn.getAccountInfo(mint, getCommitment());
  const owner = info?.owner;
  const programId =
    owner && owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
  const dec = (await getMint(conn, mint, getCommitment(), programId)).decimals;
  return { programId, decimals: dec };
}

function uiToAtoms(ui: string, decimals: number): bigint {
  const s = String(ui ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("bad_amount_ui");
  const [i, f = ""] = s.split(".");
  const frac = f.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(i) * (BigInt(10) ** BigInt(decimals)) + BigInt(frac || "0");
}

// --- Handler ----------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const ownerStr = String(body.ownerPubkey || body.owner || body.admin || "").trim();
    const setIdStr = String(body.setId || body.set || "").trim();
    const mintStr  = String(body.mint || body.depositMint || "").trim();
    const setKind  = String(body.setKind || "webhook").toLowerCase();

    if (!ownerStr || !setIdStr || !mintStr) {
      return NextResponse.json({ ok: false, error: "missing_params" }, { status: 400 });
    }

    const owner = new PublicKey(ownerStr);
    const mint  = new PublicKey(mintStr);

    const conn = getConn();
    const { programId: tokenProgramId, decimals: chainDecimals } = await detectMintProgramAndDecimals(conn, mint);

    // amount: prefer atoms; else convert UI using (provided || on-chain) decimals
    let decimals = typeof body.decimals === "number" ? Number(body.decimals) : chainDecimals;
    let amountAtoms: bigint;
    if (body.amount != null && String(body.amount).trim() !== "") {
      amountAtoms = BigInt(String(body.amount));
    } else if (body.amountUi != null && String(body.amountUi).trim() !== "") {
      amountAtoms = uiToAtoms(String(body.amountUi), decimals);
    } else {
      return NextResponse.json({ ok: false, error: "missing_amount" }, { status: 400 });
    }
    if (amountAtoms <= 0n) return NextResponse.json({ ok: false, error: "zero_amount" }, { status: 400 });

    // Derive vault + authority
    const [vault] = deriveVaultPda(owner, setIdStr, setKind);
    const [vaultAuthority] = deriveVaultAuthorityPda(vault);

    // --- SOFT GUARD: restrict deposit mint to set's A/B when available -------------
    // We do not reject if the set cannot be read or prefs are missing (no behavior change).
    try {
      const set = await getSetById(setIdStr);
      const pref = (set as any)?.prefs || {};
      const a = String(pref.mintA || pref.mintIn || "").trim();
      const b = String(pref.mintB || pref.mintOut || "").trim();
      if (a && b) {
        const ok = mint.toBase58() === a || mint.toBase58() === b;
        if (!ok) {
          return NextResponse.json(
            { ok: false, error: "deposit_mint_not_allowed", detail: "Vault only accepts Token A or Token B for this set." },
            { status: 400 }
          );
        }
      }
    } catch {
      // swallow — do not change behavior if store unavailable
    }

    // Compute ATAs
    const userAta = getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
    const authAta = getAssociatedTokenAddressSync(mint, vaultAuthority, true,  tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

    // Instructions (idempotent ATA create for user + authority + pre-create A/B authority ATAs)
    const ixs = [];

    // Ensure user's *source* ATA exists (idempotent)
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userAta, owner, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    // Ensure authority's *dest* ATA exists (idempotent)
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner, authAta, vaultAuthority, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    // Optional pre-creation for Token A/B authority ATAs (if caller passes hints)
    const hintMints = new Set<string>();
    for (const key of ["tokenAMint", "tokenBMint"]) {
      const v = (body as any)?.[key];
      if (typeof v === "string" && v.trim().length) hintMints.add(String(v));
    }
    // Also add mints from store if available (and distinct)
    try {
      const set = await getSetById(setIdStr);
      const pref = (set as any)?.prefs || {};
      const a = String(pref.mintA || pref.mintIn || "").trim();
      const b = String(pref.mintB || pref.mintOut || "").trim();
      if (a) hintMints.add(a);
      if (b) hintMints.add(b);
    } catch {}

    const createdAtas: string[] = [];
    for (const m of hintMints) {
      try {
        const mPk = new PublicKey(m);
        const info = await conn.getAccountInfo(mPk, getCommitment());
        const prog =
          info?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID :
          TOKEN_PROGRAM_ID; // default classic
        const ata = getAssociatedTokenAddressSync(mPk, vaultAuthority, true, prog, ASSOCIATED_TOKEN_PROGRAM_ID);
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            owner, ata, vaultAuthority, mPk, prog, ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
        createdAtas.push(ata.toBase58());
      } catch {}
    }

    // Transfer (checked)
    ixs.push(
      createTransferCheckedInstruction(userAta, mint, authAta, owner, Number(amountAtoms), decimals, [], tokenProgramId)
    );

    // Build & return v0 tx (user signs & sends)
    const { blockhash } = await conn.getLatestBlockhash({ commitment: getCommitment() });
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const txBase64 = Buffer.from(tx.serialize()).toString("base64");

    return NextResponse.json({
      ok: true,
      txBase64,
      vaultPda: vault.toBase58(),
      createdAtas,
      deposit: { mint: mint.toBase58(), authorityAta: authAta.toBase58(), amount: amountAtoms.toString(), decimals }
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "internal", detail: e?.message || String(e) }, { status: 500 });
  }
}
