// RUNTIME: nodejs
import { redis } from "@/lib/redis";
// PURPOSE: Build a single user-signed transaction that (1) creates the vault
//          and (2) idempotently creates the Authority ATAs for any provided mints.
//          This removes the extra wallet prompt that used to come from a
//          follow-up client ATA creation transaction, without changing UI/UX.
//
// Request JSON:
//   { admin: string, setId: string, mints?: string[] }
//
// Response JSON (unchanged shape + extra meta fields):
//   { ok: true, tx64?: string, meta: { admin, setId, programId, vault, authority, feeBps, ata: { created: string[], existed: string[], mints: string[] } }, already?: boolean } }
//
// Notes:
//   • Uses Anchor-style discriminator for `global:init_vault`.
//   • All ATA creates use createAssociatedTokenAccountIdempotentInstruction.
//
// CHANGELOG (2025-11-25):
//   • FIX: Incorrect associated token program id was passed to
//     createAssociatedTokenAccountIdempotentInstruction, which caused the first
//     instruction to target the System Program and fail with
//     "Program 11111111111111111111111111111111 failed: invalid instruction data".
//     We now call the helper with the standard 5-arg form, which defaults the
//     associated token program to ASSOCIATED_TOKEN_PROGRAM_ID.

import { NextResponse } from "next/server";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { ensureConnection } from "@/lib/vault-sdk";
import { upsertGlobalTokenLogos } from "@/lib/tokenLogoRegistry.server";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------- small utils ----------
function errJson(status: number, payload: any) { return NextResponse.json(payload, { status }); }

function readProgramId(): PublicKey {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID as string) ||
    (process.env.VAULT_PROGRAM_ID as string) ||
    "2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp";
  return new PublicKey(raw);
}

function readFeeBps(): number {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_FEE_BPS as string) ||
    (process.env.VAULT_FEE_BPS as string) ||
    (process.env.TREASURY_FEE_BPS as string) ||
    "50";
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : 50;
}

/** 16 bytes for setId. Accepts 32-hex; otherwise MD5 of the raw string (legacy compatible). */
function setIdToBytes16(setId: string): Uint8Array {
  const raw = String(setId || "").trim().replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    return Uint8Array.from(Buffer.from(raw, "hex"));
  }
  return Uint8Array.from(crypto.createHash("md5").update(raw, "utf8").digest());
}

function discInitVault(): Buffer {
  // Anchor discriminator for "global:init_vault"
  return crypto.createHash("sha256").update("global:init_vault").digest().subarray(0, 8);
}

async function detectTokenProgramForMint(mint: PublicKey, conn: any): Promise<PublicKey> {
  const ai = await conn.getAccountInfo(mint, { commitment: "confirmed" });
  const owner58 = ai?.owner?.toBase58?.() || "";
  if (owner58 === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_CLASSIC;
}

// ---------- main handler ----------
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const adminStr = String(body?.admin || "");
    const setId = String(body?.setId || "");
    const mintsIn = Array.isArray(body?.mints) ? (body.mints as any[]).map((m) => String(m || "").trim()).filter(Boolean) : [];
    const logos = (body && typeof body?.logos === "object") ? (body.logos as Record<string, string>) : undefined;

    if (!adminStr) return errJson(400, { ok: false, stage: "input", error: "missing_admin" });
    if (!setId)    return errJson(400, { ok: false, stage: "input", error: "missing_setId" });

    // Best-effort: persist global token logos once vault is being created.
    try { if (logos && Object.keys(logos).length) { await upsertGlobalTokenLogos(logos); } } catch {}

    const admin = new PublicKey(adminStr);
    const programId = readProgramId();
    const feeBps = readFeeBps();
    const conn = ensureConnection();

    const setId16 = setIdToBytes16(setId);
    const vault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault", "utf8"), admin.toBuffer(), Buffer.from(setId16)],
      readProgramId()
    )[0];
    const authority = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority", "utf8"), vault.toBuffer()],
      readProgramId()
    )[0];

    // If vault already exists and is owned by program, short-circuit
    try {
      const info = await conn.getAccountInfo(vault, { commitment: "confirmed" });
      if (info?.owner?.equals(programId)) {
        return errJson(200, {
          ok: true,
          already: true,
          meta: {
            admin: admin.toBase58(),
            setId,
            programId: programId.toBase58(),
            vault: vault.toBase58(),
            authority: authority.toBase58(),
            feeBps,
            ata: { created: [], existed: [], mints: [] },
          },
        });
      }
    } catch {
      // continue
    }

    // Build ATA creates (idempotent) for provided mints
    const uniqMints: string[] = Array.from(new Set(mintsIn.map((m) => m.toString())));
    const ataCreated: string[] = [];
    const ataExisted: string[] = [];

    // Keep per-transaction ATA create count conservative to avoid hitting tx size limits.
    // Webhooks typically pass 2 mints; rebalance (Pro) can pass many more.
    const MAX_ATAS_PER_TX = 8;

    // Persist token selection to set doc (idempotent; helps prevent SOL/USDC fallback)
    // NOTE: we only persist the first two mints (A/B) to mirror historical behavior.
    try {
      if (uniqMints.length >= 1) {
        const mintA = String(uniqMints[0] || "");
        const mintB = String(uniqMints[1] || "");
        // only write if at least A set
        const key = `mm:set:${setId}`;
        // Read existing doc (hash)
        const doc: any = (await redis.hgetall(key).catch(() => ({}))) || {};
        const prefs: any = typeof doc?.prefs === "object" && doc.prefs ? { ...doc.prefs } : {};
        // Force A/B ↔ In/Out parity at creation time to avoid stale defaults (e.g., USDC) leaking into mintB
        let dirty = false;
        if (mintA) {
          if (prefs.mintIn !== mintA) { prefs.mintIn = mintA; dirty = true; }
          if (prefs.mintA !== mintA) { prefs.mintA = mintA; dirty = true; }
        }
        if (mintB) {
          if (prefs.mintOut !== mintB) { prefs.mintOut = mintB; dirty = true; }
          if (prefs.mintB !== mintB) { prefs.mintB = mintB; dirty = true; }
        }
        if (dirty) {
          const next = { ...doc, setId, prefs };
          await redis.hset(key, next as any);
        }
      }
    } catch {
      // ignore prefs failures
    }

    async function buildAtaIxsForMints(mintStrs: string[]): Promise<TransactionInstruction[]> {
      const out: TransactionInstruction[] = [];
      for (const mintStr of mintStrs) {
        try {
          const mint = new PublicKey(mintStr);
          const tokenProgramId = await detectTokenProgramForMint(mint, conn);
          const ata = getAssociatedTokenAddressSync(
            mint,
            authority,
            true,
            tokenProgramId
          );
          const ai = await conn.getAccountInfo(ata, { commitment: "confirmed" });
          if (ai) {
            ataExisted.push(ata.toBase58());
            continue;
          }
          ataCreated.push(ata.toBase58());
          // IMPORTANT FIX:
          // Use the standard 5-argument form. The optional 6th arg defaults to
          // ASSOCIATED_TOKEN_PROGRAM_ID. Passing SystemProgram.programId here was
          // the root cause of "Program 11111111... invalid instruction data".
          out.push(
            createAssociatedTokenAccountIdempotentInstruction(
              admin,     // payer
              ata,       // associated token account
              authority, // owner
              mint,      // mint
              tokenProgramId // token program id (classic or token-2022)
            )
          );
        } catch {
          // ignore invalid mint strings
        }
      }
      return out;
    }

    // Build init_vault instruction (Anchor-style discriminator + setId + Option<u16> fee_bps (LE))
    const ixData = Buffer.concat([
      discInitVault(),
      Buffer.from(setId16),                             // 16 bytes set id
      Buffer.from([1]),                                 // Option::Some for fee_bps
      Buffer.from(Uint16Array.of(feeBps).buffer).subarray(0, 2), // little-endian u16
    ]);

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ixData,
    });

    // Build one or more transactions:
    //  - Tx[0] includes up to MAX_ATAS_PER_TX ATA creates + init_vault.
    //  - Remaining ATAs (if any) are created in follow-up txs (still user-paid, no relayer rent spike later).
    const mintChunks: string[][] = [];
    for (let i = 0; i < uniqMints.length; i += MAX_ATAS_PER_TX) {
      mintChunks.push(uniqMints.slice(i, i + MAX_ATAS_PER_TX));
    }

    const txs: Transaction[] = [];
    for (let i = 0; i < Math.max(1, mintChunks.length); i++) {
      const chunk = mintChunks[i] || [];
      const ataIxs = await buildAtaIxsForMints(chunk);
      const tx = new Transaction();
      if (ataIxs.length) tx.add(...ataIxs);
      if (i === 0) tx.add(ix); // init only once
      tx.feePayer = admin;
      txs.push(tx);
    }

    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    for (const tx of txs) tx.recentBlockhash = blockhash;

    // Serialize all txs; keep legacy tx64 (first) for backwards compatibility.
    const serAll = txs.map((t) => t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
    const ser = serAll[0] || "";

    // Optional simulation (helps surface errors early)
    // Simulate the first tx (contains init_vault). Follow-ups are ATA creates only.
    try {
      const sim = await conn.simulateTransaction(txs[0]);
      if (sim?.value?.err) {
        return errJson(400, {
          ok: false,
          stage: "simulate",
          err: sim.value.err,
          logs: sim.value.logs || [],
          meta: {
            admin: admin.toBase58(),
            setId,
            programId: programId.toBase58(),
            vault: vault.toBase58(),
            authority: authority.toBase58(),
            feeBps,
            ata: { created: ataCreated, existed: ataExisted, mints: uniqMints },
          },
        });
      }
    } catch {
      // ignore simulation errors; wallet will still surface failures on send
    }

    return errJson(200, {
      ok: true,
      tx64: ser,
      txs64: serAll,
      meta: {
        admin: admin.toBase58(),
        setId,
        programId: programId.toBase58(),
        vault: vault.toBase58(),
        authority: authority.toBase58(),
        feeBps,
        ata: { created: ataCreated, existed: ataExisted, mints: uniqMints },
      },
    });
  } catch (e: any) {
    return errJson(500, { ok: false, stage: "exception", error: (e && (e.message || String(e))) || "error" });
  }
}
