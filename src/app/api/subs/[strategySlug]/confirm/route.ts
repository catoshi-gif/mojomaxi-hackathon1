// filepath: src/app/api/subs/[strategySlug]/confirm/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import { getConnection } from "@/lib/solana.server";
import { upsertSubscription } from "@/lib/strategy.store";
import { createHash } from "node:crypto";
import { redis } from "@/lib/redis";

const MINT_USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MAX_EVENTS = Number.parseInt(process.env.MM_SET_EVENTS_MAX || "", 10) || 200;

const PRICE_PER_UNIT_USD = Number(process.env.MOJO_PRO_PRICE_USD || 20);  // $20 = 1 unit
const DAYS_PER_UNIT = Number(process.env.MOJO_PRO_DAYS_PER_UNIT || 30);   // 30 days per unit

function treasuryPubkey(): PublicKey {
  const raw = (process.env.TREASURY_WALLET || process.env.NEXT_PUBLIC_TREASURY_WALLET || "5mEqxr6McBRL5DGE9dJ2Td3viwhAmRpe4V7pqGTPMtvr").trim();
  return new PublicKey(raw);
}
function walletRecentKey(wallet: string): string { return `mm:wallet:${wallet}:recent`; }
function subKey(wallet: string, slug: string): string { return `mm:subs:${wallet}:${slug}`; }
function hash(s: string): string { return createHash("sha256").update(s).digest("base64url").slice(0, 22); }

function pick<T=string>(...vals: (T | null | undefined | "")[]): T | undefined {
  for (const v of vals) { if (v && String(v).trim() !== "") return v as T; }
  return undefined;
}
function safeNumber(n: any, fallback: number): number {
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) && v > 0 ? Number(v) : fallback;
}
async function waitForConfirmation(conn: any, signature: string, timeoutMs = 30000, pollMs = 700) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const st = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const s = st?.value?.[0];
      if (s?.err) return { ok: false as const, err: "tx_failed" };
      const cs = s?.confirmationStatus || (s?.confirmations != null ? (s.confirmations > 0 ? "confirmed" : null) : null);
      if (cs === "confirmed" || cs === "finalized") return { ok: true as const };
    } catch {}
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { ok: false as const, err: "timeout" };
}

/** Builds the same USDC->treasury transfer used by the intent route. */
async function buildSubscriptionTx(owner: PublicKey, amountUsd: number, slug: string) {
  const conn = getConnection();
  const treas = treasuryPubkey();

  const mintInfo = await conn.getAccountInfo(MINT_USDC);
  if (!mintInfo) throw new Error("mint_not_found");
  const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const ownerAta = getAssociatedTokenAddressSync(MINT_USDC, owner, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
  const treasAta = getAssociatedTokenAddressSync(MINT_USDC, treas, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

  const dec = 6;
  const atoms = BigInt(Math.round(amountUsd * 10 ** dec));

  const ixs: TransactionInstruction[] = [];
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerAta, owner, MINT_USDC, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID));
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, treasAta, treas, MINT_USDC, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID));

  ixs.push(createTransferCheckedInstruction(ownerAta, MINT_USDC, treasAta, owner, atoms, dec, [], tokenProgramId));

  const memo = `MOJO:${slug}:${owner.toBase58()}:${amountUsd}:${Date.now()}`;
  ixs.push(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memo, "utf8") }));

  const { blockhash } = await conn.getLatestBlockhash({ commitment: "processed" });
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const txBase64 = Buffer.from(tx.serialize()).toString("base64");

  return { txBase64, dec, atoms: atoms.toString(), tokenProgramId: tokenProgramId.toBase58(), memo };
}

export async function GET(req: NextRequest, ctx: any) { return handle(req, ctx); }
export async function POST(req: NextRequest, ctx: any) { return handle(req, ctx); }

async function handle(req: NextRequest, { params }: { params: { strategySlug?: string } }) {
  try {
    const slug = String(params?.strategySlug || "").trim().toLowerCase() || "mojo-pro-sol";

    // Body may be empty
    const body = await req.json().catch(() => ({} as any));

    const qp = req.nextUrl.searchParams;
    const ownerStr = String(pick(body?.owner, body?.publicKey, body?.wallet, body?.walletPubkey, qp.get("owner"), qp.get("wallet"), req.headers.get("x-owner")) || "").trim();
    const sigStr   = String(pick(body?.tx, body?.signature, qp.get("tx"), qp.get("signature"), req.headers.get("x-signature")) || "").trim();
    const amountUsd = safeNumber(pick(body?.amountUsd, qp.get("amountUsd")), PRICE_PER_UNIT_USD); // default 20

    if (!ownerStr) return NextResponse.json({ ok:false, error:"wallet_required" }, { status:400 });

    const owner = new PublicKey(ownerStr);

    // If signature is missing, create & return the transaction (so single endpoint can be used)
    if (!sigStr) {
      const built = await buildSubscriptionTx(owner, amountUsd, slug);
      return NextResponse.json({ ok:true, needsSignature: true, amountUsd, ...built });
    }

    // We have a signature -> confirm + verify
    const conn = getConnection();

    const wait = await waitForConfirmation(conn, sigStr, 30000, 700);
    if (!wait.ok) return NextResponse.json({ ok:false, error: wait.err === "timeout" ? "tx_not_confirmed" : "tx_failed" }, { status: 400 });

    const tr = await conn.getTransaction(sigStr, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (!tr || (tr as any)?.meta?.err) {
      return NextResponse.json({ ok:false, error:"tx_not_confirmed" }, { status:400 });
    }

    const dec = 6;
    const wantAtoms = BigInt(Math.round(amountUsd * (10 ** dec)));
    const treas = treasuryPubkey();
    const pre = ((tr as any)?.meta?.preTokenBalances || []) as any[];
    const post = ((tr as any)?.meta?.postTokenBalances || []) as any[];
    function bal(owner: string, mint: string, arr: any[]): bigint {
      for (const r of arr) {
        if (String(r?.owner) === owner && String(r?.mint) === mint) {
          const a = BigInt(String((r?.uiTokenAmount?.amount ?? r?.account?.data?.parsed?.info?.tokenAmount?.amount) || "0"));
          return a;
        }
      }
      return 0n;
    }
    const before = bal(treas.toBase58(), MINT_USDC.toBase58(), pre);
    const after  = bal(treas.toBase58(), MINT_USDC.toBase58(), post);
    const delta  = after - before;
    if (delta < wantAtoms) {
      return NextResponse.json({ ok:false, error:`insufficient_delta`, detail:`expected >= ${wantAtoms} atoms, got ${delta}` }, { status:400 });
    }

    // === DB & EXPIRY COMPUTATION ===
    // Price model: PRICE_PER_UNIT_USD buys DAYS_PER_UNIT days.
    // Convert amount to whole days.
    const now = Date.now();
    const units = amountUsd / PRICE_PER_UNIT_USD; // e.g., 20/20=1
    const addDays = Math.floor(units * DAYS_PER_UNIT); // e.g., 1*30=30
    const addMs = addDays * 24 * 60 * 60 * 1000;

    // Fetch existing subscription shadow (non-authoritative) to compute expiry predictably.
    const sKey = subKey(owner.toBase58(), slug);
    const prev = (await (redis as any).get(sKey)) as any || null;
    const wasExpiresAt = prev?.expiresAt && Number(prev.expiresAt) > now ? Number(prev.expiresAt) : now;
    const expiresAt = wasExpiresAt + addMs;
    const totalUsd = Number(prev?.totalUsd || 0) + amountUsd;

    const shadow = {
      wallet: owner.toBase58(),
      slug,
      pricePerUnitUsd: PRICE_PER_UNIT_USD,
      daysPerUnit: DAYS_PER_UNIT,
      totalUsd,
      lastPaymentUsd: amountUsd,
      lastSignature: sigStr,
      updatedAt: now,
      expiresAt,
    };
    await (redis as any).set(sKey, shadow);

    // Authoritative DB update
    try {
      await upsertSubscription("mojo-pro", owner.toBase58(), amountUsd, sigStr);
    } catch {}

    // Emit SUBSCRIPTION_PAYMENT + SUBSCRIPTION_UPDATED into recent wallet events
    try {
      const ts = Date.now();
      const id1 = hash(`${owner.toBase58()}|SUBSCRIPTION_PAYMENT|${slug}|${ts}|${amountUsd}`);
      const id2 = hash(`${owner.toBase58()}|SUBSCRIPTION_UPDATED|${slug}|${ts}|${expiresAt}`);
      const wKey = walletRecentKey(owner.toBase58());
      const ev1 = { id: id1, kind: "SUBSCRIPTION_PAYMENT", strategyId: "mojo-pro", wallet: owner.toBase58(), tx: sigStr, mint: MINT_USDC.toBase58(), amountInUi: amountUsd, amountOutUi: amountUsd, ts, path: `/api/subs/${slug}/confirm` };
      const ev2 = { id: id2, kind: "SUBSCRIPTION_UPDATED", strategyId: "mojo-pro", wallet: owner.toBase58(), expiresAt, totalUsd, ts, path: `/api/subs/${slug}/confirm` };
      await (redis as any).lpush(wKey, JSON.stringify(ev1), JSON.stringify(ev2));
      if (MAX_EVENTS > 0) await (redis as any).ltrim(wKey, 0, MAX_EVENTS - 1);
    } catch {}

    return NextResponse.json({ ok:true, status: { expiresAt, totalUsd, addDays, pricePerUnitUsd: PRICE_PER_UNIT_USD, daysPerUnit: DAYS_PER_UNIT } });
  } catch (e: any) {
    return NextResponse.json({ ok:false, error: e?.message || "internal_error" }, { status:500 });
  }
}
