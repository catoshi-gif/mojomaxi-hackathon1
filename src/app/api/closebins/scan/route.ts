// File: src/app/api/closebins/scan/route.ts
// Runtime: Node (web3)
// Purpose: Scan all vaults for an owner. Find EC‑PDA *and* PAS bins, show lamports, and
//          issue cleanup‑only EC‑PDA calls when safe (empty). Adds deep pagination over
//          transaction history and a PAS probe not reliant on history.
//
// Golden rule respected: only additive functionality. No UI/UX changes elsewhere.

import "server-only";
import bs58 from "bs58";
import { NextRequest, NextResponse } from "next/server";
import {
  AccountMeta,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC,
  TOKEN_2022_PROGRAM_ID as TOKEN_PROGRAM_2022,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readPinnedVaultMints } from "@/lib/immutability.guard";
import { hasTrustedInternalProof } from "@/lib/auth/internal";
import { getOrCreateRequestId, logApiEvent, summarizeError } from "@/lib/observability";

// ----------------- constants -----------------
const DISC_EXEC_SWAP = Buffer.from([0x38, 0xb6, 0x7c, 0xd7, 0x9b, 0x8c, 0x9d, 0x66]);        // sha256("global:execute_swap")[..8]
const DISC_EXEC_SWAP_EC_PDA = Buffer.from([0x15, 0x9f, 0xa1, 0xd2, 0x37, 0x7c, 0xdd, 0x96]); // sha256("global:execute_swap_ec_pda")[..8]
const DISC_SWEEP_EC_PDA_BINS = Buffer.from([0x0c, 0xab, 0x64, 0x92, 0x1e, 0x1b, 0x35, 0xca]); // sha256("global:sweep_ec_pda_bins")[..8]

const TOKEN_CLASSIC = TOKEN_PROGRAM_CLASSIC;
const TOKEN_2022 = TOKEN_PROGRAM_2022;

// Minimal Program-like type (avoids importing @coral-xyz/anchor in API route)
type ProgramLike = { programId: PublicKey };

function getProgramId(): PublicKey {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID as string) ||
    (process.env.VAULT_PROGRAM_ID as string) ||
    "2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp";
  return new PublicKey(raw);
}
function getJupiterProgramFromEnv(): PublicKey | null {
  const s = String(process.env.NEXT_PUBLIC_JUPITER_PROGRAM_ID || process.env.JUPITER_PROGRAM_ID || "").trim();
  if (!s) return null;
  try { return new PublicKey(s); } catch { return null; }
}
function getConnection(): Connection {
  const url =
    (process.env.SOLANA_RPC_URL as string) ||
    (process.env.NEXT_PUBLIC_RPC_URL as string) ||
    (process.env.NEXT_PUBLIC_SOLANA_RPC as string) ||
    "";
  if (!url) throw new Error("SOLANA_RPC_URL not set");
  let headers: Record<string, string> | undefined;
  const h = process.env.SOLANA_RPC_HEADERS;
  if (h) {
    try { headers = JSON.parse(h); } catch {}
  }
  // Default commitment "processed"; requests below ask "confirmed" where useful.
  return new Connection(url, { commitment: "processed", httpHeaders: headers });
}
function lazyLoadRelayer(): Keypair | null {
  const s = process.env.RELAYER_SECRET || process.env.ADMIN_RELAYER_SECRET || "";
  if (!s) return null;
  try {
    if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
    return Keypair.fromSecretKey(bs58.decode(s));
  } catch {
    return null;
  }
}

// -------------- small bin utils --------------
function u8(n: number): Buffer { const b = Buffer.alloc(1); b[0] = n & 0xff; return b; }
function u16LE(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; }
function u32LE(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
function decodeIxData(data: string): Buffer {
  if (!data) return Buffer.alloc(0);
  try { return Buffer.from(bs58.decode(data)); } catch {}
  try { return Buffer.from(data, "base64"); } catch {}
  return Buffer.alloc(0);
}
function toPk(x: any): PublicKey { return x instanceof PublicKey ? x : new PublicKey(x); }
function unionAccountKeys(tr: any): PublicKey[] {
  const msg: any = tr?.transaction?.message || {};
  const stat: any[] = (msg.accountKeys || msg.staticAccountKeys || []).map((k: any) => toPk(k));
  const la = tr?.meta?.loadedAddresses || null;
  const writ: any[] = Array.isArray(la?.writable) ? la.writable.map((k: any) => toPk(k)) : [];
  const ro: any[] = Array.isArray(la?.readonly) ? la.readonly.map((k: any) => toPk(k)) : [];
  return [...stat, ...writ, ...ro];
}
function extractCompiledInstructions(tr: any): any[] {
  const msg: any = tr?.transaction?.message || {};
  return (msg.compiledInstructions || msg.instructions || []) as any[];
}

function ensureSetComputeBudgetIxs(opts: { cuLimit?: number; cuPriceMicroLamports?: number | "auto" }) {
  const out: TransactionInstruction[] = [];
  try {
    const rawLimit = typeof opts?.cuLimit === "number" && isFinite(opts.cuLimit) ? Math.floor(opts.cuLimit) : 1_000_000;
    const units = Math.max(200_000, Math.min(1_400_000, rawLimit));
    out.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    const price = opts?.cuPriceMicroLamports;
    if (typeof price === "number" && isFinite(price) && price > 0) {
      out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(price) }));
    }
  } catch {
    out.length = 0; out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
  }
  return out;
}

function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
}
async function detectTokenProgramForMint(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint, "processed");
  if (info?.owner?.equals(TOKEN_2022)) return TOKEN_2022;
  return TOKEN_CLASSIC;
}

type BinRef = { programId: PublicKey; account: PublicKey };

async function listSwapAuthorityTokenBins(
  conn: Connection,
  swapAuthority: PublicKey
): Promise<BinRef[]> {
  // IMPORTANT:
  // - We only want bins that are *likely closable* (amount==0, owned by swapAuthority, no delegate, no foreign closeAuthority).
  // - Including a single uncloseable bin in an on-chain sweep can cause the whole tx to fail, so we prefilter here.
  const programs = [TOKEN_PROGRAM_CLASSIC, TOKEN_PROGRAM_2022];

  const out: BinRef[] = [];
  for (const programId of programs) {
    const res = await conn.getTokenAccountsByOwner(swapAuthority, { programId });

    for (const it of res.value) {
      try {
        const info = it.account;
        const data: Buffer = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data as any);
        if (!data || data.length < 72) continue;

        // SPL Token account layout (base):
        // mint[0..32), owner[32..64), amount u64 at [64..72)
        const owner = new PublicKey(data.subarray(32, 64));
        if (!owner.equals(swapAuthority)) continue;

        const amount = data.readBigUInt64LE(64);
        if (amount !== 0n) continue;

        // Delegate option u32 at 72; if delegated, skip (often indicates the account isn't safely closable)
        const delegateOption = data.length >= 76 ? data.readUInt32LE(72) : 0;
        if (delegateOption !== 0) continue;

        // CloseAuthority option u32 at 120; if set and not swapAuthority, skip (terminal)
        if (data.length >= 156) {
          const closeAuthOption = data.readUInt32LE(120);
          if (closeAuthOption !== 0) {
            const closeAuth = new PublicKey(data.subarray(124, 156));
            if (!closeAuth.equals(swapAuthority)) continue;
          }
        }

        out.push({ programId, account: it.pubkey });
      } catch {
        continue;
      }
    }
  }

  return out;
}

/**
 * Best-effort-but-bounded "must-land" bin sweeps:
 * - Re-scan closeable bins each pass (some bins become closeable after prior closes).
 * - Chunk bins to avoid tx size/CU failures.
 * - Exit quickly on terminal errors, and never loop forever.
 */
/**
 * Best-effort-but-bounded "must-land" bin sweeps:
 * - Re-scan closeable bins each pass (some bins become closeable after prior closes).
 * - Chunk bins to avoid tx size/CU failures.
 * - Exit quickly on terminal errors, and never loop forever.
 */
async function sweepBinsMustLand(opts: {
  conn: Connection;
  program: ProgramLike;
  payer: Keypair;
  vaultPda: PublicKey;
  swapNonce: number;
  swapAuthority: PublicKey;
  configPda: PublicKey;
  initialBins?: BinRef[];
  logPrefix?: string;
}): Promise<{ closed: number; attempts: number; terminalStops: number }> {
  const {
    conn,
    program,
    payer,
    vaultPda,
    swapNonce,
    swapAuthority,
    configPda,
    initialBins,
    logPrefix = "",
  } = opts;

  const MAX_PASSES = 4;         // hard bound: prevents infinite loops
  const MAX_TXS    = 10;        // absolute tx limit per request
  const BINS_PER_TX = 10;       // conservative: tx-size + CU safety
  const BASE_CU = 350_000;      // sweep-only tx (no swap), generally lighter
  const BASE_CU_PRICE = 3_000;  // microLamports
  const MAX_CU_PRICE  = 45_000; // cap fee bumping

  const blacklist = new Set<string>(); // bin accounts that hit terminal errors within this run

  const isTerminal = (msg: string) => {
    const m = msg.toLowerCase();
    // Permission / structure / invariant failures are terminal for a bin sweep.
    if (m.includes("owner does not match")) return true;
    if (m.includes("invalid account owner")) return true;
    if (m.includes("invalidaccountowner")) return true;
    if (m.includes("invalid account data")) return true;
    if (m.includes("invalidaccountdata")) return true;
    if (m.includes("accountnotinitialized")) return true;
    if (m.includes("uninitialized")) return true;
    if (m.includes("constraint")) return true;
    if (m.includes("has a balance")) return true;
    if (m.includes("non-zero")) return true;
    if (m.includes("cannot close")) return true;
    if (m.includes("close authority")) return true;
    if (m.includes("signature verification failed")) return true;
    if (m.includes("custom program error")) return true;
    return false;
  };

  const isRetryable = (msg: string) => {
    const m = msg.toLowerCase();
    return (
      m.includes("blockhash not found") ||
      m.includes("transaction was not confirmed") ||
      m.includes("timed out") ||
      m.includes("timeout") ||
      m.includes("429") ||
      m.includes("too many requests") ||
      m.includes("node is behind") ||
      m.includes("rpc") ||
      m.includes("connection") ||
      m.includes("network") ||
      m.includes("fetch failed") ||
      m.includes("slot was skipped")
    );
  };

  let attempts = 0;
  let closed = 0;
  let terminalStops = 0;

  // Use initialBins only as a hint; we re-scan per pass to catch newly-closeable bins.
  let binsHint = (initialBins ?? []).filter((b) => !blacklist.has(b.account.toBase58()));

  for (let pass = 0; pass < MAX_PASSES && attempts < MAX_TXS; pass++) {
    const binsFresh = await listSwapAuthorityTokenBins(conn, swapAuthority);
    const bins = (binsFresh.length > 0 ? binsFresh : binsHint).filter(
      (b) => !blacklist.has(b.account.toBase58())
    );

    if (bins.length === 0) break;

    // chunk
    for (let i = 0; i < bins.length && attempts < MAX_TXS; i += BINS_PER_TX) {
      const chunk = bins.slice(i, i + BINS_PER_TX);

      // Build sweep ix (PDA vault + nonce-scoped)
      const sweepKeys = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: swapAuthority, isSigner: false, isWritable: false },
        { pubkey: configPda, isSigner: false, isWritable: false },
        ...chunk.flatMap((b) => [
          { pubkey: b.programId, isSigner: false, isWritable: false },
          { pubkey: b.account, isSigner: false, isWritable: true },
        ]),
      ];

      // NOTE: sweep_ec_pda_bins uses Anchor-style 8-byte discriminator + args:
      // (vault_pubkey: Pubkey, swap_nonce: u64)
      // Using the wrong discriminator or u32 nonce encoding will cause the sweep to no-op.
      const sweepData = Buffer.concat([
        DISC_SWEEP_EC_PDA_BINS,
        vaultPda.toBuffer(),
        u64LE(BigInt(swapNonce)),
      ]);

      // must-land loop for this chunk
      let cuPrice = BASE_CU_PRICE;
      let sent = false;

      for (let a = 0; a < 4; a++) {
        attempts += 1;
        try {
          const tx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: BASE_CU }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
            new TransactionInstruction({
              programId: program.programId,
              keys: sweepKeys,
              data: sweepData,
            })
          );

          tx.feePayer = payer.publicKey;
          tx.recentBlockhash = (await conn.getLatestBlockhash("finalized")).blockhash;
          tx.sign(payer);

          const sig = await conn.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: "processed",
            maxRetries: 0,
          });

          const conf = await conn.confirmTransaction(sig, "confirmed");
          if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));

          console.log(`${logPrefix} sweep chunk ok`, { sig, bins: chunk.length, cuPrice });
          closed += chunk.length; // approximate (program may skip already-closed)
          sent = true;
          break;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          const term = isTerminal(msg);
          const retry = isRetryable(msg);

          console.warn(`${logPrefix} sweep chunk failed`, {
            pass,
            attempt: a + 1,
            cuPrice,
            bins: chunk.length,
            term,
            retry,
            msg,
          });

          if (term) {
            terminalStops += 1;
            for (const b of chunk) blacklist.add(b.account.toBase58());
            break;
          }
          if (!retry) {
            for (const b of chunk) blacklist.add(b.account.toBase58());
            break;
          }

          // fee bump
          cuPrice = Math.min(MAX_CU_PRICE, Math.round(cuPrice * 1.8));
        }
      }

      if (!sent) continue;
    }

    binsHint = binsHint.filter((b) => !blacklist.has(b.account.toBase58()));
  }

  return { closed, attempts, terminalStops };
}


// Minimal vault decode: treasury and trades
function readVaultState(buf: Buffer) {
  // Vault layout: disc[8] + admin[32] + setId[16] + treasury[32] + feeBps[2] + paused[1] + vaultBump[1] + authBump[1] + trades[8]
  if (!buf || buf.length < 8 + 32 + 16 + 32 + 2 + 1 + 1 + 1 + 8) return null;
  const treasury = new PublicKey(buf.subarray(8 + 32 + 16, 8 + 32 + 16 + 32));
  const tradesLE = buf.subarray(8 + 32 + 16 + 32 + 2 + 1 + 1 + 1, 8 + 32 + 16 + 32 + 2 + 1 + 1 + 1 + 8);
  let trades = 0n;
  try {
    trades = tradesLE.readBigUInt64LE(0);
  } catch {}
  return { treasury, trades };
}

// ----------------- API -----------------
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Attempt = {
  kind: "ec_pda" | "pas" | "pas_probe";
  ownerType?: "swap_authority" | "program_as_signer";
  vault: string;
  nonce?: string;
  inMint?: string;
  outMint?: string;
  inProgram?: string;
  outProgram?: string;
  jupiterProgram?: string;
  ephSrc?: string;
  ephDst?: string;
  lamportsSrc?: number;
  lamportsDst?: number;
  sent?: boolean;
  signature?: string;
  reason?: string;
};

function hasClosebinsAdminSecret(req: NextRequest): boolean {
  const want = String(process.env.CLOSEBINS_ADMIN_SECRET || process.env.ADMIN_SWEEP_SECRET || "").trim();
  if (!want) return false;
  const auth = String(req.headers.get("authorization") || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || String(req.headers.get("x-admin-secret") || "").trim();
  return !!provided && provided === want;
}

export async function POST(req: NextRequest) {
  const requestId = getOrCreateRequestId(req.headers);
  const startedAt = Date.now();
  try {
    const trusted = hasTrustedInternalProof(req.headers) || hasClosebinsAdminSecret(req);
    if (!trusted) {
      logApiEvent("warn", "closebins.unauthorized", { requestId, path: req.nextUrl.pathname });
      return NextResponse.json({ ok: false, error: "not_found", requestId }, { status: 404, headers: { "X-Request-Id": requestId } });
    }

    const body = await req.json().catch(() => ({}));
    const owner58 = String(body?.owner || "").trim();
    const perVaultLimit = Math.max(50, Math.min(1500, Number(body?.limit || 400) || 400));
    const send = body?.send === true; // default false; explicit send required for cleanup txs
    if (!owner58) return NextResponse.json({ ok: false, error: "missing_owner", requestId }, { status: 400, headers: { "X-Request-Id": requestId } });
    const owner = new PublicKey(owner58);

    const conn = getConnection();
    const programId = getProgramId();

      const program: ProgramLike = { programId };
// 1) discover vaults for owner
    const vaultAccs = await conn.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
    });
    const vaults = vaultAccs.map(({ pubkey, account }) => {
      const st = readVaultState(Buffer.from(account.data as Buffer));
      return {
        vault: pubkey,
        treasury: st?.treasury ?? owner,
        trades: st?.trades ?? 0n,
      };
    });

    // helper: paged signatures fetching (deep history)
    async function getSigsPaged(addr: PublicKey, maxCount: number) {
      const out: any[] = [];
      let before: string | undefined = undefined;
      while (out.length < maxCount) {
        const need = Math.min(1000, maxCount - out.length);
        const page = await conn.getSignaturesForAddress(addr, { limit: need, before }, "confirmed");
        if (!page.length) break;
        out.push(...page);
        before = page[page.length - 1].signature;
        if (page.length < need) break;
      }
      return out;
    }

    const attempts: Attempt[] = [];
    const jupProgramsSeen = new Set<string>();

    // 2) Walk each vault's transactions; collect EC‑PDA + PAS calls
    for (const { vault, treasury } of vaults) {
      const sigs = await getSigsPaged(vault, perVaultLimit);
      const chunk = 25;
      for (let i = 0; i < sigs.length; i += chunk) {
        const batch = sigs.slice(i, i + chunk);
        const txs = await Promise.all(
          batch.map((s) =>
            conn.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            })
          )
        );
        for (const tr of txs) {
          if (!tr) continue;
          const accountKeys = unionAccountKeys(tr);
          const instructions = extractCompiledInstructions(tr);

          for (const ix of instructions) {
            const progPk = accountKeys[ix.programIdIndex] as PublicKey;
            if (!progPk.equals(programId)) continue;

            const raw = decodeIxData(String(ix.data || ""));
            if (raw.length < 8) continue;
            const accIdxs: number[] = ix.accounts as number[];

            // === EC‑PDA ===
            if (raw.subarray(0, 8).equals(DISC_EXEC_SWAP_EC_PDA)) {
              if (raw.length < 16 || accIdxs.length < 17) continue;
              const swapNonce = raw.readBigUInt64LE(8);
              const ephSrcIdx = accIdxs[6];
              const ephDstIdx = accIdxs[7];
              const inMintIdx = accIdxs[8];
              const outMintIdx = accIdxs[9];
              const inProgramIdx = accIdxs[11];
              const outProgramIdx = accIdxs[12];
              const jupIdx = accIdxs[14];

              const inMint = accountKeys[inMintIdx];
              const outMint = accountKeys[outMintIdx];
              const inProg = accountKeys[inProgramIdx];
              const outProg = accountKeys[outProgramIdx];
              const jup = accountKeys[jupIdx];
              const ephSrc = accountKeys[ephSrcIdx];
              const ephDst = accountKeys[ephDstIdx];

              jupProgramsSeen.add(jup?.toBase58() || "");

              // probe emptiness + lamports
              const [srcInfo, dstInfo] = await Promise.all([
                conn.getAccountInfo(ephSrc, "confirmed").catch(() => null),
                conn.getAccountInfo(ephDst, "confirmed").catch(() => null),
              ]);
              let srcZero = true, dstZero = true;
              try {
                const bal = await conn.getTokenAccountBalance(ephSrc, "confirmed" as any);
                srcZero = Number(bal?.value?.amount || 0) === 0;
              } catch {}
              try {
                const bal = await conn.getTokenAccountBalance(ephDst, "confirmed" as any);
                dstZero = Number(bal?.value?.amount || 0) === 0;
              } catch {}

              let sent = false, signature: string | undefined = undefined, reason: string | undefined = undefined;
              // lazy-load relayer only if we actually need to send
              if (send && srcInfo && dstInfo && srcZero && dstZero) {
                try {
                  const relayer = lazyLoadRelayer();
                  if (!relayer) {
                    reason = "relayer_missing";
                  } else {
                    const payerKp = relayer;
                    const payer = payerKp.publicKey;
                    const vaultPda = vault; // alias: vault account is the vault PDA
                    const swapNonceNum = Number(swapNonce);
                    const [vaultAuthority] = PublicKey.findProgramAddressSync(
                      [Buffer.from("vault_authority"), vault.toBuffer()],
                      programId
                    );
                    const swapNonceLE = u64LE(swapNonce);
                    const [swapAuthority] = PublicKey.findProgramAddressSync(
                      [Buffer.from("swap_authority"), vault.toBuffer(), swapNonceLE],
                      programId
                    );
                    const inAuthAta = deriveAta(vaultAuthority, inMint, inProg);
                    const outAuthAta = deriveAta(vaultAuthority, outMint, outProg);
                    const treAta = deriveAta(treasury, outMint, outProg);
                    const jupiterProgram = jup || getJupiterProgramFromEnv();
                    if (!jupiterProgram) {
                      reason = "no_jup_program";
                    } else {
                      const data = Buffer.concat([
                        DISC_EXEC_SWAP_EC_PDA,
                        u64LE(swapNonce),  // swap_nonce
                        u64LE(0n),         // amount_in
                        u64LE(0n),         // min_out_hint
                        u16LE(0),          // platform_fee_bps
                        u32LE(0),          // route_data len
                        u8(0),             // token_ledger: None
                        u32LE(0),          // setups_len
                        u8(0),             // cleanup: None
                        u32LE(0),          // tlAccsLen
                        u32LE(0),          // setupAccsLens
                        u32LE(0),          // routeAccsLen
                        u32LE(0),          // cleanupAccsLen
                      ]);
                      const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
                      const keys: AccountMeta[] = [
                        { pubkey: payer, isWritable: true, isSigner: true },
                        { pubkey: vault, isWritable: true, isSigner: false },
                        { pubkey: vaultAuthority, isWritable: false, isSigner: false },
                        { pubkey: swapAuthority, isWritable: false, isSigner: false },
                        { pubkey: inAuthAta, isWritable: true, isSigner: false },
                        { pubkey: outAuthAta, isWritable: true, isSigner: false },
                        { pubkey: ephSrc, isWritable: true, isSigner: false },
                        { pubkey: ephDst, isWritable: true, isSigner: false },
                        { pubkey: inMint, isWritable: false, isSigner: false },
                        { pubkey: outMint, isWritable: false, isSigner: false },
                        { pubkey: treAta, isWritable: true, isSigner: false },
                        { pubkey: inProg, isWritable: false, isSigner: false },
                        { pubkey: outProg, isWritable: false, isSigner: false },
                        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
                        { pubkey: jupiterProgram, isWritable: false, isSigner: false },
                        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isWritable: false, isSigner: false },
                        { pubkey: configPda, isWritable: false, isSigner: false },
                      ];
                      const bins = await listSwapAuthorityTokenBins(conn, swapAuthority);
                      // --- Must-land send: confirm + retry + fee bump (EC_PDA close only; sweep happens after confirm)
                      const cuPrices: (number | "auto")[] = [8000, 15000, 30000, 60000, 90000];
                      const buildTx = async (cuPriceMicroLamports: number | "auto") => {
                        const ixs: TransactionInstruction[] = [
                          ...ensureSetComputeBudgetIxs({ cuLimit: 300_000, cuPriceMicroLamports }),
                          new TransactionInstruction({ programId, keys, data }),
                        ];
                        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");
                        const msg = new TransactionMessage({ payerKey: payerKp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
                        const tx = new VersionedTransaction(msg);
                        tx.sign([payerKp]);
                        return { tx, blockhash, lastValidBlockHeight };
                      };

                      let lastErr: any = null;
                      for (let attempt = 0; attempt < cuPrices.length; attempt++) {
                        const cuP = cuPrices[attempt];
                        try {
                          const { tx, blockhash, lastValidBlockHeight } = await buildTx(cuP);
                          const sig = await conn.sendRawTransaction(tx.serialize(), {
                            // First attempt: run preflight; later attempts: speed/throughput matters more than logs
                            skipPreflight: attempt >= 1,
                            preflightCommitment: "processed" as any,
                            // We handle retries ourselves so we can bump fees + refresh blockhash
                            maxRetries: 0,
                          });
                          const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed" as any);
                          if (conf?.value?.err) {
                            throw new Error(`confirm err: ${JSON.stringify(conf.value.err)}`);
                          }
                          sent = true;
                          signature = sig;
                          reason = "";
                          console.log(`✅ EC_PDA close confirmed (attempt ${attempt + 1}/${cuPrices.length}) sig=${sig} cuPrice=${String(cuP)}`);
                          // After the close lands, do bounded sweeps in separate txs (higher success rate; avoids one bad bin failing the close).
                          if (bins.length > 0) {
                            try {
                              const sweep = await sweepBinsMustLand({
                                conn,
                                program,
                                payer: payerKp,
                                vaultPda,
                                swapNonce: swapNonceNum,
                                swapAuthority,
                                configPda,
                                initialBins: bins,
                                logPrefix: `[closebins nonce=${swapNonceNum}]`,
                              });
                              console.log(`🧹 EC_PDA sweep summary`, sweep);
                            } catch (e: any) {
                              console.warn(`⚠️ EC_PDA sweep threw (close already confirmed)`, String(e?.message ?? e));
                            }
                          }
                          break;
                        } catch (e: any) {
                          lastErr = e;
                          const msg = String(e?.message || e);
                          reason = msg;
                          console.warn(`⚠️ EC_PDA close failed (attempt ${attempt + 1}/${cuPrices.length}) cuPrice=${String(cuP)} err=${msg}`);
                          // Retry next loop (fresh blockhash + higher fee).
                        }
                      }
                      if (!sent) {
                      throw lastErr || new Error("EC_PDA close failed after retries");
                      }
                    }
                  }
                } catch (e: any) {
                  sent = false; reason = String(e?.message || e);
                }
              } else if (!send) {
                reason = "scan_only";
              } else if (!(srcInfo && dstInfo)) {
                reason = "no_ephemeral_accounts";
              } else {
                reason = "not_empty";
              }

              attempts.push({
                kind: "ec_pda",
                ownerType: "swap_authority",
                vault: vault.toBase58(),
                nonce: swapNonce.toString(),
                inMint: inMint.toBase58(),
                outMint: outMint.toBase58(),
                inProgram: inProg.toBase58(),
                outProgram: outProg.toBase58(),
                jupiterProgram: jup?.toBase58(),
                ephSrc: ephSrc?.toBase58(),
                ephDst: ephDst?.toBase58(),
                lamportsSrc: srcInfo?.lamports ?? 0,
                lamportsDst: dstInfo?.lamports ?? 0,
                sent, signature, reason,
              });
            }

            // === PAS (Program‑As‑Signer) ===
            if (raw.subarray(0, 8).equals(DISC_EXEC_SWAP) && accIdxs.length >= 15) {
              const inMintIdx = accIdxs[5];
              const outMintIdx = accIdxs[6];
              const inProgramIdx = accIdxs[8];
              const outProgramIdx = accIdxs[9];
              const jupIdx = accIdxs[11];

              const inMint = accountKeys[inMintIdx];
              const outMint = accountKeys[outMintIdx];
              const inProg = accountKeys[inProgramIdx];
              const outProg = accountKeys[outProgramIdx];
              const jup = accountKeys[jupIdx];

              jupProgramsSeen.add(jup?.toBase58() || "");

              // derive PAS PDA + its candidate ATAs
              let pas: PublicKey | null = null;
              try { pas = PublicKey.findProgramAddressSync([Buffer.from("program_as_signer")], jup)[0]; } catch {}
              let ephSrc: PublicKey | null = null, ephDst: PublicKey | null = null;
              let srcLam = 0, dstLam = 0;
              if (pas) {
                const pSrc = deriveAta(pas, inMint, inProg);
                const pDst = deriveAta(pas, outMint, outProg);
                ephSrc = pSrc; ephDst = pDst;
                const [srcInfo, dstInfo] = await Promise.all([
                  conn.getAccountInfo(pSrc, "confirmed").catch(() => null),
                  conn.getAccountInfo(pDst, "confirmed").catch(() => null),
                ]);
                srcLam = srcInfo?.lamports ?? 0;
                dstLam = dstInfo?.lamports ?? 0;
              }
              attempts.push({
                kind: "pas",
                ownerType: "program_as_signer",
                vault: vault.toBase58(),
                inMint: inMint.toBase58(),
                outMint: outMint.toBase58(),
                inProgram: inProg.toBase58(),
                outProgram: outProg.toBase58(),
                jupiterProgram: jup?.toBase58(),
                ephSrc: ephSrc?.toBase58() || undefined,
                ephDst: ephDst?.toBase58() || undefined,
                lamportsSrc: srcLam,
                lamportsDst: dstLam,
                sent: false,
                reason: "pas_uncloseable_by_vault",
              });
            }
          }
        }
      }
    }

    // 3) PAS PROBE: pinned mints per vault (history‑independent)
    const jups = Array.from(jupProgramsSeen.values()).filter(Boolean);
    const jupFallback = getJupiterProgramFromEnv();
    if (jupFallback && !jups.includes(jupFallback.toBase58())) jups.push(jupFallback.toBase58());

    for (const { vault } of vaults) {
      let pinned: any = null;
      try { pinned = await readPinnedVaultMints(vault.toBase58()); } catch {}
      const mints = new Set<string>();
      if (pinned?.mintA) mints.add(pinned.mintA);
      if (pinned?.mintB) mints.add(pinned.mintB);
      if (pinned?.mintIn) mints.add(pinned.mintIn);
      if (pinned?.mintOut) mints.add(pinned.mintOut);
      if (Array.isArray(pinned?.mints)) for (const m of pinned.mints) if (typeof m === "string") mints.add(m);

      if (!mints.size) continue;

      for (const j of jups) {
        let pas: PublicKey | null = null;
        try { pas = PublicKey.findProgramAddressSync([Buffer.from("program_as_signer")], new PublicKey(j))[0]; } catch { pas = null; }
        if (!pas) continue;

        for (const m58 of mints) {
          let mintPk: PublicKey;
          try { mintPk = new PublicKey(m58); } catch { continue; }
          const tokenProgram = await detectTokenProgramForMint(conn, mintPk);
          const ata = deriveAta(pas, mintPk, tokenProgram);
          const info = await conn.getAccountInfo(ata, "confirmed").catch(() => null);
          if (!info) continue;
          attempts.push({
            kind: "pas_probe",
            ownerType: "program_as_signer",
            vault: vault.toBase58(),
            inMint: mintPk.toBase58(),
            outMint: mintPk.toBase58(),
            inProgram: tokenProgram.toBase58(),
            outProgram: tokenProgram.toBase58(),
            jupiterProgram: j,
            ephSrc: ata.toBase58(),
            ephDst: ata.toBase58(),
            lamportsSrc: info.lamports,
            lamportsDst: info.lamports,
            sent: false,
            reason: "pas_uncloseable_by_vault",
          });
        }
      }
    }

    // stats
    const candidates = attempts.filter(a => a.kind === "ec_pda").length;
    const sent = attempts.filter(a => a.sent).length;

    logApiEvent("info", "closebins.scan", { requestId, owner: owner58, send, perVaultLimit, vaults: vaults.length, attempts: attempts.length, durationMs: Date.now() - startedAt });
    return NextResponse.json({
      ok: true,
      owner: owner.toBase58(),
      vaults: vaults.map(v => ({ vault: v.vault.toBase58(), treasury: v.treasury.toBase58() })),
      candidates,
      sent,
      attempts,
      requestId,
    }, { headers: { "X-Request-Id": requestId } });
  } catch (e: any) {
    logApiEvent("error", "closebins.error", { requestId, durationMs: Date.now() - startedAt, error: summarizeError(e) });
    return NextResponse.json({ ok: false, error: e?.message || String(e), requestId }, { status: 500, headers: { "X-Request-Id": requestId } });
  }
}
