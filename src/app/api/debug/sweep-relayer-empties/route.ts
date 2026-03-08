// File: src/app/api/debug/sweep-relayer-empties/route.ts
// Runtime: Node.js (web3)
// Purpose: Sweep *EC-PDA-owned* empty token accounts (“bins”) created by the relayer when running EC-PDA swaps.
// Auth: x-admin-secret header OR Authorization: Bearer <secret> must match ADMIN_SWEEP_SECRET (or SWEEP_SECRET).
//
// How it works (low-RPC, “gigabrain” mode):
// 1) We scan recent *transactions signed by the relayer* and extract (vault_pubkey, swap_nonce) from
//    Anchor instruction data for `execute_swap_ec_pda` / `post_swap_cleanup_ec_pda` / `sweep_ec_pda_bins`
//    AND from Memo program records: `mojomaxi:ecpda_ensure:v1:<vault>:<swapNonce>:<ecPdaOwner>`.
// 2) For each unique (vault, swap_nonce), we derive the EC-PDA swap authority:
//       PDA(["swap_authority", vault_pubkey, swap_nonce_le], program_id)
//    (If memo included an explicit ecPdaOwner pubkey, we prefer that to be robust to any future derivation changes.)
// 3) We list token accounts owned by that swap authority (SPL + optional Token-2022).
// 4) We only attempt to close accounts that are *already empty* (amount == 0) and whose close authority is
//    either unset or equals the swap authority.
// 5) Closures are executed on-chain via your program instruction `sweep_ec_pda_bins`, so rent returns to payer.
//
// Safety:
// - We never touch vault custody ATAs (owned by vault_authority), because we only scan accounts owned by EC-PDA.
// - We only close token accounts that are empty.
// - We do NOT require the nonce upfront; we discover nonces by scanning relayer txs.
//
// Perf/UX:
// - Uses getTokenAccountsByOwner + AccountLayout decode (fast; no parsed JSON).
// - Supports streaming progress via ?stream=1 (NDJSON).
// - Non-stream JSON mode remains supported.
//
// Cloudflare/Vercel:
// - Runs server-side on Vercel. If your normal RPC URL is Cloudflare-protected worker (mojomaxi.com),
//   Vercel egress IPs can be blocked. We prefer HELIUS_RPC_URL first (server-only), then other fallbacks.
// - If we detect a Cloudflare block, we retry once against Solana public mainnet RPC.

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  AccountLayout,
} from "@solana/spl-token";
import { ensureConnection } from "@/lib/rpc";
import { getRelayer } from "@/lib/relayer.server";
import crypto from "crypto";
import bs58 from "bs58";

export const runtime = "nodejs";

function requireSecret(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const got = bearer || req.headers.get("x-admin-secret") || "";

  const want =
    (process.env.ADMIN_SWEEP_SECRET && process.env.ADMIN_SWEEP_SECRET.trim()) ||
    (process.env.SWEEP_SECRET && process.env.SWEEP_SECRET.trim()) ||
    "";

  if (!want) {
    const err: any = new Error("ADMIN_SWEEP_SECRET (or SWEEP_SECRET) not set");
    err.status = 500;
    throw err;
  }
  if (!got || got !== want) {
    const err: any = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
}

type Candidate = {
  pubkey: string; // token account pubkey
  program: "classic" | "token2022";
  mint: string;
  owner: string; // EC-PDA swap authority
  lamports: number;
  closeAuthority?: string | null;

  // provenance (helps grouping + UI)
  vault?: string;
  swapNonce?: string; // decimal string
};

type StreamEvent =
  | {
      type: "start";
      relayer: string;
      programId: string;
      dry: boolean;
      limit: number;
      include2022: boolean;
      timeoutMs: number;
      rpcEndpoint: string;
      sigLimit: number;
      maxPairs: number;
      maxDays: number;
      inferAta: boolean;
      txConcurrency: number;
      fullVaultScan: boolean;
      vaultScanLimit: number;
      vaultsFetched?: number;
      pairsInferredFromAtaEnsures?: number;
      unresolvedAtaEnsures?: number;
    }
  | { type: "phase"; name: string }
  | {
      type: "progress";
      program: "classic" | "token2022";
      scanned: number;
      total: number;
      found: number;
      elapsedMs: number;
      closed?: number;
      txs?: number;
      failedTxs?: number;
    }
  | {
      type: "done";
      ok: true;
      dry: boolean;
      found: number;
      candidates: Candidate[];
      attemptedClose?: number;
      closedEstimate?: number;
      rentLamportsEstimate?: number;
      txs?: number;
      sigs?: string[];
      txResults?: any[];
      stats: any;
    }
  | {
      type: "error";
      ok?: false;
      status?: number;
      error: string;
      code?: string;
      phase?: string;
      elapsedMs?: number;
      stack?: string;
      logs?: string[] | null;
    };

function nowMs() {
  return Date.now();
}

function pickEnv(...keys: string[]): string {
  for (const k of keys) {
    const v = (process.env as any)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function redactRpc(url: string): string {
  // Don’t leak API keys in logs / responses. Redact `api-key=`, `key=`, or long path tokens.
  try {
    const u = new URL(url);
    for (const k of ["api-key", "apikey", "key"]) {
      if (u.searchParams.has(k)) u.searchParams.set(k, "REDACTED");
    }
    // If the pathname looks like it contains a key segment (Helius sometimes does), redact it.
    if (u.pathname.length > 40) u.pathname = u.pathname.slice(0, 10) + "/REDACTED";
    return u.toString();
  } catch {
    return url;
  }
}

function serverRpcEndpoint(): string {
  // Prefer server-only RPC first.
  const e =
    pickEnv(
      "HELIUS_RPC_URL",
      "SERVER_RPC_URL",
      "SOLANA_RPC_URL",
      "RPC_URL",
      "NEXT_PUBLIC_RPC_URL"
    ) || "";

  // Avoid Cloudflare-protected mojomaxi domain from Vercel server egress.
  if (e && /mojomaxi\\.com/i.test(e)) {
    return clusterApiUrl("mainnet-beta");
  }

  return e || clusterApiUrl("mainnet-beta");
}

function makeServerConnection(commitment: "processed" | "confirmed" | "finalized") {
  const endpoint = serverRpcEndpoint();
  try {
    return ensureConnection({ endpoint, commitment });
  } catch {
    return new Connection(endpoint, commitment);
  }
}

function decodeBase64Data(raw: any): Buffer | null {
  if (!raw) return null;

  try {
    if (Array.isArray(raw) && typeof raw[0] === "string") {
      return Buffer.from(raw[0], "base64");
    }
    if (typeof raw === "string") {
      return Buffer.from(raw, "base64");
    }
    if (raw instanceof Uint8Array) {
      return Buffer.from(raw);
    }
    if (typeof raw === "object" && raw.type === "Buffer" && Array.isArray(raw.data)) {
      return Buffer.from(raw.data);
    }
  } catch {
    return null;
  }

  return null;
}

function decodeU64LE(v: any): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(v);
    if (typeof v === "string") {
      if (/^\\d+$/.test(v)) return BigInt(v);
    }
    if (Buffer.isBuffer(v)) return v.readBigUInt64LE(0);
    if (v instanceof Uint8Array) return Buffer.from(v).readBigUInt64LE(0);
    if (Array.isArray(v)) return Buffer.from(v).readBigUInt64LE(0);
    if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)) {
      return Buffer.from(v.data).readBigUInt64LE(0);
    }
  } catch {
    // fall through
  }
  return 0n;
}

function decodeAccountHeader(data: Buffer) {
  if (!data || data.length < AccountLayout.span) return null;

  const header = Buffer.from(data.subarray(0, AccountLayout.span));
  const decoded: any = AccountLayout.decode(header);

  const mintPk = new PublicKey(decoded.mint);
  const ownerPk = new PublicKey(decoded.owner);

  const amount: bigint = decodeU64LE(decoded.amount);

  const closeAuthorityOption = Number(decoded.closeAuthorityOption || 0);
  const closeAuthorityPk =
    closeAuthorityOption === 0 ? null : new PublicKey(decoded.closeAuthority);

  return { mintPk, ownerPk, amount, closeAuthorityPk };
}

function anchorDiscriminator(ixName: string): Buffer {
  // Anchor discriminator: first 8 bytes of sha256("global:<ix_name>")
  const preimage = `global:${ixName}`;
  return crypto.createHash("sha256").update(preimage).digest().subarray(0, 8);
}

const DISC_EXEC_EC = anchorDiscriminator("execute_swap_ec_pda");
const DISC_POST_CLEAN = anchorDiscriminator("post_swap_cleanup_ec_pda");
const DISC_SWEEP_BINS = anchorDiscriminator("sweep_ec_pda_bins");

function u64ToLeBuf(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function leBufToU64(data: Buffer, off: number): bigint {
  if (data.length < off + 8) throw new Error("Invalid u64 buffer");
  return data.readBigUInt64LE(off);
}

function leBufToPubkey(data: Buffer, off: number): PublicKey {
  if (data.length < off + 32) throw new Error("Invalid pubkey buffer");
  return new PublicKey(data.subarray(off, off + 32));
}

function deriveConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

function deriveSwapAuthority(programId: PublicKey, vault: PublicKey, swapNonce: bigint): PublicKey {
  const nonceLe = u64ToLeBuf(swapNonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("swap_authority"), vault.toBuffer(), nonceLe],
    programId
  )[0];
}

type PairKey = string;
type VaultNoncePair = { vault: PublicKey; swapNonce: bigint; swapAuthFromMemo?: PublicKey };

function pairKey(vault: PublicKey, swapNonce: bigint): PairKey {
  return `${vault.toBase58()}:${swapNonce.toString()}`;
}

function decodeIxDataToUtf8(data: string): string | null {
  if (!data) return null;

  // Memo program instruction data is typically base58-encoded UTF-8.
  // Some parsers return base64; try both and prefer strings that contain "mojomaxi:".
  const candidates: string[] = [];
  const looksPrintable = (s: string) => !!s && /[\\x09\\x0A\\x0D\\x20-\\x7E]/.test(s);

  try {
    const s = Buffer.from(bs58.decode(data)).toString("utf8");
    if (looksPrintable(s)) candidates.push(s);
  } catch {}

  try {
    const s = Buffer.from(data, "base64").toString("utf8");
    if (looksPrintable(s)) candidates.push(s);
  } catch {}

  if (candidates.length === 0) return null;
  const preferred = candidates.find((s) => s.includes("mojomaxi:"));
  return preferred || candidates[0];
}

function safeNum(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

type NdjsonSend = (obj: any) => void;

/**
 * Vercel-safe NDJSON streaming helper.
 * Important: the async work must start from within the stream's `start()` callback
 * or Vercel may terminate the response early.
 */
function makeNdjsonStream(
  handler: (send: NdjsonSend, close: () => void, isClosed: () => boolean) => Promise<void>
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const isClosed = () => closed;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch (_e) {}
      };

      const send: NdjsonSend = (obj: any) => {
        if (closed) return;
        try {
          const line = JSON.stringify(obj) + "\n";
          controller.enqueue(enc.encode(line));
        } catch (_e) {
          close();
        }
      };

      handler(send, close, isClosed).catch((e) => {
        try {
          const msg = e?.message ? String(e.message) : String(e);
          send({
            type: "error",
            ok: false,
            error: msg,
            code: e?.name ? String(e.name) : undefined,
            stack: e?.stack ? String(e.stack) : undefined,
          } satisfies StreamEvent);
        } catch (_e2) {
          // ignore
        } finally {
          close();
        }
      });
    },
    cancel() {
      // consumer disconnected
    },
  });
}


function looksLikeCloudflareBlock(err: any): boolean {
  const msg = String(err?.message || err || "");
  return /cloudflare|cf-ray|attention required|sorry, you have been blocked/i.test(msg);
}

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

async function bestEffortGetLogs(conn: Connection, e: any): Promise<string[] | null> {
  try {
    if (Array.isArray(e?.logs)) return e.logs;
  } catch {}
  try {
    if (typeof e?.getLogs === "function") {
      // Some SendTransactionError variants accept (connection) and some accept none.
      try {
        return await e.getLogs(conn as any);
      } catch {
        return await e.getLogs();
      }
    }
  } catch {}
  return null;
}

export async function GET(req: NextRequest) {
  const t0 = nowMs();
  let phase = "init";

  try {
    phase = "auth";
    requireSecret(req);

    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const stream = url.searchParams.get("stream") === "1";

    // Limit = max number of token accounts to close (across all pairs)
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || "200") || 200));
    const include2022 = url.searchParams.get("include2022") === "1";
    const timeoutMs = Math.max(
      2_000,
      Math.min(120_000, Number(url.searchParams.get("timeoutMs") || "45000") || 45_000)
    );

    // How many relayer signatures to scan (bounded).
    const sigLimit = Math.max(50, Math.min(10_000, safeNum(url.searchParams.get("sigLimit"), 2000)));
    // Stop after this many unique (vault, nonce) pairs.
    const maxPairs = Math.max(5, Math.min(10_000, safeNum(url.searchParams.get("maxPairs"), 2000)));
    // Concurrency for getTransaction() fetches during signature scan.
    const txConcurrency = Math.max(1, Math.min(12, safeNum(url.searchParams.get("txConcurrency"), 6)));

    // Only consider signatures within the last N days.
    const maxDays = Math.max(1, Math.min(365, safeNum(url.searchParams.get("maxDays"), 30)));
    // Expensive: infer (vault, swapNonce) for ATA-only ensure txs (older paths w/o memo). Default OFF.
    const inferAta = url.searchParams.get("inferAta") === "1";
    // Even more expensive: scan on-chain vault accounts to infer swapAuthority->(vault,nonce) for ATA-only ensures.
    const fullVaultScan = url.searchParams.get("fullVaultScan") === "1";
    const vaultScanLimit = Math.max(50, Math.min(5000, safeNum(url.searchParams.get("vaultScanLimit"), 1500)));


    // Optional pagination cursor for signature scan.
    const before = url.searchParams.get("before") || "";

    const PROGRAM_ID = new PublicKey(
      (process.env.MOJOMAXI_PROGRAM_ID && process.env.MOJOMAXI_PROGRAM_ID.trim()) ||
        "2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp"
    );

    const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

    // Associated Token Program (ATA). We use this to detect "ensure ATAs" transactions that may have
    // created EC-PDA bins even if the swap tx never ran (older code paths / crashes / timeouts).
    const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

    const RELAYER_PUBKEY = new PublicKey(
      (process.env.MOJOMAXI_RELAYER_PUBKEY && process.env.MOJOMAXI_RELAYER_PUBKEY.trim()) ||
        "6sHBrwXdSSAyHHCtqxqTSYA6uovGjxuRfLnfESDxdeBZ"
    );

    phase = "rpc_init";
    const conn = makeServerConnection("confirmed");
    const rpcEndpointRaw = (conn as any)?._rpcEndpoint || serverRpcEndpoint();
    const rpcEndpoint = redactRpc(rpcEndpointRaw);

    phase = "relayer_init";
    const relayer = getRelayer();

    // Safety: ensure the loaded relayer keypair matches the intended relayer pubkey.
    if (!relayer.publicKey.equals(RELAYER_PUBKEY)) {
      const err: any = new Error(
        `Relayer keypair mismatch. Expected ${RELAYER_PUBKEY.toBase58()} but loaded ${relayer.publicKey.toBase58()}`
      );
      err.status = 500;
      throw err;
    }

    const candidates: Candidate[] = [];

    // Some older EC-PDA flows (or crash/timeout windows) can leave behind an "ensure ATAs" tx
    // that only calls the ATA program and never emits our memo / never reaches the swap instruction.
    // We'll detect those and try to infer (vault, swapNonce) using swapNonce's timestamp encoding.
    const unresolvedEnsures = new Map<
      string,
      { sig: string; blockTime: number | null; mints: string[]; atAs: string[] }
    >();

    const stats: any = {
      relayer: RELAYER_PUBKEY.toBase58(),
      programId: PROGRAM_ID.toBase58(),
      dry,
      limit,
      include2022,
      timeoutMs,
      sigLimit,
      maxPairs,
      maxDays,
      inferAta,
      txConcurrency,
      before: before || null,
      nextBefore: null,
      windowStartAt: null,
      windowEndAt: null,
      rpcEndpoint,
      genesisHash: "",
      clusterHint: "unknown",
      relayerLamports: 0,
      signaturesScanned: 0,
      signaturesFetched: 0,
      pairsFound: 0,
      swapAuthoritiesFound: 0,
      pairsWithSwapAuthOverride: 0,
      overridesUsed: 0,
      scannedClassic: 0,
      scanned2022: 0,
      totalClassic: 0,
      total2022: 0,
      emptyClassic: 0,
      empty2022: 0,
      truncated: false,
      durationMs: 0,
      message: "",
    };

    // Quick sanity checks
    phase = "sanity_cluster";
    try {
      stats.genesisHash = await conn.getGenesisHash();
      if (stats.genesisHash === MAINNET_GENESIS) stats.clusterHint = "mainnet-beta";
      else if (stats.genesisHash === DEVNET_GENESIS) stats.clusterHint = "devnet";
      else stats.clusterHint = "unknown";
    } catch {}

    phase = "sanity_balance";
    try {
      stats.relayerLamports = await conn.getBalance(RELAYER_PUBKEY, "confirmed");
    } catch {}

    let forceStop = false;
    let forceStopReason: string | null = null;

    const shouldStop = () => {
      if (forceStop) return true;
      const elapsed = nowMs() - t0;
      return elapsed > timeoutMs || candidates.length >= limit;
    };

    // ---- Phase 1: Discover (vault, swapNonce) pairs by scanning relayer signatures ----
    const pairs = new Map<PairKey, VaultNoncePair>();

    const fetchPairsFromTx = async (sig: string): Promise<void> => {
      if (pairs.size >= maxPairs) return;
      if (nowMs() - t0 > timeoutMs) return;

      const tx = await conn.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      } as any);
      if (!tx) return;

      const msg: any = tx.transaction.message as any;

      // Support v0 messages with Address Lookup Tables (ALTs)
      let accountKeys: PublicKey[] = [];
      if (typeof msg.getAccountKeys === "function") {
        const keysObj: any = msg.getAccountKeys({ accountKeysFromLookups: (tx as any).meta?.loadedAddresses });
        const fromLookups = keysObj.accountKeysFromLookups || (keysObj.loadedAddresses as any);
        const writable: PublicKey[] = fromLookups?.writable || [];
        const readonly: PublicKey[] = fromLookups?.readonly || [];
        accountKeys = [...(keysObj.staticAccountKeys || []), ...writable, ...readonly];
      } else {
        accountKeys = (msg.accountKeys as PublicKey[]) || [];
      }

      const compiledIxs: any[] = msg.compiledInstructions || msg.instructions || [];

      for (const cix of compiledIxs) {
        const programId = accountKeys[cix.programIdIndex];
        if (!programId) continue;

        // Accept memo-only transactions: mojomaxi:ecpda_ensure:v1:<vault>:<swapNonce>:<wallet>
        if (programId.equals(MEMO_PROGRAM_ID)) {
          try {
            const memo = decodeIxDataToUtf8(cix.data);
            if (memo && memo.startsWith("mojomaxi:ecpda_ensure:v1:")) {
              const parts = memo.split(":");
              const vaultStr = parts?.[3];
              const swapNonceStr = parts?.[4];
              const walletStr = parts?.[5];
              if (vaultStr && swapNonceStr) {
                const vaultPk = new PublicKey(vaultStr);
                const swapNonce = BigInt(swapNonceStr);
                const key = pairKey(vaultPk, swapNonce);

                let swapAuthFromMemo: PublicKey | undefined;
                if (walletStr) {
                  try {
                    swapAuthFromMemo = new PublicKey(walletStr.trim());
                  } catch {}
                }

                const existing = pairs.get(key);
                pairs.set(key, {
                  vault: vaultPk,
                  swapNonce,
                  swapAuthFromMemo: existing?.swapAuthFromMemo || swapAuthFromMemo,
                });
              }
            }
          } catch {}
          continue;
        }

        // Detect ATA-only "ensure" txs: createIdempotent (payer=relayer, wallet=off-curve)
        // Accounts for createIdempotent are typically:
        //   [payer, ata, wallet(owner), mint, system_program, token_program]
        // We cannot close these bins unless we can infer the (vault, swapNonce) that derived the wallet.
        if (programId.equals(ATA_PROGRAM_ID)) {
          try {
            const acctIdxs: number[] = (cix.accountKeyIndexes || cix.accounts || []) as any;
            const payerIdx = acctIdxs?.[0];
            const ataIdx = acctIdxs?.[1];
            const walletIdx = acctIdxs?.[2];
            const mintIdx = acctIdxs?.[3];
            const payerPk = typeof payerIdx === "number" ? accountKeys[payerIdx] : null;
            const ataPk = typeof ataIdx === "number" ? accountKeys[ataIdx] : null;
            const walletPk = typeof walletIdx === "number" ? accountKeys[walletIdx] : null;
            const mintPk = typeof mintIdx === "number" ? accountKeys[mintIdx] : null;

            // Only care about relayer-funded, off-curve owners (EC-PDA swap authorities).
            if (payerPk && payerPk.equals(RELAYER_PUBKEY) && walletPk && !PublicKey.isOnCurve(walletPk.toBytes())) {
              const k = walletPk.toBase58();
              const prev = unresolvedEnsures.get(k);
              const mints = new Set([...(prev?.mints || []), ...(mintPk ? [mintPk.toBase58()] : [])]);
              const atAs = new Set([...(prev?.atAs || []), ...(ataPk ? [ataPk.toBase58()] : [])]);
              unresolvedEnsures.set(k, {
                sig,
                blockTime: (tx as any).blockTime ?? null,
                mints: Array.from(mints),
                atAs: Array.from(atAs),
              });
            }
          } catch {}
          continue;
        }

        if (!programId.equals(PROGRAM_ID)) continue;

        // Web3's getTransaction returns instruction data as base64 strings for compiled instructions
        const data = Buffer.from(cix.data, "base64");
        if (data.length < 8) continue;

        const disc = data.subarray(0, 8);

        // execute_swap_ec_pda: args begin with swap_nonce u64 at offset 8.
        if (disc.equals(DISC_EXEC_EC)) {
          try {
            const swapNonce = leBufToU64(data, 8);

            const vaultIdx = cix.accountKeyIndexes?.[1] ?? cix.accounts?.[1];
            const swapAuthIdx = cix.accountKeyIndexes?.[3] ?? cix.accounts?.[3];

            const vaultIxAcc = typeof vaultIdx === "number" ? accountKeys[vaultIdx] : null;
            const swapAuthIxAcc = typeof swapAuthIdx === "number" ? accountKeys[swapAuthIdx] : null;

            if (!vaultIxAcc) continue;

            const key = pairKey(vaultIxAcc, swapNonce);
            const existing = pairs.get(key);

            // IMPORTANT:
            // Derivation for swapAuthority has changed historically a few times.
            // Using the *actual* swapAuthority account from the on-chain instruction is the most robust.
            // prefer swapAuthority actually passed in the instruction (legacy-safe)
            const swapAuthFromIx = swapAuthIxAcc || existing?.swapAuthFromMemo;

            pairs.set(key, {
              vault: vaultIxAcc,
              swapNonce,
              swapAuthFromMemo: swapAuthIxAcc || existing?.swapAuthFromMemo,
            });
          } catch {}
          continue;
        }

        // post_swap_cleanup_ec_pda: args begin with swap_nonce u64 at offset 8.
        if (disc.equals(DISC_POST_CLEAN)) {
          try {
            const swapNonce = leBufToU64(data, 8);

            const vaultIdx = cix.accountKeyIndexes?.[1] ?? cix.accounts?.[1];
            const swapAuthIdx = cix.accountKeyIndexes?.[3] ?? cix.accounts?.[3];

            const vaultIxAcc = typeof vaultIdx === "number" ? accountKeys[vaultIdx] : null;
            const swapAuthIxAcc = typeof swapAuthIdx === "number" ? accountKeys[swapAuthIdx] : null;

            if (!vaultIxAcc) continue;

            const key = pairKey(vaultIxAcc, swapNonce);
            const existing = pairs.get(key);
            // prefer swapAuthority actually passed in the instruction (legacy-safe)
            const swapAuthFromIx = swapAuthIxAcc || existing?.swapAuthFromMemo;

            pairs.set(key, {
              vault: vaultIxAcc,
              swapNonce,
              swapAuthFromMemo: swapAuthIxAcc || existing?.swapAuthFromMemo,
            });
          } catch {}
          continue;
        }

        // sweep_ec_pda_bins: args: vault_pubkey (32) at offset 8, swap_nonce u64 at offset 40.
        if (disc.equals(DISC_SWEEP_BINS)) {
          try {
            const vaultPk = leBufToPubkey(data, 8);
            const swapNonce = leBufToU64(data, 8 + 32);

            // In sweep calls, the swap authority account is passed as the first account after payer.
            const swapAuthIdx = cix.accountKeyIndexes?.[1] ?? cix.accounts?.[1];
            const swapAuthIxAcc = typeof swapAuthIdx === "number" ? accountKeys[swapAuthIdx] : null;

            const key = pairKey(vaultPk, swapNonce);
            const existing = pairs.get(key);

            pairs.set(key, {
              vault: vaultPk,
              swapNonce,
              swapAuthFromMemo: existing?.swapAuthFromMemo || swapAuthIxAcc || undefined,
            });
          } catch {}
          continue;
        }
      }
    };

    const scanSignatures = async (send?: (evt: StreamEvent) => Promise<void>) => {
      phase = "sig_scan";
      if (send) await send({ type: "phase", name: phase });

      let cursor = before || undefined;
      let fetched = 0;
      let scanned = 0;

      let windowStartUnix: number | null = null;
      let windowCutoffUnix: number | null = null;
      let lastSeenSig: string | null = null;

      while (fetched < sigLimit && pairs.size < maxPairs && nowMs() - t0 <= timeoutMs) {
        const pageLimit = Math.min(1000, sigLimit - fetched);
        const sigs = await conn.getSignaturesForAddress(
          RELAYER_PUBKEY,
          { limit: pageLimit, before: cursor } as any
        );

        if (!sigs.length) break;

        if (windowStartUnix === null) {
          const bt0 = Number(sigs[0]?.blockTime || 0) || 0;
          windowStartUnix = bt0 || Math.floor(Date.now() / 1000);
          windowCutoffUnix = windowStartUnix - maxDays * 86400;
          stats.windowStartAt = new Date(windowStartUnix * 1000).toISOString();
          stats.windowEndAt = new Date(windowCutoffUnix * 1000).toISOString();
        }

        fetched += sigs.length;
        stats.signaturesFetched = fetched;

        const pending: string[] = [];

        const flush = async () => {
          if (!pending.length) return;
          const batch = pending.splice(0, pending.length);
          const chunks: string[][] = [];
          for (let i = 0; i < batch.length; i += txConcurrency) chunks.push(batch.slice(i, i + txConcurrency));
          for (const ch of chunks) {
            if (nowMs() - t0 > timeoutMs) break;
            await Promise.allSettled(ch.map((sig) => fetchPairsFromTx(sig)));
          }
        };

        for (const s of sigs) {
          if (pairs.size >= maxPairs) break;
          if (nowMs() - t0 > timeoutMs) break;

          lastSeenSig = s.signature;

          const bt = Number(s.blockTime || 0) || 0;
          if (bt && windowCutoffUnix && bt < windowCutoffUnix) {
            stats.sigScanStoppedAt = new Date(bt * 1000).toISOString();
            stats.nextBefore = lastSeenSig;
            await flush();
            return;
          }

          scanned++;
          stats.signaturesScanned = scanned;

          try {
            pending.push(s.signature);
          } catch {}

          if (send && (scanned % 50 === 0 || pairs.size % 25 === 0)) {
            await send({
              type: "progress",
              program: "classic",
              scanned,
              total: sigLimit,
              found: pairs.size,
              elapsedMs: nowMs() - t0,
            });
          }
        }

        await flush();

        cursor = sigs[sigs.length - 1]?.signature;
        if (!cursor) break;
      }

      stats.nextBefore = cursor || lastSeenSig || null;
    };

    // ---- Phase 1.5: Infer (vault, swapNonce) from ATA-only ensure txs ----
    // Our EC-PDA swapNonce is (ms<<16)|seq. If an older flow created ephemeral ATAs but never emitted the memo
    // and never reached the program swap tx, we can sometimes recover the pair by brute-forcing a tight time
    // window around the ensure tx's blockTime across *only the vaults we saw active in the scanned window*.
    const inferPairsFromAtaEnsures = async () => {
      if (!unresolvedEnsures.size) return;
      stats.unresolvedAtaEnsures = unresolvedEnsures.size;
      if (!inferAta) return;


      // Precompute known swapAuthority -> (vault,nonce)
      const known = new Map<string, VaultNoncePair>();
      const activeVaults: PublicKey[] = [];
      {
        const seenVault = new Set<string>();
        for (const p of pairs.values()) {
          const derived = deriveSwapAuthority(PROGRAM_ID, p.vault, p.swapNonce).toBase58();
          known.set(derived, p);
          if (p.swapAuthFromMemo) known.set(p.swapAuthFromMemo.toBase58(), p);
          const vk = p.vault.toBase58();
          if (!seenVault.has(vk)) {
            seenVault.add(vk);
            activeVaults.push(p.vault);
          }
        }
      }


      
// If enabled, broaden search space by loading vault accounts from chain.
if (fullVaultScan) {
  try {
    // NOTE: we intentionally keep this light. We only need vault pubkeys.
    // If your vault account is a PDA owned by PROGRAM_ID, this returns those accounts.
    const vaultAccts = await conn.getProgramAccounts(PROGRAM_ID, {
      // no data slice needed; just pubkeys
      dataSlice: { offset: 0, length: 0 },
    });
    stats.vaultsFetched = Math.min(vaultAccts.length, vaultScanLimit);
    for (let i = 0; i < vaultAccts.length && activeVaults.length < vaultScanLimit; i++) {
      activeVaults.push(vaultAccts[i].pubkey);
    }
  } catch (e) {
    // ignore - inference will just be best-effort
  }
}
      // NOTE: do not hard-truncate activeVaults; inference quality depends on having
      // access to as many vault pubkeys as possible (bounded by vaultScanLimit).

      const WINDOW_SEC = 2; // +/- 2s is usually plenty (blockTime is seconds granularity)
      const MAX_SEQ = 32; // within a millisecond, we rarely exceed this under normal relayer load

      let inferred = 0;
      for (const [swapAuthStr, info] of unresolvedEnsures.entries()) {
        if (pairs.size >= maxPairs) break;
        if (nowMs() - t0 > timeoutMs) break;

        // If we already have a matching pair (swap tx reached the program), nothing to do.
        if (known.has(swapAuthStr)) continue;

        const bt = info.blockTime;
        if (!bt || activeVaults.length === 0) continue;

        const target = new PublicKey(swapAuthStr);
        const msStart = (bt - WINDOW_SEC) * 1000;
        const msEnd = (bt + WINDOW_SEC) * 1000 + 999;

        let foundPair: VaultNoncePair | null = null;
        // Tight brute-force across active vaults and a few thousand ms.
        for (const vaultPk of activeVaults) {
          if (foundPair) break;
          for (let ms = msStart; ms <= msEnd; ms++) {
            if (nowMs() - t0 > timeoutMs) break;
            for (let seq = 0; seq <= MAX_SEQ; seq++) {
              // tight guard for Vercel timeouts
              if (nowMs() - t0 > timeoutMs) break;
              const swapNonce = (BigInt(ms) << 16n) | BigInt(seq);
              const sa = deriveSwapAuthority(PROGRAM_ID, vaultPk, swapNonce);
              if (sa.equals(target)) {
                foundPair = { vault: vaultPk, swapNonce, swapAuthFromMemo: target };
                break;
              }
            }
            if (foundPair) break;
          }
        }

        if (foundPair) {
          inferred++;
          pairs.set(pairKey(foundPair.vault, foundPair.swapNonce), foundPair);
          known.set(swapAuthStr, foundPair);
        }
      }

      if (inferred) {
        stats.pairsInferredFromAtaEnsures = (stats.pairsInferredFromAtaEnsures || 0) + inferred;
      }
      stats.unresolvedAtaEnsures = unresolvedEnsures.size;
    };

    // ---- Phase 2: For each pair, scan token accounts owned by derived (or memo) swap authority ----
    const scanSwapAuthorityTokenAccounts = async (
      vault: PublicKey,
      swapNonce: bigint,
      swapAuthOverride?: PublicKey,
      send?: (evt: StreamEvent) => Promise<void>
    ) => {
      const derivedSwapAuth = deriveSwapAuthority(PROGRAM_ID, vault, swapNonce);
      const swapAuth = swapAuthOverride || derivedSwapAuth;
      if (swapAuthOverride) stats.overridesUsed++;
      stats.swapAuthoritiesFound++;

      const scanByProgram = async (tokenProgramId: PublicKey, tag: "classic" | "token2022") => {
        if (shouldStop()) return;

        phase = `fetch_${tag}`;
        if (send) await send({ type: "phase", name: phase });

        let resp: any;
        try {
          resp = await conn.getTokenAccountsByOwner(swapAuth, { programId: tokenProgramId });
        } catch (e: any) {
          if (looksLikeCloudflareBlock(e)) {
            const fallback = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");
            stats.rpcEndpointFallback = clusterApiUrl("mainnet-beta");
            resp = await fallback.getTokenAccountsByOwner(swapAuth, { programId: tokenProgramId });
          } else {
            throw e;
          }
        }

        const total = resp.value.length;
        if (tag === "classic") stats.totalClassic += total;
        else stats.total2022 += total;

        phase = `scan_${tag}`;
        if (send) await send({ type: "phase", name: phase });

        let scanned = 0;
        for (const it of resp.value) {
          if (shouldStop()) break;

          scanned++;
          if (tag === "classic") stats.scannedClassic++;
          else stats.scanned2022++;

          const pkStr = it.pubkey.toBase58();
          const data = decodeBase64Data((it.account.data as any));
          if (!data) continue;

          const hdr = decodeAccountHeader(data);
          if (!hdr) continue;

          if (!hdr.ownerPk.equals(swapAuth)) continue;

          const isEmpty = hdr.amount === 0n;
          if (!isEmpty) continue;

          if (tag === "classic") stats.emptyClassic++;
          else stats.empty2022++;

          const closeAuthStr = hdr.closeAuthorityPk ? hdr.closeAuthorityPk.toBase58() : null;
          if (closeAuthStr && closeAuthStr !== swapAuth.toBase58()) continue;

          candidates.push({
            pubkey: pkStr,
            program: tag,
            mint: hdr.mintPk.toBase58(),
            owner: swapAuth.toBase58(),
            lamports: Number(it.account.lamports || 0) || 0,
            closeAuthority: closeAuthStr,
            vault: vault.toBase58(),
            swapNonce: swapNonce.toString(),
          });

          if (send && (stats.scannedClassic + stats.scanned2022) % 250 === 0) {
            await send({
              type: "progress",
              program: tag,
              scanned,
              total,
              found: candidates.length,
              elapsedMs: nowMs() - t0,
            });
          }
        }
      };

      await scanByProgram(TOKEN_PROGRAM_ID, "classic");
      if (include2022 && !shouldStop()) {
        await scanByProgram(TOKEN_2022_PROGRAM_ID, "token2022");
      }
    };

    const closeCandidates = async (send?: (evt: StreamEvent) => Promise<void>) => {
      // Config PDA must exist for Anchor to accept the sweep.
      const configPda = deriveConfigPda(PROGRAM_ID);
      const configInfo = await conn.getAccountInfo(configPda, { commitment: "confirmed" });
      if (!configInfo || !configInfo.data || configInfo.data.length === 0) {
        return {
          ok: false as const,
          code: "AccountNotInitialized",
          error:
            "Program config PDA is not initialized (or wrong PDA derived). Cannot sweep EC-PDA bins. Ensure config is initialized on-chain for this PROGRAM_ID (and that this route derives the same PDA seeds as the program).",
          configPda: configPda.toBase58(),
          txResults: [] as any[],
          sigs: [] as string[],
          closedCount: 0,
        };
      }

      // Group candidates by (vault, swapNonce, token program tag) to keep batches consistent.
      const groups = new Map<string, Candidate[]>();
      for (const c of candidates) {
        const k = `${c.vault}:${c.swapNonce}:${c.program}`;
        const arr = groups.get(k) || [];
        arr.push(c);
        groups.set(k, arr);
      }

      const sigs: string[] = [];
      const txResults: any[] = [];
      let closedCount = 0;

      for (const [k, group] of groups) {
        if (nowMs() - t0 > timeoutMs) break;

        const [vaultStr, swapNonceStr, progTag] = k.split(":");
        const vaultPk = new PublicKey(vaultStr);
        const swapNonce = BigInt(swapNonceStr);

        // Prefer memo-discovered/actual owner if present in candidate.
        let swapAuth = deriveSwapAuthority(PROGRAM_ID, vaultPk, swapNonce);
        const owner0 = group?.[0]?.owner;
        if (owner0) {
          try {
            swapAuth = new PublicKey(owner0);
          } catch {}
        }

        const tokenProg = progTag === "token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

        // Anchor data: discriminator + vault_pubkey + swap_nonce
        const data = Buffer.concat([DISC_SWEEP_BINS, vaultPk.toBuffer(), u64ToLeBuf(swapNonce)]);

        // Batching: keep small to avoid tx size issues.
        const batchSize = 10;

        for (let i = 0; i < group.length; i += batchSize) {
          if (nowMs() - t0 > timeoutMs) break;
          const batch = group.slice(i, i + batchSize);

          // Anchor accounts order (see on-chain SweepEcPdaBins):
          // payer (relayer signer), swap_authority, config, then repeating (token_program, token_account)...
          const keys: any[] = [
            { pubkey: RELAYER_PUBKEY, isSigner: true, isWritable: true },
            { pubkey: swapAuth, isSigner: false, isWritable: false },
            { pubkey: configPda, isSigner: false, isWritable: false },
          ];

          for (const c of batch) {
            keys.push({ pubkey: tokenProg, isSigner: false, isWritable: false });
            keys.push({ pubkey: new PublicKey(c.pubkey), isSigner: false, isWritable: true });
          }

          const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });

          const latest = await conn.getLatestBlockhash("confirmed");
          const v0msg = new TransactionMessage({
            payerKey: RELAYER_PUBKEY,
            recentBlockhash: latest.blockhash,
            instructions: [
              ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
              ix,
            ],
          }).compileToV0Message();

          const tx = new VersionedTransaction(v0msg);
          tx.sign([relayer]);

          let sig: string | null = null;
          let txOk = true;
          let txErr: string | null = null;
          let txLogs: string[] | null = null;

          try {
            sig = await conn.sendTransaction(tx, { maxRetries: 3 });
            sigs.push(sig);

            const confLatest = await conn.getLatestBlockhash("confirmed");
            await conn.confirmTransaction(
              {
                signature: sig,
                blockhash: confLatest.blockhash,
                lastValidBlockHeight: confLatest.lastValidBlockHeight,
              },
              "confirmed"
            );

            closedCount += batch.length;
          } catch (e: any) {
            txOk = false;
            txErr = String(e?.message || e);
            txLogs = await bestEffortGetLogs(conn, e);

            const joined = (txLogs || []).join("\\n") + "\\n" + txErr;
            if (joined.includes("AccountNotInitialized") && joined.includes("account: config")) {
              forceStopReason =
                "SweepEcPdaBins failed: config account not initialized. This usually means the on-chain config PDA is missing OR the client passed accounts in the wrong order.";
              forceStop = true;
            }
          }

          txResults.push({
            sig,
            ok: txOk,
            batchSize: batch.length,
            first: batch[0]?.pubkey || null,
            last: batch[batch.length - 1]?.pubkey || null,
            err: txErr,
            logs: txLogs ? txLogs.slice(-30) : null,
          });

          if (send) {
            await send({
              type: "progress",
              program: "classic",
              scanned: Math.min(i + batch.length, group.length),
              total: group.length,
              found: candidates.length,
              closed: closedCount,
              txs: sigs.length,
              failedTxs: txResults.filter((t: any) => t && t.ok === false).length,
              elapsedMs: nowMs() - t0,
            });
          }

          if (forceStop) break;
        }

        if (forceStop) break;
      }

      return {
        ok: true as const,
        code: forceStopReason ? "Stopped" : "Ok",
        error: forceStopReason,
        txResults,
        sigs,
        closedCount,
      };
    };

    // -----------------------------
    // STREAMING (NDJSON) EXECUTION
    // -----------------------------

    // Non-stream mode needs these computed after scanning.
    let outCandidates: Candidate[] = [];
    let found = 0;

    if (stream) {
      const readable = makeNdjsonStream(async (send, close, isClosed) => {
        try {
          phase = "start";
          await send({
            type: "start",
            relayer: RELAYER_PUBKEY.toBase58(),
            programId: PROGRAM_ID.toBase58(),
            dry,
            limit,
            include2022,
            timeoutMs,
            rpcEndpoint,
            sigLimit,
            maxPairs,
            maxDays,
            inferAta,
            txConcurrency,
            fullVaultScan,
            vaultScanLimit,
          } satisfies StreamEvent);

          console.log(
            `[sweep-ecpda-empties] start relayer=${RELAYER_PUBKEY.toBase58()} program=${PROGRAM_ID.toBase58()} dry=${dry} limit=${limit} include2022=${include2022} sigLimit=${sigLimit} maxPairs=${maxPairs} maxDays=${maxDays} inferAta=${inferAta} txConcurrency=${txConcurrency} timeoutMs=${timeoutMs} rpc=${rpcEndpoint}`
          );

          const sendAsync = async (evt: StreamEvent) => {
            // NdjsonSend may be synchronous; normalize to a Promise-returning function for helpers.
            await (send as any)(evt);
          };

          await scanSignatures(sendAsync);
          if (inferAta) await inferPairsFromAtaEnsures();
          stats.pairsFound = pairs.size;
        stats.pairsWithSwapAuthOverride = Array.from(pairs.values()).filter((p) => !!p.swapAuthFromMemo).length;

          phase = "scan_token_accounts";
          await send({ type: "phase", name: phase });

          for (const p of pairs.values()) {
            if (shouldStop()) break;
            await scanSwapAuthorityTokenAccounts(p.vault, p.swapNonce, p.swapAuthFromMemo, sendAsync);
          }

          const elapsed = nowMs() - t0;
          stats.durationMs = elapsed;

          if (elapsed > timeoutMs) {
            stats.truncated = true;
            stats.message = `Timed out after ${timeoutMs}ms. Returning partial results.`;
          } else if (candidates.length === 0) {
            if ((stats.totalClassic || 0) + (stats.total2022 || 0) === 0) {
              if ((stats.unresolvedAtaEnsures || 0) > 0 && !inferAta) {
              stats.message =
                "Scan completed. 0 empty EC-PDA token accounts found, but this window contains ATA-only ensure transactions without memos. To infer (vault,nonce) for those legacy bins, run with ?inferAta=1&fullVaultScan=1 (and increase vaultScanLimit/maxDays as needed).";
            } else {
              stats.message =
                "Scan completed. 0 empty EC-PDA token accounts found in the scanned relayer window. Try increasing sigLimit/maxDays (or set ?before= for older history).";
            }
            } else {
              stats.message =
                "Scan completed. EC-PDA token accounts exist, but none were empty+closable (amount==0 and closeAuthority is swap authority or unset).";
            }
          } else {
            stats.message = `Scan completed. Found ${candidates.length} candidate account(s).`;
          }

          console.log(
            `[sweep-ecpda-empties] discovered candidates=${candidates.length} pairs=${pairs.size} pairsWithOverride=${stats.pairsWithSwapAuthOverride} overridesUsed=${stats.overridesUsed} scannedClassic=${stats.scannedClassic} scanned2022=${stats.scanned2022} emptyClassic=${stats.emptyClassic} empty2022=${stats.empty2022} cluster=${stats.clusterHint}`
          );

          if (dry || candidates.length === 0) {
            await send({
              type: "done",
              ok: true,
              dry: true,
              found: candidates.length,
              candidates,
              stats,
            } satisfies StreamEvent);
            await close();
            return;
          }

          phase = "close_begin";
          await send({ type: "phase", name: phase });

          const closeRes = await closeCandidates(sendAsync);

          if (!closeRes.ok) {
            await send({
              type: "error",
              ok: false,
              error: closeRes.error,
              code: closeRes.code,
              phase,
              elapsedMs: nowMs() - t0,
            } satisfies StreamEvent);

            await send({
              type: "done",
              ok: true,
              dry,
              found: candidates.length,
              candidates,
              txs: 0,
              sigs: [],
              txResults: [],
              stats: { ...stats, message: closeRes.error, configPda: closeRes.configPda },
            } satisfies StreamEvent);

            await close();
            return;
          }

          phase = "done";
          await send({
            type: "done",
            ok: true,
            dry: dry,
            found: candidates.length,
            candidates,
            txs: closeRes.sigs.length,
            sigs: closeRes.sigs,
            txResults: closeRes.txResults,
            stats: { ...stats, closed: closeRes.closedCount, message: stats.message },
          } satisfies StreamEvent);

          await close();
        } catch (e: any) {
          const status = Number(e?.status || 400) || 400;
          console.log(`[sweep-relayer-empties] error status=${status} phase=${phase} msg=${String(e?.message || e)}`);
          try {
            await send({
              type: "error",
              ok: false,
              status,
              error: String(e?.message || e),
              phase,
              elapsedMs: nowMs() - t0,
              stack: typeof e?.stack === "string" ? e.stack : undefined,
            } satisfies StreamEvent);
          } finally {
            await close();
          }
        }
      
      });

      return new Response(readable, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store, no-transform",
        },
      });
    } else {
      // -----------------------------
      // NON-STREAM JSON EXECUTION
      // -----------------------------
      await scanSignatures();
      if (inferAta) await inferPairsFromAtaEnsures();
      stats.pairsFound = pairs.size;
        stats.pairsWithSwapAuthOverride = Array.from(pairs.values()).filter((p) => !!p.swapAuthFromMemo).length;

      phase = "scan_token_accounts";
      for (const p of pairs.values()) {
        if (shouldStop()) break;
        await scanSwapAuthorityTokenAccounts(p.vault, p.swapNonce, p.swapAuthFromMemo);
      }

      const elapsed = nowMs() - t0;
      stats.durationMs = elapsed;

      outCandidates = candidates.slice(0, limit);
      found = outCandidates.length;

      if (elapsed > timeoutMs) {
        stats.truncated = true;
        stats.message = `Timed out after ${timeoutMs}ms. Returning partial results.`;
      } else if (found === 0) {
        if ((stats.totalClassic || 0) + (stats.total2022 || 0) === 0) {
          if ((stats.unresolvedAtaEnsures || 0) > 0 && !inferAta) {
              stats.message =
                "Scan completed. 0 empty EC-PDA token accounts found, but this window contains ATA-only ensure transactions without memos. To infer (vault,nonce) for those legacy bins, run with ?inferAta=1&fullVaultScan=1 (and increase vaultScanLimit/maxDays as needed).";
            } else {
              stats.message =
                "Scan completed. 0 empty EC-PDA token accounts found in the scanned relayer window. Try increasing sigLimit/maxDays (or set ?before= for older history).";
            }
        } else {
          stats.message =
            "Scan completed. EC-PDA token accounts exist, but none were empty+closable (amount==0 and closeAuthority is swap authority or unset).";
        }
      } else {
        stats.message = `Scan completed. Found ${found} candidate account(s).`;
      }
    }
    if (forceStopReason) stats.forceStopReason = forceStopReason;

    if (dry || found === 0) {
      return NextResponse.json({
        ok: true,
        dry,
        relayer: RELAYER_PUBKEY.toBase58(),
        programId: PROGRAM_ID.toBase58(),
        found,
        candidates: outCandidates,
        // ATA-only ensures we observed (relayer-funded, off-curve owner). These may or may not be inferable/closable.
        // Useful for forensics when a handful of bins remain without memos.
        ataOnlyEnsures: Array.from(unresolvedEnsures.entries())
          .slice(0, 50)
          .map(([swapAuthority, v]) => ({ swapAuthority, ...v })),
        stats,
      });
    }

    phase = "close_begin";
    const closeRes = await closeCandidates();

    if (!closeRes.ok) {
      return NextResponse.json({
        ok: true,
        dry,
        relayer: RELAYER_PUBKEY.toBase58(),
        programId: PROGRAM_ID.toBase58(),
        found,
        candidates: outCandidates,
        ataOnlyEnsures: Array.from(unresolvedEnsures.entries())
          .slice(0, 50)
          .map(([swapAuthority, v]) => ({ swapAuthority, ...v })),
        swept: {
          attempted: found,
          closed: 0,
          txs: 0,
          sigs: [],
          results: [],
          error: closeRes.error,
          code: closeRes.code,
          configPda: closeRes.configPda,
        },
        stats: { ...stats, message: closeRes.error, configPda: closeRes.configPda },
      });
    }

    return NextResponse.json({
      ok: true,
      dry,
      relayer: RELAYER_PUBKEY.toBase58(),
      programId: PROGRAM_ID.toBase58(),
      found,
      candidates: outCandidates,
      ataOnlyEnsures: Array.from(unresolvedEnsures.entries())
        .slice(0, 50)
        .map(([swapAuthority, v]) => ({ swapAuthority, ...v })),
      swept: {
        attempted: found,
        closed: closeRes.closedCount,
        txs: closeRes.sigs.length,
        sigs: closeRes.sigs,
        results: closeRes.txResults,
        error: closeRes.error || null,
        code: closeRes.code,
      },
      stats: {
        ...stats,
        closed: closeRes.closedCount,
        message: `Sweep attempted. Closed ${closeRes.closedCount} empty EC-PDA token accounts.`,
      },
    });
  } catch (e: any) {
    const message = String(e?.message || e || "Unknown error");
    const status = Number(e?.status || 500) || 500;
    return NextResponse.json(
      {
        ok: false,
        error: message,
        phase,
        elapsedMs: nowMs() - t0,
        stack: e?.stack ? String(e.stack) : null,
      },
      { status }
    );
  }
}
