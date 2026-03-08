// filepath: src/app/api/subs/[strategySlug]/intent/route.ts
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

const MINT_USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function treasuryPubkey(): PublicKey {
  const raw = (process.env.TREASURY_WALLET || process.env.NEXT_PUBLIC_TREASURY_WALLET || "5mEqxr6McBRL5DGE9dJ2Td3viwhAmRpe4V7pqGTPMtvr").trim();
  return new PublicKey(raw);
}

function safeNumber(n: any, fallback: number): number {
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) && v > 0 ? Number(v) : fallback;
}

function pick<T=string>(...vals: (T | null | undefined | "")[]): T | undefined {
  for (const v of vals) { if (v && String(v).trim() !== "") return v as T; }
  return undefined;
}

export async function POST(req: NextRequest, { params }: any) {
  try {
    const slug = (params?.strategySlug || "mojo-pro-sol").trim();
    const body = await req.json().catch(() => ({} as any));
    const qp = req.nextUrl.searchParams;

    const ownerStr = String(pick(body?.owner, body?.publicKey, body?.wallet, body?.walletPubkey, qp.get("owner"), qp.get("wallet"), req.headers.get("x-owner")) || "").trim();
    if (!ownerStr) return NextResponse.json({ ok: false, error: "missing_owner", hint: "pass owner in body.owner, ?owner=, or x-owner header" }, { status: 400 });
    const owner = new PublicKey(ownerStr);

    const amountUsd = safeNumber(pick(body?.amountUsd, qp.get("amountUsd")), 20);

    const conn = getConnection();
    const treas = treasuryPubkey();

    // Detect token program for USDC
    const mintInfo = await conn.getAccountInfo(MINT_USDC);
    if (!mintInfo) return NextResponse.json({ ok: false, error: "mint_not_found" }, { status: 500 });
    const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // ATAs
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
    const msg = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const txBase64 = Buffer.from(tx.serialize()).toString("base64");

    return NextResponse.json({
      ok: true,
      txBase64,
      mint: MINT_USDC.toBase58(),
      decimals: dec,
      amountAtoms: atoms.toString(),
      amountUsd,
      memo,
      _meta: { tokenProgramId: tokenProgramId.toBase58(), ownerSource: ownerStr ? "detected" : "unknown" },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "internal_error" }, { status: 500 });
  }
}
