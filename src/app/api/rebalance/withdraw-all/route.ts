// filepath: src/app/api/rebalance/withdraw-all/route.ts
import { redis } from "@/lib/redis";
// BUILD_TAG: withdraw-all-batched-single-tx v2.4 (single-tx friendly + no in-tx unwrap) (Token-2022 aware)
// PURPOSE: Build as few user-signed v0 transactions as possible to withdraw *all* tokens
//          from a rebalance vault in one approval. We do **not** try to unwrap WSOL inside
//          this transaction because SPL Token requires the native account amount == 0
//          to close, which is not true immediately after withdrawing into it.
//
// INPUT JSON: { setId, admin?, mints?: string[], amountsByMint?: Record<string,number|string>, decimalsByMint?: Record<string,number>, unwrapNative?: boolean }
// HEADER:     x-wallet: <admin wallet> (preferred; falls back to body.admin)
// RESPONSE (single tx): { ok, setId, vault, tx64, mints: string[] }
// RESPONSE (multiple txs): { ok, setId, vault, txs: Array<{ tx64: string, mints: string[] }> }
//
// Node runtime only; no UI/UX changes.

import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import crypto from "crypto";
import fs from "fs";
import path from "path";

// 🔐 owner session + set owner verification
import { getSessionWalletFromRequest } from "@/lib/auth/session.server";
import { getSet as getRebalanceSet } from "@/lib/rebalance-store";

// ---- RPC helpers

function rpcUrl(): string {
  return (
    process.env.HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    process.env.RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}
function commitment(): "processed" | "confirmed" | "finalized" {
  return (process.env.SOL_COMMITMENT as any) || "confirmed";
}
function conn(): Connection {
  return new Connection(rpcUrl(), { commitment: commitment() });
}

// ---- Program + PDAs

type IdlShape = { address?: string; metadata?: { address?: string } };
function getProgramId(): PublicKey {
  // prefer ENV, fallback to IDL path, then hardcoded default
  const envId = (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID || "").trim();
  if (envId) return new PublicKey(envId);
  try {
    const idlPath = path.resolve(process.cwd(), "src/idl/mojomaxi_vault.json");
    const raw = fs.readFileSync(idlPath, "utf-8");
    const idl = JSON.parse(raw) as IdlShape;
    const a = idl?.metadata?.address || idl?.address;
    if (a) return new PublicKey(a);
  } catch {}
  // default from user's prompt
  return new PublicKey("2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp");
}

const VAULT_SEED = Buffer.from("vault");
const AUTH_SEED  = Buffer.from("vault_authority");

function setIdToBytes16(setId: string): Uint8Array {
  // NOTE: preserve original behavior from OLD FILE
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
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, admin.toBuffer(), Buffer.from(setIdToBytes16(setId))],
    getProgramId()
  );
}
function deriveAuth(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AUTH_SEED, vault.toBuffer()], getProgramId());
}

// ---- Utilities

const SOL_MINT = "So11111111111111111111111111111111111111112";

function isValidPubkeyString(s: string): boolean {
  try {
    const t = String(s || "").trim();
    if (!t) return false;
    new PublicKey(t);
    return true;
  } catch {
    return false;
  }
}




function normalizeWalletLike(raw: string): string | null {
  const t = String(raw || "").trim();
  if (!t) return null;

  // If it's already a pubkey, use it.
  if (isValidPubkeyString(t)) return t;

  // Support compound session tokens like "<pubkey>.<ts>.<sig>" by extracting the first segment.
  const first = t.split(".")[0] || "";
  if (first && isValidPubkeyString(first)) return first;

  return null;
}
function base64FromBytes(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function uiToAtoms(amountUi: string | number, decimals: number): bigint {
  const s = String(amountUi);
  if (!s || s === "0" || s === "0.0") return 0n;
  const [i, f0] = s.split(".");
  const f = (f0 || "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(i || "0") * (10n ** BigInt(decimals)) + BigInt(f || "0");
}

async function detectProgramAndDecimals(mint: PublicKey): Promise<{ programId: PublicKey; decimals: number }> {
  const c = conn();

  // Special-case the native mint: always classic program, 9 decimals.
  if (mint.equals(new PublicKey(SOL_MINT))) {
    return { programId: TOKEN_PROGRAM_CLASSIC, decimals: 9 };
  }

  try {
    const info = await getMint(c, mint, commitment(), TOKEN_PROGRAM_CLASSIC);
    return { programId: TOKEN_PROGRAM_CLASSIC, decimals: info.decimals };
  } catch {}
  try {
    const info = await getMint(c, mint, commitment(), TOKEN_2022_PROGRAM_ID);
    return { programId: TOKEN_2022_PROGRAM_ID, decimals: (info as any).decimals };
  } catch {}
  // fallback to a sensible default
  return { programId: TOKEN_PROGRAM_CLASSIC, decimals: 6 };
}

async function readTokenBalance(pk: PublicKey): Promise<bigint> {
  try {
    const c = conn();
    const v = await c.getTokenAccountBalance(pk, commitment());
    return BigInt(String(v?.value?.amount || "0"));
  } catch {
    return 0n;
  }
}

function encodeWithdrawIxData(amountAtoms: bigint): Buffer {
  // Anchor discriminator sha256("global:withdraw").slice(0, 8) + u64 little-endian
  const disc = crypto.createHash("sha256").update("global:withdraw").digest().subarray(0, 8);
  const out = Buffer.alloc(16);
  disc.copy(out, 0);
  const a = BigInt.asUintN(64, amountAtoms);
  out.writeUInt32LE(Number(a & 0xffffffffn), 8);
  out.writeUInt32LE(Number((a >> 32n) & 0xffffffffn), 12);
  return out;
}

function encodeInitVaultIxData(setId: string, feeBps?: number | null): Buffer {
  // Anchor discriminator sha256("global:init_vault").slice(0, 8) + setId[16] + option<u16> feeBps
  const disc = crypto.createHash("sha256").update("global:init_vault").digest().subarray(0, 8);

  const set16 = setIdToBytes16(setId);
  const fee =
    feeBps === null || feeBps === undefined
      ? null
      : Math.max(0, Math.min(65535, Number(feeBps) | 0));

  // option<u16> encoding: 0x00 (none) OR 0x01 + little-endian u16
  const out = Buffer.alloc(8 + 16 + (fee === null ? 1 : 3));
  disc.copy(out, 0);
  Buffer.from(set16).copy(out, 8);
  if (fee === null) {
    out.writeUInt8(0, 24);
  } else {
    out.writeUInt8(1, 24);
    out.writeUInt16LE(fee, 25);
  }
  return out;
}

async function buildInitVaultTx64(args: { admin: PublicKey; setId: string; vault: PublicKey; authority: PublicKey; programId: PublicKey; feeBps?: number | null; }): Promise<string> {
  const c = conn();
  const { admin, setId, vault, authority, programId, feeBps } = args;

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInitVaultIxData(setId, feeBps),
  });

  const bh = await c.getLatestBlockhash({ commitment: commitment() });
  const msg = new TransactionMessage({
    payerKey: admin,
    recentBlockhash: bh.blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  return Buffer.from(tx.serialize()).toString("base64");
}

// Discover mints held by either authority PDA or the vault itself, across both token programs.
async function discoverMintsForVaultOwners(authority: PublicKey, vault: PublicKey): Promise<string[]> {
  const c = conn();
  const out = new Set<string>();
  async function addByOwner(owner: PublicKey, programId: PublicKey) {
    const resp = await c.getParsedTokenAccountsByOwner(owner, { programId }, commitment()).catch(() => null);
    const items = (resp?.value || []) as any[];
    for (const it of items) {
      try {
        const info = it?.account?.data?.parsed?.info;
        const amt = Number(info?.tokenAmount?.uiAmount || 0);
        const mint = String(info?.mint || "");
        if (amt > 0 && mint) out.add(mint);
      } catch {}
    }
  }
  for (const owner of [authority, vault]) {
    await addByOwner(owner, TOKEN_PROGRAM_CLASSIC);
    await addByOwner(owner, TOKEN_2022_PROGRAM_ID);
  }
  return Array.from(out);
}

// ---- Handler

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const setId = String(body.setId || body.set || "");
    const headerWalletRaw = String(req.headers.get("x-wallet") || "");
    const adminBodyRaw = String(body.admin || "");
    if (!setId) {
      return NextResponse.json({ ok: false, error: "missing_params" }, { status: 400 });
    }

    // 🔐 Owner/session enforcement (backward-compatible)
    // We accept either a valid httpOnly session OR, if no session is present,
    // a matching X-Wallet header that owns the set.
    //
    // IMPORTANT: Some clients may accidentally send the *session token* in x-wallet.
    // If a session is present, we derive the admin wallet from the session and ignore
    // any non-pubkey x-wallet/admin values (while still rejecting conflicting pubkeys).
    const sessionWallet = await getSessionWalletFromRequest(req as any);

    let effectiveWallet: string | null = null;
    let adminStr = "";
    try {
      const setDoc = await getRebalanceSet(setId);
      if (!setDoc) {
        return NextResponse.json({ ok: false, error: "set_not_found" }, { status: 404 });
      }
      const ownerRaw = String(setDoc.wallet || "");
      const owner = normalizeWalletLike(ownerRaw);

      const session = normalizeWalletLike(sessionWallet || "");
      const headerWallet = normalizeWalletLike(headerWalletRaw);
      const adminBody = normalizeWalletLike(adminBodyRaw);

      if (!owner) {
        // If the stored owner isn't parseable, treat as server error (safer than allowing bypass).
        return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
      }

      if (session) {
        // Session is authoritative: it must match the set owner.
        if (session !== owner) {
          return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
        }

        // If the client provided pubkey-shaped admin/x-wallet values, they must match the session.
        if (adminBody && adminBody !== session) {
          return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
        }
        if (headerWallet && headerWallet !== session) {
          return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
        }

        effectiveWallet = session;
        adminStr = session;
      } else {
        // No session: require x-wallet to be the set owner.
        if (!headerWallet || headerWallet !== owner) {
          return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        // If admin is provided (as a pubkey), it must match x-wallet.
        if (adminBody && adminBody !== headerWallet) {
          return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        effectiveWallet = headerWallet;
        adminStr = headerWallet;
      }
    } catch {
      return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
    }

// Lightweight rate-limit keyed by the validated wallet + set id to prevent spam
    try {
      const rlKey = `mm:rl:withdraw-all:${setId}:${effectiveWallet}`;
      const n = await redis.incr(rlKey);
      if (Number(n) === 1) await redis.expire(rlKey, 30);
      if (Number(n) > 5) {
        return NextResponse.json({ ok: false, error: "rate_limited", retryAfterSec: 30 }, { status: 429 });
      }
    } catch {}

    const admin = new PublicKey(adminStr);
    const [vault] = deriveVault(admin, setId);
    const [auth]  = deriveAuth(vault);


    // --- Preflight: if the vault PDA exists but is NOT initialized as a program vault account,
    // withdrawals (and post-swap cleanup) will fail with Anchor AccountNotInitialized (3012).
    // This can happen if RPC issues prevented the init_vault transaction from landing, while
    // users were still able to deposit into ATAs owned by the PDA.
    //
    // In that case, return a ready-to-sign init_vault transaction so the user can initialize
    // the vault PDA and immediately retry withdraw-all.
    try {
      const ai = await conn().getAccountInfo(vault, { commitment: commitment() });
      const okOwner = ai?.owner?.equals?.(getProgramId()) || false;
      const dataLen = Number(ai?.data?.length || 0);
      if (!ai || !okOwner || dataLen < 8) {
        const initTx64 = await buildInitVaultTx64({
          admin,
          setId,
          vault,
          authority: auth,
          programId: getProgramId(),
          feeBps: null,
        });
        return NextResponse.json({
          ok: false,
          error: "vault_not_initialized",
          setId,
          vault: vault.toBase58(),
          initTx64,
          detail: {
            exists: !!ai,
            owner: ai?.owner?.toBase58?.() || null,
            dataLen,
          },
          hint: "Sign and send initTx64, then retry withdraw-all.",
        }, { status: 409 });
      }
    } catch (e) {
      // If RPC is flaky, do not block withdrawal construction. The on-chain tx will still fail
      // if the vault is truly uninitialized, but this avoids hard-dependency on a single RPC call.
    }

    let mints: string[] | undefined = Array.isArray(body.mints) ? (body.mints as string[]).map(String) : undefined;

    const explicitAmounts =
      body.amountsByMint && typeof body.amountsByMint === "object"
        ? (body.amountsByMint as Record<string, number | string>)
        : undefined;

    const explicitDecimals =
      body.decimalsByMint && typeof body.decimalsByMint === "object"
        ? (body.decimalsByMint as Record<string, number>)
        : undefined;

    // If the client provided an amounts map but not a mint list, treat the map keys as the basket.
    // This avoids pulling in unrelated “dust” mints via discovery, while preserving “withdraw all”
    // behavior when no amountsByMint is provided.
    if ((!mints || !mints.length) && explicitAmounts) {
      const keys = Object.keys(explicitAmounts).map(String).filter(Boolean);
      if (keys.length) mints = keys;
    }

    if (!mints || !mints.length) {
      mints = await discoverMintsForVaultOwners(auth, vault);
    }

    // NOTE: unwrapNative is intentionally ignored inside the batched tx to avoid simulation failure.
    const unwrapNative = body.unwrapNative === true;

    type Plan = {
      mint: PublicKey;
      mintStr: string;
      tokenProgramId: PublicKey;
      decimals: number;
      amountAtoms: bigint;
      userAta: PublicKey;
      fromVaultToken: PublicKey; // either authority ATA or vault ATA
    };

    const plans: Plan[] = [];

    for (const mintStr of (mints || [])) {
      try {
        const mint = new PublicKey(mintStr);
        const { programId: tokenProgramId, decimals } = await detectProgramAndDecimals(mint);

        const vAtaAuth  = getAssociatedTokenAddressSync(mint, auth,  true,  tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
        const vAtaVault = getAssociatedTokenAddressSync(mint, vault, true,  tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
        const userAta   = getAssociatedTokenAddressSync(mint, admin, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

        // Determine amount in atoms
        const amountUiIn = explicitAmounts && mintStr in explicitAmounts ? explicitAmounts[mintStr] : "";
        const desired =
          amountUiIn !== "" && amountUiIn != null
            ? uiToAtoms(
                String(amountUiIn),
                explicitDecimals && mintStr in explicitDecimals ? Number(explicitDecimals[mintStr]) : decimals
              )
            : 0n;

        // Read balances
        const [balAuth, balVault] = await Promise.all([readTokenBalance(vAtaAuth), readTokenBalance(vAtaVault)]);
        type Cand = { pk: PublicKey; bal: bigint };
        const cands: Cand[] = [
          { pk: vAtaAuth,  bal: balAuth },
          { pk: vAtaVault, bal: balVault },
        ];

        let chosen: Cand | undefined;
        if (desired > 0n) {
          chosen = cands.find((c) => c.bal >= desired) || cands.sort((a, b) => (b.bal > a.bal ? 1 : -1))[0];
        } else {
          chosen = cands.sort((a, b) => (b.bal > a.bal ? 1 : -1))[0];
        }

        if (!chosen || chosen.bal <= 0n) {
          continue; // nothing to withdraw for this mint
        }

        const amountAtoms = desired > 0n ? desired : chosen.bal;

        plans.push({
          mint,
          mintStr,
          tokenProgramId,
          decimals,
          amountAtoms,
          userAta,
          fromVaultToken: chosen.pk,
        });
      } catch {
        // skip invalid mint
      }
    }

    if (!plans.length) {
      return NextResponse.json({ ok: false, error: "no_withdrawable_mints" }, { status: 400 });
    }


    // Prefetch ATA existence + one blockhash to reduce RPC churn and avoid false "missing ATA" on transient RPC errors.
    // This materially affects whether we can fit everything into a single v0 transaction.
    const c = conn();
    const { blockhash } = await c.getLatestBlockhash({ commitment: "processed" });
    const missingUserAta = new Set<string>();
    try {
      const infos = await c.getMultipleAccountsInfo(plans.map((p) => p.userAta), "processed");
      const needsConfirm: PublicKey[] = [];
      for (let i = 0; i < plans.length; i++) {
        const info = infos?.[i] || null;
        if (!info) needsConfirm.push(plans[i].userAta);
      }

      // 🩹 FIX: Avoid false positives that bloat the tx (and force per-mint txs).
      // Some RPCs occasionally return null entries in getMultipleAccountsInfo even when the ATA exists.
      // Confirm nulls with a direct getAccountInfo before treating them as truly missing.
      if (needsConfirm.length) {
        const checks = await Promise.all(
          needsConfirm.map((pk) => c.getAccountInfo(pk, "processed").catch(() => null))
        );
        for (let j = 0; j < needsConfirm.length; j++) {
          if (!checks[j]) missingUserAta.add(needsConfirm[j].toBase58());
        }
      }
    } catch {
      // If RPC errors, assume ATAs exist and don't bloat the tx with create instructions.
      // The withdraw will fail for a truly-missing ATA, which is preferable to forcing N separate tx prompts.
    }

    const MAX_TX_SIZE = 1232; // v0 tx ceiling
    const programId = getProgramId();

    // --- Single-tx attempt (best UX) ---
    async function tryBuildSingleTx(): Promise<{ tx64: string; mints: string[] } | null> {
      // uses prefetched blockhash + ATA existence map
      const allIxs: TransactionInstruction[] = [];
      const allMints: string[] = [];

      for (const p of plans) {
        // Add ATA create only if missing (saves bytes)
        if (missingUserAta.has(p.userAta.toBase58())) {
          allIxs.push(
            createAssociatedTokenAccountIdempotentInstruction(
              admin,                 // payer
              p.userAta,             // ata
              admin,                 // owner
              p.mint,                // mint
              p.tokenProgramId,      // token program
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }

        allIxs.push(
          new TransactionInstruction({
            programId,
            keys: [
              { pubkey: admin,            isSigner: true,  isWritable: true  },
              { pubkey: vault,            isSigner: false, isWritable: true  },
              { pubkey: auth,             isSigner: false, isWritable: false },
              { pubkey: p.fromVaultToken, isSigner: false, isWritable: true  },
              { pubkey: p.userAta,        isSigner: false, isWritable: true  },
              { pubkey: p.mint,           isSigner: false, isWritable: false },
              { pubkey: p.tokenProgramId, isSigner: false, isWritable: false },
            ],
            data: encodeWithdrawIxData(p.amountAtoms),
          })
        );

        allMints.push(p.mintStr);
      }

      const msg = new TransactionMessage({
        payerKey: admin,
        recentBlockhash: blockhash,
        instructions: allIxs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);
      if (tx.serialize().length > MAX_TX_SIZE) return null;
      return { tx64: base64FromBytes(tx.serialize()), mints: allMints };
    }

    try {
      const single = await tryBuildSingleTx();
      if (single) {
        return NextResponse.json(
          { ok: true, setId, vault: vault.toBase58(), tx64: single.tx64, mints: single.mints, unwrapNative },
          { status: 200 }
        );
      }
    } catch {
      // ignore and fall back to splitter
    }

    // --- Splitter fallback (as few txs as possible) ---
    const built: { tx64: string; mints: string[] }[] = [];
    let batchIxs: TransactionInstruction[] = [];
    let batchMints: string[] = [];

    async function flush(): Promise<void> {
      if (!batchIxs.length) return;
      const msg = new TransactionMessage({
        payerKey: admin,
        recentBlockhash: blockhash,
        instructions: batchIxs,
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      built.push({ tx64: base64FromBytes(tx.serialize()), mints: batchMints.slice() });
      batchIxs = [];
      batchMints = [];
    }

    async function wouldOverflow(afterAdd: TransactionInstruction[]): Promise<boolean> {
      const msg = new TransactionMessage({
        payerKey: admin,
        recentBlockhash: blockhash,
        instructions: afterAdd,
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      return tx.serialize().length > MAX_TX_SIZE;
    }

    for (const p of plans) {
      const perMintIxs: TransactionInstruction[] = [];

      if (missingUserAta.has(p.userAta.toBase58())) {
        perMintIxs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            admin,
            p.userAta,
            admin,
            p.mint,
            p.tokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }

      perMintIxs.push(
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: admin,            isSigner: true,  isWritable: true  },
            { pubkey: vault,            isSigner: false, isWritable: true  },
            { pubkey: auth,             isSigner: false, isWritable: false },
            { pubkey: p.fromVaultToken, isSigner: false, isWritable: true  },
            { pubkey: p.userAta,        isSigner: false, isWritable: true  },
            { pubkey: p.mint,           isSigner: false, isWritable: false },
            { pubkey: p.tokenProgramId, isSigner: false, isWritable: false },
          ],
          data: encodeWithdrawIxData(p.amountAtoms),
        })
      );

      const tryIxs = batchIxs.concat(perMintIxs);
      if (await wouldOverflow(tryIxs)) {
        await flush();
        batchIxs = perMintIxs.slice();
        batchMints = [p.mintStr];
      } else {
        batchIxs = tryIxs;
        batchMints.push(p.mintStr);
      }
    }

    await flush();

    if (!built.length) {
      return NextResponse.json({ ok: false, error: "build_failed" }, { status: 400 });
    }

    if (built.length === 1) {
      return NextResponse.json({ ok: true, setId, vault: vault.toBase58(), tx64: built[0].tx64, mints: built[0].mints, unwrapNative });
    }

    return NextResponse.json({ ok: true, setId, vault: vault.toBase58(), txs: built, unwrapNative });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }
}
