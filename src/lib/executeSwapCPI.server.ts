// File: src/lib/executeSwapCPI.server.ts
// PAS-only first, EC-PDA fallback for VA-signer routes
// - Phase 1: try execute_swap (PAS-only) with VA-signer guard.
// - Phase 2: if all packs want VA signer, use execute_swap_ec_pda with swap_authority EC-PDA.
// - 2025-11-13 (LUTS FIX): Load and include Address Lookup Tables (LUTs) in FINAL tx build for both PAS and EC-PDA.
// - 2025-11-19 (STEPPED SLIPPAGE & JITO): Removed Jupiter "dynamic slippage". We step fixed slippage by +50 bps
//   (configurable) on each retry across PAS and EC-PDA. Jito tipping/priority logic gated on actual slippage used.
// - 2025-11-27 (EC-PDA SLIPPAGE REQUOTE): On EC-PDA path, if pre-sim or send errors show "slippage tolerance
//   exceeded", we re-quote with higher slippage (Jupiter Pro) up to a bounded retry count before actually sending.
//
// Golden rule respected: custody remains PDA-only (wrapAndUnwrapSol: false), UI untouched.

import "server-only";
import bs58 from "bs58";
import {
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// Memo program (used to tag EC-PDA *ensure* transactions so sweep-relayer-empties can find/close bins
// even if the subsequent swap tx never runs).
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, "utf8"),
  });
}


// === EC-PDA robustness knobs (server-side only, safe defaults) ===
// Extra retry variants for EC-PDA fallback.
// These only run inside the EC-PDA path and DO NOT affect PAS behavior.
const EC_PDA_EXTRA_RETRY_ATTEMPTS = Math.max(
  0,
  Number(process.env.EC_PDA_EXTRA_RETRY_ATTEMPTS || 4) || 4
);

// Slippage step (bps) added per retry across PAS/EC-PDA. Default 50 bps = 0.50%.
const STEP_SLIPPAGE_BPS = Math.max(0, Number(process.env.JUP_STEP_SLIPPAGE_BPS || 50) || 50);

// Adds slippage (in bps) for each extra EC-PDA attempt beyond the first.
const EC_PDA_EXTRA_RETRY_SLIPPAGE_ADD_BPS = Math.max(
  0,
  Math.min(2000, Number(process.env.EC_PDA_EXTRA_RETRY_SLIPPAGE_ADD_BPS || STEP_SLIPPAGE_BPS) || STEP_SLIPPAGE_BPS)
);

// On the very last EC-PDA try, optionally request only direct routes as a last-ditch simplifier.
const EC_PDA_LAST_TRY_DIRECT_ONLY = String(process.env.EC_PDA_LAST_TRY_DIRECT_ONLY || "true")
  .toLowerCase() === "true";

// Post-swap ephemeral EC-PDA ATA cleanup (best-effort):
// Wait N ms, then check both ephemeral ATAs. If both exist and are empty, ask the program
// to run cleanup again (which in most builds will close empty EC-PDA bins). This is
// guarded by env and completely no-op on error so current swaps are never blocked.
const EC_PDA_POST_CLOSE_DELAY_MS = Math.max(0, Number(process.env.EC_PDA_POST_CLOSE_DELAY_MS || 350) || 350);
const EC_PDA_ENABLE_POST_CLOSE = String(process.env.EC_PDA_ENABLE_POST_CLOSE || "true")
  .toLowerCase() === "true";

// Optional follow-up: sweep/close ALL empty EC-PDA token accounts ("bins") by scanning chain state.
// This uses the on-chain instruction `sweep_ec_pda_bins` and is best-effort (never blocks swaps).
const EC_PDA_ENABLE_EMPTY_BIN_SWEEP = String(process.env.EC_PDA_ENABLE_EMPTY_BIN_SWEEP || "true")
  .toLowerCase() === "true";

// How many empty token accounts to close per sweep transaction (each uses 2 remaining accounts: program+account).
const EC_PDA_EMPTY_BIN_SWEEP_CHUNK = Math.max(2, Number(process.env.EC_PDA_EMPTY_BIN_SWEEP_CHUNK || 10) || 10);
// Optional follow-up: sweep/close ALL empty *relayer-owned* token accounts by scanning chain state.
// Some Jupiter/Meteora setups may create temporary token accounts owned by the fee payer (relayer),
// not by the EC-PDA swap authority. These can accumulate rent unless proactively closed.
const RELAYER_ENABLE_EMPTY_BIN_SWEEP = String(process.env.RELAYER_ENABLE_EMPTY_BIN_SWEEP || "true")
  .toLowerCase() === "true";
const RELAYER_EMPTY_BIN_SWEEP_CHUNK = Math.max(2, Number(process.env.RELAYER_EMPTY_BIN_SWEEP_CHUNK || 10) || 10);
// Safety: skip closing Associated Token Accounts (ATAs) during the relayer empty-account sweep.
// ATAs are often used as persistent "vault authority" accounts for bots, and closing them can create
// noisy failures/recreation churn even if they are empty.
const RELAYER_SWEEP_SKIP_ATAS = String(process.env.RELAYER_SWEEP_SKIP_ATAS || "true")
  .toLowerCase() === "true";

function getTreasuryWalletAddressStrict(): string {
  // Prefer the server-side env var. We never fall back to the relayer/payer wallet,
  // because that would incorrectly create ATAs (rent) on the relayer during fee payout.
  const addr = process.env.TREASURY_WALLET;
  if (!addr) {
    throw new Error("Treasury wallet env var missing. Set TREASURY_WALLET.");
  }

  return addr;
}

// How many times to poll balances before giving up on the post-close pass.
const EC_PDA_POST_CLOSE_MAX_POLLS = Math.max(1, Number(process.env.EC_PDA_POST_CLOSE_MAX_POLLS || 3) || 3);
// Delay between polls (ms). Default ~0.5s to straddle a slot under typical conditions.
const EC_PDA_POST_CLOSE_POLL_INTERVAL_MS = Math.max(
  100,
  Number(process.env.EC_PDA_POST_CLOSE_POLL_INTERVAL_MS || 450) || 450
);
// If true, we will attempt the cleanup-only call when *either* ephemeral ATA is empty (rather than requiring both).
const EC_PDA_POST_CLOSE_ANY_EMPTY = String(process.env.EC_PDA_POST_CLOSE_ANY_EMPTY || "true")
  .toLowerCase() === "true";

// Extra EC-PDA re-quotes when the swap sim / send fails with a slippage-tolerance error.
// These *only* re-quote (no lamports spent) and rebuild the EC-PDA tx, up to a bounded max.
// Default: 10 extra slippage bumps on EC-PDA for "slippage tolerance exceeded" style errors.
const EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_MAX = Math.max(
  0,
  Number(process.env.EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_MAX || 10) || 10
);

const EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_BPS = Math.max(
  0,
  Math.min(
    2000,
    Number(process.env.EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_BPS || STEP_SLIPPAGE_BPS) || STEP_SLIPPAGE_BPS
  )
);

// HARD LIMIT: CPI into Jupiter cannot pass more than 64 AccountInfos in a single invoke/invoke_signed.
// Our on-chain vault program invokes Jupiter with `[jupiter_program] + route_accounts` (or segment accounts),
// so each segment must be <= 63 accounts.
const EC_PDA_MAX_JUPITER_CPI_ACCOUNTS = Math.max(
  8,
  Math.min(63, Number(process.env.MOJOMAXI_EC_PDA_MAX_JUPITER_CPI_ACCOUNTS || 63) || 63)
);


// === Jupiter program allowlist (security hardening) ===
// The pack provides routeIx.programId. We enforce it matches known Jupiter swap program IDs
// to prevent executing unexpected programs via a malicious/compromised quote source.
// Default: Jupiter Swap Program (mainnet). Override via MOJOMAXI_ALLOWED_JUPITER_PROGRAM_IDS (comma-separated).
const DEFAULT_JUPITER_PROGRAM_IDS = ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"];
const ALLOWED_JUPITER_PROGRAM_IDS: PublicKey[] = String(process.env.MOJOMAXI_ALLOWED_JUPITER_PROGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .concat(DEFAULT_JUPITER_PROGRAM_IDS)
  .filter((v, i, arr) => arr.indexOf(v) === i)
  .map((s) => new PublicKey(s));

function assertAllowedJupiterProgram(programId: PublicKey, ctx: { stage: string; debugId?: string }) {
  const got = programId?.toBase58 ? programId.toBase58() : String(programId);
  if (ALLOWED_JUPITER_PROGRAM_ID_SET.has(got)) return;
  // Fallback: if caller passed a PublicKey-like with equals but no toBase58 for some reason.
  if (programId?.equals && ALLOWED_JUPITER_PROGRAM_IDS.some((p) => programId.equals(p))) return;

  const allowed = ALLOWED_JUPITER_PROGRAM_IDS.map((p) => p.toBase58()).join(",");
  const dbg = ctx?.debugId ? ` debugId=${ctx.debugId}` : "";
  throw new Error(`unexpected_jupiter_program: got=${got} allowed=[${allowed}] stage=${ctx.stage}${dbg}`);
}

// --- Local helper to set compute budget first in the transaction ---
// Price 'auto' means do not set a CU price here (leave it to RPC / priority fees).
function ensureSetComputeBudgetIxs(opts: {
  cuLimit?: number;
  cuPriceMicroLamports?: number | "auto";
}): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  try {
    const rawLimit =
      typeof opts?.cuLimit === "number" && isFinite(opts.cuLimit) ? Math.floor(opts.cuLimit) : 1_000_000;
    // clamp between 200k and 1.4M (current max)
    const units = Math.max(200_000, Math.min(1_400_000, rawLimit));
    out.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    const price = opts?.cuPriceMicroLamports;
    if (typeof price === "number" && isFinite(price) && price > 0) {
      out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(price) }));
    } // if 'auto', intentionally skip setting a price here
  } catch {
    // If anything goes wrong, fall back to a conservative single instruction to avoid build-time failures.
    out.length = 0;
    out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
  }
  return out;
}

// === PAS landing optimization knobs ===
// We want PAS (non-EC-PDA) to land whenever feasible, because EC-PDA creates extra temp accounts and cleanup cost.
// These knobs are intentionally conservative: small priority fees early, escalating only on later PAS attempts.
const PAS_ENABLE_EARLY_PRIORITY = String(process.env.PAS_ENABLE_EARLY_PRIORITY || "true").toLowerCase() === "true";
// Max lamports we are willing to spend on *attempt #1* priority fees (v0 priorityLevelWithMaxLamports).
const PAS_EARLY_PRIORITY_CAP_LAMPORTS = Math.max(
  0,
  Number(process.env.PAS_EARLY_PRIORITY_CAP_LAMPORTS || 800) || 800
);

const ALLOWED_JUPITER_PROGRAM_ID_SET = new Set(ALLOWED_JUPITER_PROGRAM_IDS.map((p) => p.toBase58()));

// Max RPC resend retries for PAS sends. Higher helps landing without switching to EC-PDA.
const PAS_SEND_MAX_RETRIES = Math.max(0, Number(process.env.PAS_SEND_MAX_RETRIES || 6) || 6);


// Hardened per-swap nonce to avoid same-millisecond collisions across concurrent bots.
// Uses ms<<16 plus a 16-bit sequence to guarantee uniqueness within the same millisecond.
let _mm_lastMs = 0;
let _mm_seq = 0;
function nextSwapNonce(): bigint {
  const ms = Date.now();
  if (ms === _mm_lastMs) {
    _mm_seq = (_mm_seq + 1) & 0xffff;
  } else {
    _mm_lastMs = ms;
    _mm_seq = 0;
  }
  return (BigInt(ms) << 16n) | BigInt(_mm_seq);
}

function toErrDiag(e: any): {
  message: string;
  name?: string;
  stack?: string;
  status?: number;
  statusText?: string;
} {
  const message = String(e?.message || e);
  const name = typeof e?.name === "string" ? e.name : undefined;
  const stack = typeof e?.stack === "string" ? String(e.stack).slice(0, 4000) : undefined;
  const status = typeof e?.response?.status === "number" ? e.response.status : undefined;
  const statusText = typeof e?.response?.statusText === "string" ? e.response.statusText : undefined;
  return { message, name, stack, status, statusText };
}

// Jupiter Pro dynamic import (Pro-only; Lite is disabled to keep behavior consistent & cheap)
let _jupPro: null | Promise<typeof import("@/lib/jupiter-pro")> = null;
async function jupPro() {
  _jupPro = _jupPro || import("@/lib/jupiter-pro");
  return _jupPro;
}

const NATIVE_SOL = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// --- Quote memoization (per-request TTL) ------------------------------------
// Reduce duplicate Jupiter quote calls during retry loops.
// Safe: if _quoteMemo misses or errors, we just fall back to calling quoteFn.
// NOTE: This _quoteMemo is process-local and time-bounded; it does NOT change swap semantics.
const _QUOTE_TTL_MS = 2500;
const _quoteMemo = new Map<string, { ts: number; v: any }>();

// Hard cap to prevent unbounded growth (process-local). Default 2000 entries.
const _QUOTE_MAX_ENTRIES = Math.max(
  128,
  Number(process.env.MOJOMAXI_QUOTE_MEMO_MAX_ENTRIES || 2000) || 2000
);



function _planMemoTag(plan: any): string {
  // Only include fields that affect quoting; avoid JSON.stringify hot path under concurrency.
  const slip = plan?.slippageBps ?? "";
  const direct = plan?.onlyDirectRoutes ? "1" : "";
  const onlyDexes = plan?.onlyDexes ?? "";
  const ex = plan?.excludeDexes;
  const excludeDexes = Array.isArray(ex) ? ex.join(",") : (ex ?? "");
  return ["s=" + slip, "d=" + direct, "od=" + onlyDexes, "xd=" + excludeDexes].join(";");
}

function _quoteKeyPrefix(args: any): string {
  const inputMint = args?.inputMint ?? "";
  const outputMint = args?.outputMint ?? "";
  const amount = args?.amount ?? "";
  const swapMode = args?.swapMode ?? "";
  const feeBps = args?.platformFeeBps ?? "";
  const asUser = args?.asUser ?? "";
  return `in=${inputMint}|out=${outputMint}|amt=${amount}|mode=${swapMode}|fee=${feeBps}|u=${asUser}`;
}

function _quoteMemoKey(args: any, planTag: string, prefix: string): string {
  // prefix should already include stable fields (mints, amount, swapMode, fee, user tag).
  // Only append fields that vary during retry loops.
  const slip = args?.slippageBps ?? "";
  const maxA = args?.maxAccounts ?? "";
  return `${prefix}|slip=${slip}|maxA=${maxA}|plan=${planTag}`;
}

async function memoJupQuote(
  quoteFn: (args: any, plan?: any) => Promise<any>,
  args: any,
  plan?: any
): Promise<any> {
  const planTag = _planMemoTag(plan);
  const prefix = _quoteKeyPrefix(args);
  const k = _quoteMemoKey(args, planTag, prefix);
  const now = Date.now();
  const hit = _quoteMemo.get(k);
  if (hit && now - hit.ts <= _QUOTE_TTL_MS) return hit.v;
  const v = await quoteFn(args, plan);
  _quoteMemo.set(k, { ts: now, v });
  // Prune occasionally to keep memory bounded.
  if (_quoteMemo.size > _QUOTE_MAX_ENTRIES) {
    const target = Math.floor(_QUOTE_MAX_ENTRIES * 0.85);
    let n = _quoteMemo.size - target;
    for (const key of _quoteMemo.keys()) {
      _quoteMemo.delete(key);
      if (--n <= 0) break;
    }
  }
  return v;
}
// ---------------------------------------------------------------------------
// When SOL/USDC swaps hit niche AMM edge-cases (e.g. Meteora DLMM bitmap extension),
// fall back to a strict, battle-tested set of venues for core pairs.
const CORE_PAIR_ONLY_DEXES = ["Orca Whirlpool", "Raydium CLMM", "Raydium CPMM"];

const CORE_PAIR_ONLY_DEXES_CSV = CORE_PAIR_ONLY_DEXES.join(",");
function isCorePair(aMint: PublicKey, bMint: PublicKey): boolean {
  const a = aMint.toBase58();
  const b = bMint.toBase58();
  return (a === NATIVE_SOL && b === USDC_MINT) || (a === USDC_MINT && b === NATIVE_SOL);
}


function isSolInvolved(a: PublicKey, b: PublicKey): boolean {
  return a.toBase58() === NATIVE_SOL || b.toBase58() === NATIVE_SOL;
}

const DEFAULT_EXCLUDE_DEXES = (process.env.JUP_EXCLUDE_DEXES ||
  "OpenBook,Phoenix,Serum,Lifinity V2,SolFi V2,TesseraV,GoonFi")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .join(",");

const ONLY_DEXES = (process.env.JUP_ONLY_DEXES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);


const HAS_ONLY_DEXES = ONLY_DEXES.length > 0;
const ONLY_DEXES_CSV = ONLY_DEXES.join(",");
const EXCLUSION_PROFILES: string[] = [
  DEFAULT_EXCLUDE_DEXES,
  DEFAULT_EXCLUDE_DEXES + ",Phoenix v1,Serum v3,OpenBook v2",
  DEFAULT_EXCLUDE_DEXES + ",GooseFX",
];

// Memoize parsing of comma-separated dex label lists to reduce per-attempt allocations.
// Safe because inputs are deterministic strings and callers treat returned arrays as read-only.
const _splitDexesMemo = new Map<string, string[]>();
const _SPLIT_DEXES_MEMO_MAX = Number(process.env.MOJOMAXI_SPLIT_DEXES_MEMO_MAX || 256);

function splitDexesCsv(csv: string): string[] {
  const key = (csv || "").trim();
  if (!key) return [];
  const hit = _splitDexesMemo.get(key);
  // Frozen arrays: downstream code cannot mutate our cached arrays.
  // Object.freeze is zero-cost after the first call and avoids .slice() allocation on every hit.
  if (hit) return hit;

  const arr = key
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Simple bounded cache: evict oldest entry when full.
  if (_splitDexesMemo.size >= Math.max(8, _SPLIT_DEXES_MEMO_MAX)) {
    const first = _splitDexesMemo.keys().next().value;
    if (first) _splitDexesMemo.delete(first);
  }
  Object.freeze(arr);
  _splitDexesMemo.set(key, arr);
  return arr;
}



// Program ID guard — let ops exclude specific route programs (e.g. Meteora LB-CLMM)
const DEFAULT_EXCLUDE_PROGRAM_IDS = (process.env.JUP_EXCLUDE_PROGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function shouldRejectRouteProgram(programIdStr: string, extra: string[] = []): boolean {
  const p = String(programIdStr || "").trim();
  if (!p) return false;

  if (DEFAULT_EXCLUDE_PROGRAM_IDS_SET.has(p)) return true;

  if (!extra || extra.length === 0) return false;
  for (const s of extra) {
    if (String(s || "").trim() === p) return true;
  }
  return false;
}
// Convenience labels we commonly want to exclude when a route keeps hitting Meteora InvalidInput.
const METEORA_LABEL_SYNONYMS = ["Meteora", "Meteora DLMM", "Meteora (DLMM)"];
const METEORA_LB_CLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

function redactUrlHost(u: string): string {
  try {
    const url = new URL(u);
    return url.host || u;
  } catch {
    return u;
  }
}
function hasJitoHost(u: string): boolean {
  const x = (u || "").toLowerCase();
  return x.includes("jito");
}
function makeDebugId(prefix = "swap"): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}_${r}`;
}

function getProgramId(): PublicKey {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID as string) ||
    (process.env.VAULT_PROGRAM_ID as string) ||
    "2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp";
  return new PublicKey(raw);
}

function getConnection(): Connection {
  const url =
    (process.env.HELIUS_RPC_URL as string) ||
    (process.env.SOLANA_MAINNET_RPC as string) ||
    (process.env.SOLANA_RPC_URL as string) ||
    (process.env.NEXT_PUBLIC_RPC_URL as string) ||
    "";
  if (!url) throw new Error("SOLANA_RPC_URL not set");
  let headers: Record<string, string> | undefined;
  const h = process.env.SOLANA_RPC_HEADERS;
  if (h) {
    try {
      headers = JSON.parse(h) as Record<string, string>;
    } catch {}
  }
  return new Connection(url, { commitment: "processed", httpHeaders: headers });
}

function loadRelayer(): Keypair {
  const s = process.env.RELAYER_SECRET || process.env.ADMIN_RELAYER_SECRET || "";
  if (!s) throw new Error("missing RELAYER_SECRET/ADMIN_RELAYER_SECRET");
  try {
    if (s.startsWith("[")) {
      const arr = JSON.parse(s);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(s));
  } catch (e: any) {
    throw new Error(`invalid_relayer_secret:${e?.message || String(e)}`);
  }
}

function assertRelayerMatchesEnv(relayerPk58: string) {
  const expected = (
    process.env.EXPECT_RELAYER_PUBKEY ||
    process.env.NEXT_PUBLIC_EXPECT_RELAYER_PUBKEY ||
    ""
  ).trim();
  if (expected && expected !== relayerPk58) {
    throw new Error(`relayer_pubkey_mismatch: expected ${expected} got ${relayerPk58}`);
  }
}

// ---------- Set ID helpers ----------
function setIdTo16BytesFlexible(setId: string, kind?: string): Uint8Array {
  const k = String(kind || "webhook").toLowerCase();
  const raw = String(setId || "").replace(/-/g, "");

  if (k === "webhook") {
    const hex = raw.toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("invalid_set_id:must_be_32_hex");
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }

  if (/^[0-9a-fA-F]{16,32}$/.test(raw)) {
    const hex = raw.slice(0, 32).padEnd(32, "0");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  const enc = new TextEncoder().encode(String(setId || "mm"));
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = enc[i % enc.length] ^ ((i * 131) & 0xff);
  return out;
}

// ---------- Token helpers ----------

// Token program detection cache (process-local, TTL).
// detectTokenProgramForMint() can be called on every swap; caching saves an RPC roundtrip per mint under load.
// Safe: if cache misses or errors, we fall back to classic token program.
// P0: Bounded to prevent unbounded growth between cold starts.
const _mintProgCache = new Map<string, { v: PublicKey; t: number }>();
const _MINT_PROG_CACHE_MAX = Math.max(
  64,
  Number(process.env.MOJOMAXI_MINT_PROG_CACHE_MAX || 512) || 512
);
const _MINT_PROG_CACHE_TTL_MS = Math.max(
  5_000,
  Number(process.env.MOJOMAXI_MINT_PROG_CACHE_TTL_MS || 5 * 60_000) || 5 * 60_000
);

const DEFAULT_EXCLUDE_PROGRAM_IDS_SET = new Set(DEFAULT_EXCLUDE_PROGRAM_IDS);

async function detectTokenProgramForMint(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const k = mint.toBase58();
  const now = Date.now();
  const hit = _mintProgCache.get(k);
  if (hit && now - hit.t >= 0 && now - hit.t <= _MINT_PROG_CACHE_TTL_MS) return hit.v;

  try {
    const ai = await conn.getAccountInfo(mint, "processed");
    const owner = ai?.owner;
    let v = TOKEN_PROGRAM_CLASSIC;
    if (owner && owner.equals(TOKEN_PROGRAM_CLASSIC)) v = TOKEN_PROGRAM_CLASSIC;
    else if (owner && owner.equals(TOKEN_2022_PROGRAM_ID)) v = TOKEN_2022_PROGRAM_ID;
    _mintProgCache.set(k, { v, t: now });
    // P0: Evict oldest entries when cache exceeds cap
    if (_mintProgCache.size > _MINT_PROG_CACHE_MAX) {
      const target = Math.floor(_MINT_PROG_CACHE_MAX * 0.85);
      let n = _mintProgCache.size - target;
      for (const key of _mintProgCache.keys()) { _mintProgCache.delete(key); if (--n <= 0) break; }
    }
    return v;
  } catch {
    // Cache the conservative default briefly to avoid hammering RPC on repeated failures.
    _mintProgCache.set(k, { v: TOKEN_PROGRAM_CLASSIC, t: now });
    return TOKEN_PROGRAM_CLASSIC;
  }
}
function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
}
async function safeTokenBal(conn: Connection, ata: PublicKey) {
  try {
    const r = await conn.getTokenAccountBalance(ata, "processed");
    return r?.value || null;
  } catch {
    return null;
  }
}
function calcMinOut(q: any, sBps: number): bigint {
  try {
    if (q && q.otherAmountThreshold != null) {
      const v = BigInt(String(q.otherAmountThreshold));
      return v > 0n ? v : 1n;
    }
    if (q && q.outAmountWithSlippage != null) {
      const v = BigInt(String(q.outAmountWithSlippage));
      return v > 0n ? v : 1n;
    }
    if (q && q.outAmount != null) {
      const out = BigInt(String(q.outAmount));
      const denom = 10_000n;
      const bps = BigInt(Math.max(0, Math.min(10_000, sBps)));
      const v = (out * (denom - bps)) / denom;
      return v > 0n ? v : 1n;
    }
  } catch {}
  return 1n;
}

function getQuotePlatformFeeBps(q: any): number {
  try {
    const v =
      (q as any)?.platformFeeBps ??
      (q as any)?.platformFee?.bps ??
      (q as any)?.platformFee?.platformFeeBps ??
      (q as any)?.feeBps ??
      0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}


type VaultOnChain = { treasury: PublicKey; paused: boolean };
async function readVaultState(conn: Connection, vaultPk: PublicKey): Promise<VaultOnChain | null> {
  const info = await conn.getAccountInfo(vaultPk, "processed");
  const data = info?.data;
  if (!data || data.length < 8 + 32 + 16 + 32 + 2 + 1 + 1 + 1 + 8) return null;
  const dv = Buffer.from(data);
  const treasury = new PublicKey(dv.subarray(8 + 32 + 16, 8 + 32 + 16 + 32));
  const pausedByte = dv[8 + 32 + 16 + 32 + 2];
  return { treasury, paused: pausedByte === 1 };
}

type AttemptCfg = { label: string; slippageBpsAdd: number; directOnly: boolean };
const ATTEMPTS: AttemptCfg[] = [
  { label: "multi-hop (ledger)",         slippageBpsAdd: 0 * STEP_SLIPPAGE_BPS, directOnly: false },
  { label: "multi-hop (re-quote)",       slippageBpsAdd: 1 * STEP_SLIPPAGE_BPS, directOnly: false },
  { label: "single-hop (direct, ledg.)", slippageBpsAdd: 2 * STEP_SLIPPAGE_BPS, directOnly: true  },
  { label: "single-hop (direct, re-q.)", slippageBpsAdd: 3 * STEP_SLIPPAGE_BPS, directOnly: true  },
];

// Account budgets for Jupiter instruction packing.
// Some Token-2022 routes (and changing Jupiter routes) can exceed the v0 tx size limit.
// We adapt per-attempt by stepping down maxAccounts.
const PAS_ACCOUNT_BUDGET_BASE = Number.isFinite(Number(process.env.PAS_ACCOUNT_BUDGET))
  ? Number(process.env.PAS_ACCOUNT_BUDGET)
  : 49; // 15 fixed vault accounts + 49 Jup accounts <= 64
const EC_ACCOUNT_BUDGET_BASE = Number.isFinite(Number(process.env.EC_ACCOUNT_BUDGET))
  ? Number(process.env.EC_ACCOUNT_BUDGET)
  : 47; // 17 fixed EC-PDA accounts + 47 Jup accounts <= 64

const ACCOUNT_BUDGET_STEP = Number.isFinite(Number(process.env.JUP_MAX_ACCOUNTS_STEP))
  ? Number(process.env.JUP_MAX_ACCOUNTS_STEP)
  : 12; // step down more aggressively to avoid tx-size overruns (49→41→33→25)
const ACCOUNT_BUDGET_MIN = Number.isFinite(Number(process.env.JUP_MAX_ACCOUNTS_MIN))
  ? Number(process.env.JUP_MAX_ACCOUNTS_MIN)
  : 20;

function maxAccountsForAttempt(base: number, attemptIdx1: number): number {
  const idx = Math.max(1, Math.floor(attemptIdx1));
  const step = Math.max(1, Math.floor(ACCOUNT_BUDGET_STEP));
  const min = Math.max(8, Math.floor(ACCOUNT_BUDGET_MIN));
  const v = base - step * (idx - 1);
  return Math.max(min, v);
}

function isEncodingOverrunErr(e: any): boolean {
  const msg = String(e?.message || e || "");
  return msg.includes("encoding overruns Uint8Array");
}


function isMeteoraBitmapExtensionMissing(simValue: any, sendErrMsg: string): boolean {
  try {
    const msg = String(sendErrMsg || "").toLowerCase();
    const logs: string[] = Array.isArray(simValue?.logs) ? simValue.logs : [];
    const logsJoined = logs.join("\n").toLowerCase();

    // Meteora DLMM / LB-CLMM often emits this AnchorError when a required bitmap extension account
    // is missing from the Jupiter-provided remaining accounts (usually due to account budgeting/packing).
    const mentionsBitmap =
      msg.includes("bitmapextensionaccountisnotprovided") ||
      msg.includes("bitmap extension account is not provided") ||
      logsJoined.includes("bitmapextensionaccountisnotprovided") ||
      logsJoined.includes("bitmap extension account is not provided");

    if (!mentionsBitmap) return false;

    const mentionsMeteoraProgram =
      msg.includes(METEORA_LB_CLMM_PROGRAM_ID.toLowerCase()) ||
      logsJoined.includes(METEORA_LB_CLMM_PROGRAM_ID.toLowerCase());

    // Sometimes the error comes through only as a Custom(6036) without the string in the send error.
    const err = simValue?.err;
    const isCustom6036 =
      (Array.isArray(err?.InstructionError) &&
        err.InstructionError?.[1]?.Custom === 6036) ||
      (Array.isArray(err?.InstructionError) &&
        typeof err.InstructionError?.[1] === "object" &&
        err.InstructionError?.[1] &&
        Number((err.InstructionError?.[1] as any).Custom) === 6036);

    return mentionsMeteoraProgram || isCustom6036;
  } catch {
    return false;
  }
}

export type ExecSwapCpiOk =
  | {
      ok: true;
      txPreview: "sent";
      signature: string;
      slot?: number;
      quote: any;
      outVaultAta: string;
      diag?: any;
    }
  | {
      ok: true;
      txPreview: "pre_sim_ok";
      quote: any;
      outVaultAta: string;
      build?: any;
      diag?: any;
    };
export type ExecSwapCpiErr = { ok: false; error: "swap_failed"; detail: string; diag: any };
export type ExecSwapCpiResult = ExecSwapCpiOk | ExecSwapCpiErr;

// ---------- Main entrypoint ----------
async function executeSwapCPI(args: {
  ownerPubkey: string;
  setId: string;
  inputMint: string;
  outputMint: string;
  amountInAtoms: string;
  slippageBps?: number;
  setKind?: "webhook" | "rebalance" | string;
}): Promise<ExecSwapCpiResult> {
  const debugId = makeDebugId("swap");
  const diag: any = { debugId, stage: "begin", input: args, attempts: [] as any[] };

  try {
    const { ownerPubkey, setId, inputMint, outputMint, amountInAtoms } = args || {};
    const slippageBps = args.slippageBps;
    const owner = new PublicKey(ownerPubkey);
    const inMint = new PublicKey(inputMint);
    const outMint = new PublicKey(outputMint);
    const amountIn = BigInt(String(amountInAtoms));
    if (inMint.equals(outMint)) throw new Error("invalid_mint_pair:same_in_out");

    const programId = getProgramId();

    const setIdBytes = setIdTo16BytesFlexible(setId, (args as any)?.setKind ?? "webhook");
    const vault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), Buffer.from(setIdBytes)],
      programId
    )[0];
    const vaultAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), vault.toBuffer()],
      programId
    )[0];
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];

    const conn = getConnection();
    
    // NOTE: quote memo is per-request; module-level TTL helpers are above.
    const relayer = loadRelayer();
    const payer = relayer.publicKey;
    assertRelayerMatchesEnv(payer.toBase58());
    diag.relayer = payer.toBase58();
    diag.payer = payer.toBase58();
    diag.config = config.toBase58();

    const vaultState = await readVaultState(conn, vault);
    if (vaultState?.paused) throw new Error("vault_is_paused");

    // Optimization: parallelize independent RPC calls (no dependency between in/out mint lookups)
    const [inProgram, outProgram] = await Promise.all([
      detectTokenProgramForMint(conn, inMint),
      detectTokenProgramForMint(conn, outMint),
    ]);
    diag.tokenPrograms = { src: inProgram.toBase58(), dst: outProgram.toBase58() };

    // Jupiter "token ledger" feature can add extra accounts/instructions.
    // For Token-2022 mints, this can push v0 txs over the packet size limit.
    // Default: enable token-ledger only when BOTH sides are classic SPL Tokenkeg.
    const _preferTokenLedger =
      String(process.env.JUP_USE_TOKEN_LEDGER || "true").toLowerCase() === "true";
    const tokenLedgerOk =
      _preferTokenLedger &&
      inProgram.equals(TOKEN_PROGRAM_CLASSIC) &&
      outProgram.equals(TOKEN_PROGRAM_CLASSIC);


    const inAuthAta = deriveAta(vaultAuthority, inMint, inProgram);
    const outAuthAta = deriveAta(vaultAuthority, outMint, outProgram);
    const treasuryOwner = new PublicKey(getTreasuryWalletAddressStrict());
    const treasuryAta = deriveAta(treasuryOwner, outMint, outProgram);
    diag.atas = { in: inAuthAta.toBase58(), out: outAuthAta.toBase58(), tre: treasuryAta.toBase58() };

    // Ensure canonical ATAs
    const ensureIxs: TransactionInstruction[] = [];
    const [inInfo, outInfo, treInfo] = await conn.getMultipleAccountsInfo(
      [inAuthAta, outAuthAta, treasuryAta],
      "processed"
    );
    if (!inInfo)
      ensureIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          inAuthAta,
          vaultAuthority,
          inMint,
          inProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    if (!outInfo)
      ensureIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          outAuthAta,
          vaultAuthority,
          outMint,
          outProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    if (!treInfo)
      ensureIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          treasuryAta,
          treasuryOwner,
          outMint,
          outProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );

    // Fee + env diagnostics
    const feeMode = (process.env.FEE_COLLECTION_MODE || "platform").toLowerCase();
    const usePlatformFee = ["platform", "jup", "jupiter"].includes(feeMode);
    const platformFeeBpsEnv = Number(
      process.env.NEXT_PUBLIC_VAULT_FEE_BPS ||
        process.env.PLATFORM_FEE_BPS ||
        process.env.NEXT_PUBLIC_PLATFORM_FEE_BPS ||
        0
    );
    const platformFeeBps = Math.max(0, Math.min(1000, isFinite(platformFeeBpsEnv) ? platformFeeBpsEnv : 0));

    // IMPORTANT:
    // If we request Jupiter platform fees (platformFeeBps > 0), we MUST pass an explicit feeAccount
    // that belongs to the TREASURY wallet. Otherwise, Jupiter can default the fee account to the
    // swap "user" (vaultAuthority or EC-PDA), which makes the relayer pay rent to create ATAs on
    // those non-treasury owners.
    const feeAccount: string | null = usePlatformFee && platformFeeBps > 0 ? treasuryAta.toBase58() : null;

    const rpcUrl = (process.env.SOLANA_RPC_URL as string) || "";
    const proBase = (process.env.JUPITER_PRO_BASE as string) || "https://api.jup.ag";

    // CHEAP DEFAULTS:
    // - Jito OFF unless explicitly JITO_TIP_ENABLED="true".
    // - Jito threshold default 400 bps (4%) so it only kicks in on "I really want this" routes.
    // - Jito tip default 1_000 lamports (minimum) when enabled.
    // - Priority cap default 2,000 lamports; only applied on last attempts.
    const jitoEnabled = String(process.env.JITO_TIP_ENABLED || "").toLowerCase() === "true";
    const jitoThresh = Number(process.env.JITO_TIP_SLIPPAGE_THRESHOLD_BPS || 400) || 400;
    const jitoTipDefault = Math.max(1000, Number(process.env.JITO_TIP_LAMPORTS || 1000)) || 1000;
    const priorityCap = Number(
      process.env.JUP_AUTO_PRIORITY_CAP_LAMPORTS === undefined
        ? 2000 // cheap-but-helpful default
        : process.env.JUP_AUTO_PRIORITY_CAP_LAMPORTS
    ) || 2000;

    diag.env = {
      rpcHost: redactUrlHost(rpcUrl),
      jitoRpc: hasJitoHost(rpcUrl),
      jupProBaseHost: redactUrlHost(proBase),
      jitoTipEnabled: jitoEnabled,
      jitoTipLamports: jitoTipDefault,
      jitoTipThresholdBps: jitoThresh,
      autoPriorityCapLamports: priorityCap,
      feeMode,
      usePlatformFee,
      platformFeeBps,
      hasJupApiKey: !!process.env.JUP_API_KEY,
      programId: programId.toBase58(),
      feePolicy: "cheap_by_default_final_attempts_only",
      slippageStepBps: STEP_SLIPPAGE_BPS,
    };

    const baseSlipBps = typeof slippageBps === "number" ? slippageBps : 100;

    // ---------- Phase 1: PAS-only path ----------
    const connRef = conn;

    async function oneAttempt(idx: number, cfg: AttemptCfg): Promise<ExecSwapCpiResult> {
      const isLastAttempt = idx === ATTEMPTS.length;
      const attemptDiag: any = { idx, plan: cfg.label, stage: "build_pack_strict" };
      
      // Per-attempt Jupiter client reuse (reduces await/promise churn under concurrency)
// IMPORTANT: do NOT recurse; cache the imported Jupiter module for this attempt.
let _jupProMod: any | null = null;
const getJupPro = async () => (_jupProMod ??= await jupPro());
diag.currentAttempt = idx;
      const useSlippage = Math.max(0, Math.min(5000, baseSlipBps + cfg.slippageBpsAdd));
      attemptDiag.useSlippage = useSlippage;
      attemptDiag.maxAccounts = maxAccountsForAttempt(PAS_ACCOUNT_BUDGET_BASE, idx);
      let quote: any = null;
      let pack: any = null;
      let quoteProvider: "pro" | null = null;
      let packProvider: "pro" | null = null;
      let lutsLoaded: AddressLookupTableAccount[] = [];

      const profiles = EXCLUSION_PROFILES;
      for (let pIdx = 0; pIdx < profiles.length; pIdx++) {
        const excludeDexes = profiles[pIdx];
        attemptDiag.excludeDexes = excludeDexes;
        const plan: any = cfg.directOnly
          ? { slippageBps: useSlippage, onlyDirectRoutes: true, excludeDexes: splitDexesCsv(excludeDexes) }
          : { slippageBps: useSlippage, excludeDexes };
        if (HAS_ONLY_DEXES) plan.onlyDexes = ONLY_DEXES_CSV;

        // Quote — Pro only (Lite disabled for consistency & cost control)
        try {
          const { jupProQuote } = await getJupPro();
          const quoteArgs: any = {
            inputMint: inMint.toBase58(),
            outputMint: outMint.toBase58(),
            amount: String(amountIn),
            slippageBps: useSlippage,
            maxAccounts: maxAccountsForAttempt(PAS_ACCOUNT_BUDGET_BASE, idx),
            ...(feeAccount ? { platformFeeBps } : {}),
          };
          quote = await memoJupQuote(jupProQuote, quoteArgs, plan);

          // Guard: if we set feeAccount, ensure the quote actually contains a platform fee.
          // Under hot-reload / process-local memoization, it's possible to hit a cached quote without fees.
          if (feeAccount && platformFeeBps > 0) {
            const qFee = Number((quote as any)?.platformFeeBps ?? (quote as any)?.platformFee?.bps ?? 0);
            if (!(qFee > 0)) {
              attemptDiag.quoteFeeMissing = true;
              quote = await jupProQuote({ ...quoteArgs, platformFeeBps }, plan);
            }
          }

          quoteProvider = "pro";
        } catch (e: any) {
          const ed = toErrDiag(e);
          attemptDiag.quoteProErr = ed.message;
          if (ed.name) attemptDiag.quoteProErrName = ed.name;
          if (ed.status) attemptDiag.quoteProErrStatus = ed.status;
          if (ed.statusText) attemptDiag.quoteProErrStatusText = ed.statusText;
          if (ed.stack) attemptDiag.quoteProErrStack = ed.stack;
          quote = null;
          continue; // try next exclusion profile
        }

        // Build PRO pack (fixed slippage; Jito/priority policy if enabled)
        try {
          const { jupProSwapInstructions } = await getJupPro();
          const optsBase: any = {
            destinationTokenAccount: outAuthAta.toBase58(),
            useSharedAccounts: !isSolInvolved(inMint, outMint),
            // For SOL/WSOL routes, disable token-ledger in PAS attempts to avoid signer-requiring packs.
            useTokenLedger: isSolInvolved(inMint, outMint) ? false : tokenLedgerOk,
            wrapAndUnwrapSol: false, // PDA custody only
            dynamicComputeUnitLimit: true,
            maxAccounts: maxAccountsForAttempt(PAS_ACCOUNT_BUDGET_BASE, idx),
          };
          const _qFeeBps = feeAccount ? getQuotePlatformFeeBps(quote) : 0;
          if (feeAccount && _qFeeBps > 0) optsBase.feeAccount = feeAccount;
          // Priority strategy (PAS path):
          // - Jito tip (if enabled) only on the final attempt and only when slippage is already high enough.
          // - Auto priority fees (no tip) on the last TWO attempts to improve landing during congestion/volatility,
          //   while still keeping earlier attempts "cheap by default".
          const isPriorityWindow = idx >= Math.max(1, ATTEMPTS.length - 1); // 1-based idx
          // NOTE: Do NOT gate priority on tokenLedgerOk. Token-2022 routes can still benefit from priority fees.
          const applyJito = isLastAttempt && jitoEnabled && useSlippage >= jitoThresh;
          const usePriorityCap = !applyJito && isPriorityWindow && priorityCap > 0;

          // Small "nudge" on PAS attempt #1 to improve landing odds (cheaper than falling into EC-PDA).
          const useEarlyPriority =
            PAS_ENABLE_EARLY_PRIORITY && idx === 1 && !applyJito && priorityCap > 0 && PAS_EARLY_PRIORITY_CAP_LAMPORTS > 0;

          if (applyJito) {
            optsBase.prioritizationFeeLamports = { jitoTipLamports: jitoTipDefault };
            attemptDiag.jitoTip = jitoTipDefault;
          } else if (usePriorityCap) {
            optsBase.prioritizationFeeLamports = {
              priorityLevelWithMaxLamports: {
                maxLamports: priorityCap,
                global: false,
                priorityLevel: "high",
              },
            };
            attemptDiag.autoPriorityCap = priorityCap;
          } else if (useEarlyPriority) {
            const cap = Math.min(priorityCap, PAS_EARLY_PRIORITY_CAP_LAMPORTS);
            optsBase.prioritizationFeeLamports = {
              priorityLevelWithMaxLamports: {
                maxLamports: cap,
                global: false,
                priorityLevel: "high",
              },
            };
            attemptDiag.earlyPriorityCap = cap;
          }

          const proPack = await jupProSwapInstructions(quote, vaultAuthority.toBase58(), optsBase);
          pack = proPack;
          packProvider = "pro";
        } catch (e: any) {
          attemptDiag.packProErr = String(e?.message || e);
          pack = null;
        }

        if (!pack || !pack.swapInstruction) continue;

        // PAS guard: VA must not be required as signer
        const routeIx = (pack as any).swapInstruction;
        const routeProgramId = String((routeIx as any)?.programId || "");
        if (shouldRejectRouteProgram(routeProgramId)) {
          attemptDiag.routeProgramRejected = routeProgramId;
          pack = null;
          quote = null;
          continue;
        }
        const routeAccts = (routeIx?.accounts ?? []) as any[];
        const vaB58 = vaultAuthority.toBase58();
        const vaSignerWanted = routeAccts.some(
          (a: any) =>
            a?.isSigner === true &&
            ((typeof a?.pubkey === "string" ? a.pubkey : String(a?.pubkey)) === vaB58)
        );
        if (vaSignerWanted) {
          attemptDiag.vaSignerDetected = true;
          try {
            const { jupProSwapInstructions } = await getJupPro();
            const optsRetry: any = {
              destinationTokenAccount: outAuthAta.toBase58(),
              useSharedAccounts: !isSolInvolved(inMint, outMint),
              useTokenLedger: isSolInvolved(inMint, outMint) ? false : tokenLedgerOk,
              wrapAndUnwrapSol: false,
              dynamicComputeUnitLimit: true,
              maxAccounts: maxAccountsForAttempt(EC_ACCOUNT_BUDGET_BASE, 1),
            };
            const _qFeeBpsRetry = feeAccount ? getQuotePlatformFeeBps(quote) : 0;
            if (feeAccount && _qFeeBpsRetry > 0) optsRetry.feeAccount = feeAccount;
            const applyJitoRetry = isLastAttempt && jitoEnabled && useSlippage >= jitoThresh;
            const usePriorityCapRetry = !applyJitoRetry && isLastAttempt && priorityCap > 0;

            if (applyJitoRetry) {
              optsRetry.prioritizationFeeLamports = { jitoTipLamports: jitoTipDefault };
              attemptDiag.jitoTip = jitoTipDefault;
            } else if (usePriorityCapRetry) {
              optsRetry.prioritizationFeeLamports = {
                priorityLevelWithMaxLamports: {
                  maxLamports: priorityCap,
                  global: false,
                  priorityLevel: "high",
                },
              };
              attemptDiag.autoPriorityCap = priorityCap;
            }

            const proPack2 = await jupProSwapInstructions(quote, vaultAuthority.toBase58(), optsRetry);
            const wants2 = (proPack2?.swapInstruction?.accounts ?? []).some(
              (a: any) =>
                a?.isSigner === true &&
                ((typeof a?.pubkey === "string" ? a.pubkey : String(a?.pubkey)) === vaB58)
            );
            if (!wants2) {
              pack = proPack2;
              packProvider = "pro";
              attemptDiag.packProviderRetry = "pro";
              break;
            }
            attemptDiag.vaSignerDetectedRetry = true;

            // If the pack still wants the vaultAuthority as a signer, try a fresh *direct-only* re-quote
            // with a tighter maxAccounts budget. This often avoids VA-signer routes and keeps us on PAS.
            try {
              const { jupProQuote, jupProSwapInstructions } = await getJupPro();
	        const quote2 = await memoJupQuote(
	          jupProQuote,
	          {
	            inputMint: inMint.toBase58(),
	            outputMint: outMint.toBase58(),
	            amount: String(amountIn),
	            slippageBps: useSlippage,
	            allowOptimizedRoutes: true,
	            maxAccounts: maxAccountsForAttempt(PAS_ACCOUNT_BUDGET_BASE, idx),
	            ...(feeAccount ? { platformFeeBps } : {}),
	          } as any,
	          plan
	        );

              const optsDirect: any = {
                destinationTokenAccount: outAuthAta.toBase58(),
                useSharedAccounts: !isSolInvolved(inMint, outMint),
                useTokenLedger: false, // keep simpler
                wrapAndUnwrapSol: false,
                dynamicComputeUnitLimit: true,
                maxAccounts: maxAccountsForAttempt(PAS_ACCOUNT_BUDGET_BASE, idx + 1),
              };
              const _qFeeBpsDirect = feeAccount ? getQuotePlatformFeeBps(quote2) : 0;
              if (feeAccount && _qFeeBpsDirect > 0) optsDirect.feeAccount = feeAccount;
              // Apply the same priority policy on the direct-only retry.
              const applyJito3 = isLastAttempt && jitoEnabled && useSlippage >= jitoThresh;
              const usePriorityCap3 = !applyJito3 && idx >= Math.max(1, ATTEMPTS.length - 1) && priorityCap > 0;
              const useEarlyPriority3 =
                PAS_ENABLE_EARLY_PRIORITY && idx === 1 && !applyJito3 && priorityCap > 0 && PAS_EARLY_PRIORITY_CAP_LAMPORTS > 0;
              if (applyJito3) {
                optsDirect.prioritizationFeeLamports = { jitoTipLamports: jitoTipDefault };
                attemptDiag.jitoTip = jitoTipDefault;
              } else if (usePriorityCap3) {
                optsDirect.prioritizationFeeLamports = {
                  priorityLevelWithMaxLamports: { maxLamports: priorityCap, global: false, priorityLevel: "high" },
                };
                attemptDiag.autoPriorityCap = priorityCap;
              } else if (useEarlyPriority3) {
                const cap = Math.min(priorityCap, PAS_EARLY_PRIORITY_CAP_LAMPORTS);
                optsDirect.prioritizationFeeLamports = {
                  priorityLevelWithMaxLamports: { maxLamports: cap, global: false, priorityLevel: "high" },
                };
                attemptDiag.earlyPriorityCap = cap;
              }

              const pack3 = await jupProSwapInstructions(quote2, vaultAuthority.toBase58(), optsDirect);
              const wants3 = (pack3?.swapInstruction?.accounts ?? []).some(
                (a: any) =>
                  a?.isSigner === true &&
                  ((typeof a?.pubkey === "string" ? a.pubkey : String(a?.pubkey)) === vaB58)
              );
              if (pack3?.swapInstruction && !wants3) {
                quote = quote2;
                pack = pack3;
                packProvider = "pro";
                attemptDiag.vaSignerDirectRetryOk = true;
                break;
              }
              attemptDiag.vaSignerDirectRetryStill = true;
            } catch (e: any) {
              attemptDiag.vaSignerDirectRetryErr = String(e?.message || e);
            }
          } catch {}
          pack = null;
          quote = null;
          continue;
        }

        attemptDiag.quoteProvider = quoteProvider;
        attemptDiag.packProvider = packProvider;

        break;
      }

      if (!pack || !pack.swapInstruction || !quote) {
        attemptDiag.stage = "build_pack_strict_failed";
        diag.attempts.push(attemptDiag);
        throw new Error("jupiter_pack_requires_user_signer");
      }

      // Pre-sim for desired_in=0 -> rebuild PAS without token-ledger (with the same fee/Jito policy)
      lutsLoaded = await loadLuts(connRef, (pack as any).addressLookupTableAddresses || []);
      const bhPre = await connRef.getLatestBlockhash("processed");

      const precheck = await preSimPackPas({
                conn: connRef,
                blockhash: bhPre.blockhash,
                payer,
                relayer,
                pack,
                ensureIxs,
                programId,
                vault,
                vaultAuthority,
                config,
                inMint,
                outMint,
                inProgram,
                outProgram,
                inAuthAta,
                outAuthAta,
                treasuryAta,
      treasuryOwner,
                quote,
                amountIn,
                useSlippage,
                luts: lutsLoaded,
              });

              if (precheck.needsNoLedger) {
                attemptDiag.detectedDesiredInZero = true;
                try {
                  const { jupProSwapInstructions } = await getJupPro();
                  const optsNoLedger: any = {
                    destinationTokenAccount: outAuthAta.toBase58(),
                    useSharedAccounts: !isSolInvolved(inMint, outMint),
                    useTokenLedger: false,
                    wrapAndUnwrapSol: false,
                    dynamicComputeUnitLimit: true,
                    maxAccounts: maxAccountsForAttempt(PAS_ACCOUNT_BUDGET_BASE, idx),
                  };
	                  const _qFeeBpsNoLedger = feeAccount ? getQuotePlatformFeeBps(quote) : 0;
	                  if (feeAccount && _qFeeBpsNoLedger > 0) optsNoLedger.feeAccount = feeAccount;
                  const applyJitoNoLedger = isLastAttempt && jitoEnabled && useSlippage >= jitoThresh;
                  const isPriorityWindowNoLedger = idx >= Math.max(1, ATTEMPTS.length - 1);
                  const usePriorityCapNoLedger = !applyJitoNoLedger && isPriorityWindowNoLedger && priorityCap > 0;
                  const useEarlyPriorityNoLedger =
                    PAS_ENABLE_EARLY_PRIORITY && idx === 1 && !applyJitoNoLedger && priorityCap > 0 && PAS_EARLY_PRIORITY_CAP_LAMPORTS > 0;

                  if (applyJitoNoLedger) {
                    optsNoLedger.prioritizationFeeLamports = { jitoTipLamports: jitoTipDefault };
                    attemptDiag.jitoTip = jitoTipDefault;
                  } else if (usePriorityCapNoLedger) {
                    optsNoLedger.prioritizationFeeLamports = {
                      priorityLevelWithMaxLamports: {
                        maxLamports: priorityCap,
                        global: false,
                        priorityLevel: "high",
                      },
                    };
                    attemptDiag.autoPriorityCap = priorityCap;
                  } else if (useEarlyPriorityNoLedger) {
                    const cap = Math.min(priorityCap, PAS_EARLY_PRIORITY_CAP_LAMPORTS);
                    optsNoLedger.prioritizationFeeLamports = {
                      priorityLevelWithMaxLamports: {
                        maxLamports: cap,
                        global: false,
                        priorityLevel: "high",
                      },
                    };
                    attemptDiag.earlyPriorityCap = cap;
                  }

                  const packNoLedger = await jupProSwapInstructions(
                    quote,
                    vaultAuthority.toBase58(),
                    optsNoLedger
                  );
                  if (packNoLedger?.swapInstruction) {
                    pack = packNoLedger;
                    attemptDiag.packProviderNoLedger = "pro";
                  }
                } catch (e: any) {
                  attemptDiag.packNoLedgerErr = String(e?.message || e);
                }
              }

      // ---- Flatten pack and execute PAS CPI ----
      const {
        setupList,
        cleanupIx,
        routeIx,
        remainingMetas,
        tlAccsLen,
        setupAccsLens,
        routeAccsLen,
        cleanupAccsLen,
        dataRoute,
        dataTL,
        dataSetups,
        dataCleanup,
        jupProgram,
      } = decomposePack(connRef, pack);

      const [programAsSigner] = PublicKey.findProgramAddressSync(
        [Buffer.from("program_as_signer")],
        jupProgram
      );
      const minOut = calcMinOut(quote, useSlippage);
      const disc = discriminator8("execute_swap");
      const platformFeeBpsTx = Math.max(
        0,
        Math.min(100, Number(process.env.NEXT_PUBLIC_PLATFORM_FEE_BPS || platformFeeBps || 0))
      );

      const data = Buffer.concat([
        disc,
        u64LE(amountIn),
        u64LE(minOut),
        u16LE(platformFeeBpsTx),
        writeBytes(dataRoute),
        writeOptBytes(dataTL),
        writeVecBytes(dataSetups),
        writeOptBytes(dataCleanup),
        u32LE(tlAccsLen),
        writeVecU32(setupAccsLens),
        u32LE(routeAccsLen),
        u32LE(cleanupAccsLen),
      ]);

      assertAllowedJupiterProgram(new PublicKey(routeIx.programId), { stage: "buildIx" });

      const keysFixed = [
        { pubkey: payer, isWritable: true, isSigner: true },
        { pubkey: vault, isWritable: true, isSigner: false },
        { pubkey: vaultAuthority, isWritable: false, isSigner: false },
        { pubkey: inAuthAta, isWritable: true, isSigner: false },
        { pubkey: outAuthAta, isWritable: true, isSigner: false },
        { pubkey: inMint, isWritable: false, isSigner: false },
        { pubkey: outMint, isWritable: false, isSigner: false },
        { pubkey: treasuryAta, isWritable: true, isSigner: false },
        { pubkey: inProgram, isWritable: false, isSigner: false },
        { pubkey: outProgram, isWritable: false, isSigner: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: new PublicKey(routeIx.programId), isWritable: false, isSigner: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isWritable: false, isSigner: false },
        { pubkey: programAsSigner, isWritable: false, isSigner: false },
        { pubkey: config, isWritable: false, isSigner: false },
      ];

      // Compute budget ixs are deterministic; build once per attempt (PAS path).
      const _cuPriceAttempt = Number(process.env.JUP_CU_PRICE_MICROLAMPORTS || 0);
      const _cuIxsAttempt = ensureSetComputeBudgetIxs({
        cuLimit: 1_400_000,
        cuPriceMicroLamports: _cuPriceAttempt > 0 ? _cuPriceAttempt : "auto",
      });


      const buildTx = async () => {
        const ix = new TransactionInstruction({
          programId,
          keys: [...keysFixed, ...(remainingMetas ?? [])],
          data,
        });
        const instructions: TransactionInstruction[] = [];
        if (ensureIxs.length) instructions.push(...ensureIxs);
        if (_cuIxsAttempt.length) instructions.push(..._cuIxsAttempt);
        instructions.push(ix);
      const bh = await connRef.getLatestBlockhash("processed");
      const blockhash = bh.blockhash;
      const lastValidBlockHeight = bh.lastValidBlockHeight;
      // Include LUTs in the final PAS tx (pre-loaded above for this attempt)
        const msg = new TransactionMessage({
          payerKey: payer,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message(lutsLoaded);
        const tx = new VersionedTransaction(msg);
        try {
      tx.sign([relayer]);
    } catch (e: any) {
          if (isEncodingOverrunErr(e)) {
          // tx too large during pack/sim; bubble up as a typed error for retry logic
          throw new Error("tx_too_large");
        }
          throw e;
        }
        return { tx, blockhash, lastValidBlockHeight };
      };

      attemptDiag.stage = "pre_sim";
      let { tx, blockhash, lastValidBlockHeight } = await buildTx();
      const preSim = await connRef.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "processed" as any,
      });
      attemptDiag.preSim = preSim?.value ?? null;

      // If PAS pre-sim fails, do NOT send the transaction. Instead, let outer retry logic
      // (higher slippage, direct-only, tighter maxAccounts) attempt a more landable route.
      // This avoids wasting attempts and reduces the chance we fall into EC-PDA on every swap.
      if (preSim?.value?.err) {
        attemptDiag.preSimHadErr = true;
        attemptDiag.preSimSlippageExceeded = isSlippageExceeded(preSim.value);
        throw new Error(attemptDiag.preSimSlippageExceeded ? "pas_pre_sim_slippage" : "pas_pre_sim_failed");
      }

      let _raw: Buffer | Uint8Array;
      try {
        _raw = tx.serialize();
      } catch (e: any) {
        if (isEncodingOverrunErr(e)) {
        // tx too large in a scope without attemptDiag; bubble up for retry handling
        throw new Error("tx_too_large");
      }
        throw e;
      }

      const sig = await connRef.sendRawTransaction(_raw, {
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: PAS_SEND_MAX_RETRIES,
      });
      try {
        const conf = await connRef.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "processed"
        );
        const slotNum: number | undefined =
          typeof (conf as any)?.context?.slot === "number" ? (conf as any).context.slot : undefined;
        attemptDiag.result = {
          sig,
          slot: slotNum,
          routeProgram: (pack as any).swapInstruction?.programId,
        };
        diag.attempts.push(attemptDiag);
        return {
          ok: true,
          txPreview: "sent",
          signature: sig,
          slot: slotNum,
          outVaultAta: outAuthAta.toBase58(),
          quote,
          diag,
        };
      } catch {
        attemptDiag.result = {
          sig,
          routeProgram: (pack as any).swapInstruction?.programId,
        };
        diag.attempts.push(attemptDiag);
        return {
          ok: true,
          txPreview: "sent",
          signature: sig,
          outVaultAta: outAuthAta.toBase58(),
          quote,
          diag,
        };
      }
    }

    // Try PAS attempts
    let lastErr: any = null;
    // We can intelligently skip ahead when the failure class indicates a structural issue
    // (e.g., tx too large), since direct-only / tighter account budgets are more likely to land.
    let i = 0;
    while (i < ATTEMPTS.length) {
      try {
        const res = await oneAttempt(i + 1, ATTEMPTS[i]);
        if (res.ok) return res;
        lastErr = res;
        i++;
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || err || '');
        // If the transaction is too large (or encoding overruns), jump straight to direct-only attempts.
        if (msg === 'tx_too_large' || msg.includes('encoding overruns Uint8Array')) {
          i = Math.max(i + 1, 2); // jump to attempt #3 (direct-only)
          continue;
        }
        // If pre-sim failed for non-slippage reasons, the direct-only attempt is often more reliable too.
        if (msg === 'pas_pre_sim_failed') {
          i = Math.max(i + 1, 2);
          continue;
        }
        i++;
      }
    }

    // ---------- Phase 2: EC-PDA fallback ----------
    const baseEcParams = {
      args,
      diag,
      conn,
      relayer,
      programId,
      owner,
      vault,
      vaultAuthority,
      config,
      inMint,
      outMint,
      inProgram,
      outProgram,
      inAuthAta,
      outAuthAta,
      treasuryAta,
      treasuryOwner,
      amountIn,
      baseSlipBps,
      platformFeeBps,
    };

    const ecResult = await executeSwapEcPdaFallback({
      ...baseEcParams,
      extraExcludeDexes: [],
    });
    if (ecResult.ok) return ecResult;

    // Retry EC-PDA once excluding Meteora if we tripped InvalidInput in sim
    if (!ecResult.ok && (ecResult as ExecSwapCpiErr).detail === "meteora_invalid_input") {
      return await executeSwapEcPdaFallback({
        ...baseEcParams,
        extraExcludeDexes: METEORA_LABEL_SYNONYMS,
        extraExcludeProgIds: [METEORA_LB_CLMM_PROGRAM_ID],
      });
    }

    return ecResult;
  } catch (e: any) {
    return {
      ok: false,
      error: "swap_failed",
      detail: e?.message || String(e),
      diag: {
        ...diag,
        stage: "caught",
        caught: { message: e?.message || String(e), stack: e?.stack },
      },
    };
  }
}

// ---------- EC-PDA fallback using execute_swap_ec_pda ----------
async function executeSwapEcPdaFallback(params: {
  args: any;
  diag: any;
  conn: Connection;
  relayer: Keypair;
  programId: PublicKey;
  owner: PublicKey;
  vault: PublicKey;
  vaultAuthority: PublicKey;
  config: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
  inProgram: PublicKey;
  outProgram: PublicKey;
  inAuthAta: PublicKey;
  outAuthAta: PublicKey;
  treasuryAta: PublicKey;
  treasuryOwner: PublicKey;
  amountIn: bigint;
  baseSlipBps: number;
  platformFeeBps: number;
  extraExcludeDexes?: string[];
  extraExcludeProgIds?: string[];
  extraOnlyDexes?: string[];
  // Internal: force direct routes to reduce account counts (used on CPI account-limit overflow).
  forceDirectRoutes?: boolean;
  // Internal: override maxAccounts for quote to force smaller routes.
  maxAccountsOverride?: number;
  // Internal: how many times we've retried EC-PDA due to CPI account-limit overflow.
  accountBudgetRetryCount?: number;
  // Internal: how many times we've re-quoted EC-PDA due to slippage-tolerance errors (sim/send).
  reQuoteCount?: number;
	  // Internal: carry forward all remaining accounts seen across recursive EC-PDA retries.
	  seenRemainingMetas?: AccountMeta[] | null;
}): Promise<ExecSwapCpiResult> {
  const {
    diag,
    conn,
    relayer,
    programId,
    vault,
    vaultAuthority,
    config,
    inMint,
    outMint,
    inProgram,
    outProgram,
    inAuthAta,
    outAuthAta,
    treasuryAta,
    treasuryOwner,
    amountIn,
    baseSlipBps,
    platformFeeBps,
    extraExcludeDexes = [],
    extraExcludeProgIds = [],
    extraOnlyDexes = [],
    forceDirectRoutes = false,
    maxAccountsOverride = undefined,
    accountBudgetRetryCount = 0,
    reQuoteCount = 0,
	    seenRemainingMetas = null,
  } = params;

  // Fee + treasury feeAccount policy (mirror PAS path)
  // If we request Jupiter platform fees (platformFeeBps > 0), we MUST pass an explicit feeAccount
  // that belongs to the TREASURY wallet. Otherwise, Jupiter can default the fee account to the
  // swap "user" (EC-PDA), which makes the relayer pay rent to create ATAs on non-treasury owners.
  const feeMode = (process.env.FEE_COLLECTION_MODE || "platform").toLowerCase();
  const usePlatformFee = ["platform", "jup", "jupiter"].includes(feeMode);
  const feeAccount: string | null = usePlatformFee && platformFeeBps > 0 ? treasuryAta.toBase58() : null;


  // Per-attempt Jupiter client reuse (EC-PDA).
  let _jupProEcMod: any | null = null;
  const getJupProEc = async () => (_jupProEcMod ??= await jupPro());

	  // --- Accumulate EC-PDA remaining accounts across retries ---
	  // Each retry can touch/create different temp token accounts/bins. If we only pass the *final*
	  // attempt's remaining accounts to `post_swap_cleanup_ec_pda`, earlier bins can be missed and
	  // their rent will not be reclaimed.
	  const _seenMeta = new Map<string, AccountMeta>();
	  const _addSeen = (metas?: AccountMeta[] | null) => {
	    for (const m of metas || []) {
	      const k = (m.pubkey as any)?.toBase58 ? (m.pubkey as any).toBase58() : String(m.pubkey);
	      const prev = _seenMeta.get(k);
	      if (!prev) {
	        _seenMeta.set(k, { pubkey: m.pubkey, isSigner: false, isWritable: !!m.isWritable });
	      } else if (!prev.isWritable && m.isWritable) {
	        _seenMeta.set(k, { ...prev, isWritable: true });
	      }
	    }
	  };
	  const _mergedSeen = () => Array.from(_seenMeta.values());
	  _addSeen(seenRemainingMetas);

  const attemptDiag: any = {
    idx: "ec_pda",
    plan: "ec-pda fallback (swap_authority)",
    stage: "begin",
    reQuoteCount,
  };
  const payer = relayer.publicKey;

  // Continue slippage stepping from where PAS left off
  const EC_PDA_BASE_OFFSET = STEP_SLIPPAGE_BPS * ATTEMPTS.length; // e.g., 3 * 50 = +150 bps if default step
  const useSlippage = Math.max(0, Math.min(5000, baseSlipBps + EC_PDA_BASE_OFFSET));
  attemptDiag.useSlippage = useSlippage;
  const ecAttemptIdx1 = 1;
  attemptDiag.maxAccounts = maxAccountsForAttempt(EC_ACCOUNT_BUDGET_BASE, ecAttemptIdx1);
  // Env knobs (Jito/priority) mirrored here, same cheap defaults.
  const jitoEnabled = String(process.env.JITO_TIP_ENABLED || "").toLowerCase() === "true";
  const jitoThresh = Number(process.env.JITO_TIP_SLIPPAGE_THRESHOLD_BPS || 400) || 400;
  const jitoTipDefault = Math.max(1000, Number(process.env.JITO_TIP_LAMPORTS || 1000)) || 1000;
  const priorityCap = Number(
    process.env.JUP_AUTO_PRIORITY_CAP_LAMPORTS === undefined
      ? 2000
      : process.env.JUP_AUTO_PRIORITY_CAP_LAMPORTS
  ) || 2000;

  // swap_nonce: hardened
  const swapNonce = nextSwapNonce();
  const swapNonceLE = u64LE(swapNonce);
  const swapAuthSeeds = [Buffer.from("swap_authority"), vault.toBuffer(), swapNonceLE];
  const [swapAuthority] = PublicKey.findProgramAddressSync(swapAuthSeeds, programId);

  attemptDiag.swapNonce = swapNonce.toString();
  try { attemptDiag.swapAuthority = swapAuthority.toBase58(); } catch {}

  // Ephemeral ATAs
  const ephSrc = deriveAta(swapAuthority, inMint, inProgram);
  const ephDst = deriveAta(swapAuthority, outMint, outProgram);
  attemptDiag.swapAuthority = swapAuthority.toBase58();
  attemptDiag.ephemeralAtas = { src: ephSrc.toBase58(), dst: ephDst.toBase58() };

  // Ensure ephemeral ATAs
  const ensureIxs: TransactionInstruction[] = [];
  // Optimization: single batched RPC call for both ephemeral + vault/treasury ATA probes.
  // Previously two sequential getMultipleAccountsInfo calls; merging saves one RPC round-trip.
  const _batchProbeKeys: PublicKey[] = [ephSrc, ephDst, inAuthAta, outAuthAta, treasuryAta];
  const _batchProbeResults = await conn.getMultipleAccountsInfo(_batchProbeKeys, "processed");
  const srcInfo = _batchProbeResults[0];
  const dstInfo = _batchProbeResults[1];
  if (!srcInfo)
    ensureIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        ephSrc,
        swapAuthority,
        inMint,
        inProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  if (!dstInfo)
    ensureIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        ephDst,
        swapAuthority,
        outMint,
        outProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

  // Also make sure vault's src/dst ATAs and treasury ATA exist (EC-PDA previously failed on missing treasury_ata)
// Best-effort: probed in the same batch above to reduce RPC round trips under concurrency.
  try {
    const inVaultInfo = _batchProbeResults[2];
    const outVaultInfo = _batchProbeResults[3];
    const treInfo2 = _batchProbeResults[4];

    if (!inVaultInfo) {
      ensureIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          inAuthAta,
          vaultAuthority,
          inMint,
          inProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    if (!outVaultInfo) {
      ensureIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          outAuthAta,
          vaultAuthority,
          outMint,
          outProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    if (!treInfo2) {
      ensureIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          treasuryAta,
          treasuryOwner,
          outMint,
          outProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  } catch (e) {
    // best-effort; if any of these ATAs are still missing, the program will error with a clear message
  }

if (ensureIxs.length) {
    // Tag this ensure-only transaction so the debug sweeper can discover and close any bins
    // even if we crash/timeout before the swap tx is submitted.
    // Format: mojomaxi:ecpda_ensure:v1:<vault>:<swapNonce>:<swapAuthority>
    ensureIxs.push(
      memoIx(`mojomaxi:ecpda_ensure:v1:${vault.toBase58()}:${swapNonce.toString()}:${swapAuthority.toBase58()}`)
    );

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: ensureIxs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    try {
      tx.sign([relayer]);
    } catch (e: any) {
      if (isEncodingOverrunErr(e)) {
        return {
        ok: false,
        error: "swap_failed",
        detail: "tx_too_large",
        diag: {
          stage: "caught",
          attempts: [],
          message: "tx_too_large",
        },
      };
      }
      throw e;
    }
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed" as any,
    });
    attemptDiag.ensureSim = sim?.value ?? null;
    if (sim?.value?.err) {
      // Best-effort cleanup even when we fail before the send path.
      // EC-PDA may have created/used ephemeral token accounts; try to close empties to avoid stuck bins.
      try {
        await tryPostCloseEcPdaIfEmpty({
          conn,
          programId,
          relayer,
          payer,
          vault,
          vaultAuthority,
          swapAuthority,
          inMint,
          outMint,
          inProgram,
          outProgram,
          ephSrc,
          ephDst,
          config,
          swapNonce,
          inAuthAta,
          outAuthAta,
          remainingMetas: _mergedSeen(),
        });
      } catch {}
      return {
        ok: false,
        error: "swap_failed",
        detail: "ec_pda_ensure_failed",
        diag: { ...diag, stage: "caught", attempts: [...diag.attempts, attemptDiag] },
      };
    }
    let _raw: Buffer | Uint8Array;
    try {
      _raw = tx.serialize();
    } catch (e: any) {
      if (isEncodingOverrunErr(e)) {
        // tx too large in a scope without attemptDiag; bubble up for retry handling
        throw new Error("tx_too_large");
      }
      throw e;
    }

    const sig = await conn.sendRawTransaction(_raw, {
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 3,
    });
    try {
      await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "processed"
      );
    } catch {}

    // IMPORTANT: the EC-PDA swap uses fresh ephemeral ATAs. Under RPC load, `confirmTransaction`
    // can return before the account fetch path "sees" the newly created ATAs (or confirmation can
    // fail even though the tx landed). To avoid false AccountNotInitialized (3012) on the swap tx,
    // we poll until the ephemeral accounts are observable, with a tight bounded wait.
    const deadline = Date.now() + 4000; // 4s max extra latency, only when we had to create ATAs
    while (Date.now() < deadline) {
      const [a, b] = await conn.getMultipleAccountsInfo([ephSrc, ephDst], "processed");
      if (a && b) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const [a2, b2] = await conn.getMultipleAccountsInfo([ephSrc, ephDst], "processed");
    if (!a2 || !b2) {
      return {
        ok: false,
        error: "swap_failed",
        detail: "ec_pda_ensure_failed",
        diag: { ...diag, stage: "caught", attempts: [...diag.attempts, { ...attemptDiag, stage: "ensure_not_observable" }] },
      };
    }
  }

  // Quote + pack (fixed slippage / Jito/priority as needed).
  // EC-PDA is already "last resort", so we allow small priority/Jito here with the same cheap defaults.
  let quote: any = null;
  let pack: any = null;
  const profiles = EXCLUSION_PROFILES;

  for (let pIdx = 0; pIdx < profiles.length; pIdx++) {
    const profileExclude = profiles[pIdx];
    const excludeDexes = [profileExclude, ...extraExcludeDexes].filter(Boolean).join(",");
    attemptDiag.excludeDexes = excludeDexes;
    if (extraOnlyDexes && extraOnlyDexes.length) attemptDiag.onlyDexes = extraOnlyDexes.join(",");
    const plan: any = { slippageBps: useSlippage, excludeDexes: splitDexesCsv(excludeDexes) };
    if (forceDirectRoutes) plan.onlyDirectRoutes = true;
    const onlyDexesArr = extraOnlyDexes && extraOnlyDexes.length ? extraOnlyDexes : ONLY_DEXES;
    if (onlyDexesArr.length) plan.onlyDexes = onlyDexesArr.join(",");

    try {
      const { jupProQuote } = await getJupProEc();
      const quoteArgs: any = {
        inputMint: inMint.toBase58(),
        outputMint: outMint.toBase58(),
        amount: amountIn.toString(),
        slippageBps: useSlippage,
        allowOptimizedRoutes: true,
        maxAccounts: (maxAccountsOverride ?? maxAccountsForAttempt(EC_ACCOUNT_BUDGET_BASE, ecAttemptIdx1)),
        ...(feeAccount ? { platformFeeBps } : {}),
      };
      quote = await memoJupQuote(jupProQuote, quoteArgs, plan);

      // Guard: if we set feeAccount, ensure the quote actually contains a platform fee.
      if (feeAccount && platformFeeBps > 0) {
        const qFee = Number((quote as any)?.platformFeeBps ?? (quote as any)?.platformFee?.bps ?? 0);
        if (!(qFee > 0)) {
          attemptDiag.quoteFeeMissing = true;
          quote = await jupProQuote({ ...quoteArgs, platformFeeBps }, plan);
        }
      }
    } catch (e: any) {
      const ed = toErrDiag(e);
      attemptDiag.quoteProErr = ed.message;
      if (ed.name) attemptDiag.quoteProErrName = ed.name;
      if (ed.status) attemptDiag.quoteProErrStatus = ed.status;
      if (ed.statusText) attemptDiag.quoteProErrStatusText = ed.statusText;
      if (ed.stack) attemptDiag.quoteProErrStack = ed.stack;
      quote = null;
      continue;
    }

    try {
      const { jupProSwapInstructions } = await getJupProEc();
      const optsBase: any = {
        destinationTokenAccount: ephDst.toBase58(),
        useSharedAccounts: true,
        useTokenLedger: false, // EC-PDA: avoid token-ledger
        wrapAndUnwrapSol: false, // PDA custody only
        dynamicComputeUnitLimit: true,
        maxAccounts: maxAccountsForAttempt(EC_ACCOUNT_BUDGET_BASE, ecAttemptIdx1),
      };
      const _qFeeBpsEc = feeAccount ? getQuotePlatformFeeBps(quote) : 0;
      if (feeAccount && _qFeeBpsEc > 0) optsBase.feeAccount = feeAccount;
      const applyJito = jitoEnabled && useSlippage >= jitoThresh;
      const usePriorityCap = !applyJito && priorityCap > 0;

      if (applyJito) {
        optsBase.prioritizationFeeLamports = { jitoTipLamports: jitoTipDefault };
        attemptDiag.jitoTip = jitoTipDefault;
      } else if (usePriorityCap) {
        optsBase.prioritizationFeeLamports = {
          priorityLevelWithMaxLamports: {
            maxLamports: priorityCap,
            global: false,
            priorityLevel: "high",
          },
        };
        attemptDiag.autoPriorityCap = priorityCap;
      }

      const proPack = await jupProSwapInstructions(quote, swapAuthority.toBase58(), optsBase);
      if (proPack && proPack.swapInstruction) {
        const routeProgramId = String((proPack.swapInstruction as any)?.programId || "");
        if (shouldRejectRouteProgram(routeProgramId, extraExcludeProgIds)) {
          attemptDiag.routeProgramRejected = routeProgramId;
          pack = null;
          quote = null;
          continue;
        }
        pack = proPack;
        break;
      }
    } catch (e: any) {
      attemptDiag.packProErr = String(e?.message || e);
      pack = null;
    }
  }

  if (!pack || !pack.swapInstruction || !quote) {
    // === Extra EC-PDA retries (safe): bump slippage and optionally force direct routes ===
    for (let extra = 1; extra <= EC_PDA_EXTRA_RETRY_ATTEMPTS; extra++) {
      const excludeDexes2 = [EXCLUSION_PROFILES[0], ...extraExcludeDexes].filter(Boolean).join(",");
      try {
        const slipAdd = extra * EC_PDA_EXTRA_RETRY_SLIPPAGE_ADD_BPS;
        const onlyDirect = EC_PDA_LAST_TRY_DIRECT_ONLY && extra === EC_PDA_EXTRA_RETRY_ATTEMPTS;
        const nextSlip = Math.min(5000, useSlippage + slipAdd);
        const plan2: any = onlyDirect
          ? { slippageBps: nextSlip, onlyDirectRoutes: true, excludeDexes: excludeDexes2 }
          : { slippageBps: nextSlip, excludeDexes: excludeDexes2 };
        if (HAS_ONLY_DEXES) plan2.onlyDexes = ONLY_DEXES_CSV;
        attemptDiag.extraRetry = { extra, slipAdd, onlyDirect };
        const ecAttemptIdx2 = 1 + extra;
        const ma2 = maxAccountsForAttempt(EC_ACCOUNT_BUDGET_BASE, ecAttemptIdx2);
        attemptDiag.extraRetry.maxAccounts = ma2;

        const { jupProQuote } = await getJupProEc();
        const quoteArgs: any = {
          inputMint: inMint.toBase58(),
          outputMint: outMint.toBase58(),
          amount: amountIn.toString(),
          slippageBps: nextSlip,
          allowOptimizedRoutes: true,
          maxAccounts: ma2,
          ...(feeAccount ? { platformFeeBps } : {}),
        };
        quote = await memoJupQuote(jupProQuote, quoteArgs, plan2);

        // Guard: if we set feeAccount, ensure the quote actually contains a platform fee.
        if (feeAccount && platformFeeBps > 0) {
          const qFee = Number((quote as any)?.platformFeeBps ?? (quote as any)?.platformFee?.bps ?? 0);
          if (!(qFee > 0)) {
            attemptDiag.extraRetry = { ...(attemptDiag.extraRetry || {}), quoteFeeMissing: true };
            quote = await jupProQuote({ ...quoteArgs, platformFeeBps }, plan2);
          }
        }

        const { jupProSwapInstructions } = await getJupProEc();
        const opts2: any = {
          destinationTokenAccount: ephDst.toBase58(),
          useSharedAccounts: true,
          useTokenLedger: false,
          wrapAndUnwrapSol: false,
          dynamicComputeUnitLimit: true,
          maxAccounts: ma2,
        };
        const _qFeeBpsEc2 = feeAccount ? getQuotePlatformFeeBps(quote) : 0;
        if (feeAccount && _qFeeBpsEc2 > 0) opts2.feeAccount = feeAccount;
        const applyJito2 = jitoEnabled && nextSlip >= jitoThresh;
        const usePriorityCap2 = !applyJito2 && priorityCap > 0;
        if (applyJito2) {
          opts2.prioritizationFeeLamports = { jitoTipLamports: jitoTipDefault };
          attemptDiag.jitoTip = jitoTipDefault;
        } else if (usePriorityCap2) {
          opts2.prioritizationFeeLamports = {
            priorityLevelWithMaxLamports: {
              maxLamports: priorityCap,
              global: false,
              priorityLevel: "high",
            },
          };
          attemptDiag.autoPriorityCap = priorityCap;
        }

        const proPack2 = await jupProSwapInstructions(quote as any, swapAuthority.toBase58(), opts2);
        if (proPack2 && proPack2.swapInstruction) {
          const routeProgramId2 = String((proPack2 as any).swapInstruction?.programId || "");
          if (!shouldRejectRouteProgram(routeProgramId2, extraExcludeProgIds)) {
            pack = proPack2;
            break;
          }
        }
      } catch (e: any) {
        attemptDiag.packProErr2 = String(e?.message || e);
        pack = null;
        quote = null;
      }
    }
    if (!pack || !pack.swapInstruction || !quote) {
      // Best-effort cleanup even when we fail before building/sending an EC-PDA tx.
      // Some routes may still have created/left ephemeral token accounts/bins.
      try {
        await tryPostCloseEcPdaIfEmpty({
          conn,
          programId,
          relayer,
          payer,
          vault,
          vaultAuthority,
          swapAuthority,
          inMint,
          outMint,
          inProgram,
          outProgram,
          ephSrc,
          ephDst,
          config,
          swapNonce,
          inAuthAta,
          outAuthAta,
          remainingMetas: _mergedSeen(),
        });
      } catch {}
      return {
        ok: false,
        error: "swap_failed",
        detail: "ec_pda_pack_build_failed",
        diag: {
          ...diag,
          stage: "caught",
          attempts: [...diag.attempts, attemptDiag],
          message: "EC-PDA fallback failed to build Jupiter pack",
        },
      };
    }
  }

  const {
    setupList,
    cleanupIx,
    routeIx,
    remainingMetas,
    tlAccsLen,
    setupAccsLens,
    routeAccsLen,
    cleanupAccsLen,
    dataRoute,
    dataTL,
    dataSetups,
    dataCleanup,
  } = decomposePack(conn, pack);
	_addSeen(remainingMetas);

  // === HARD CPI account-limit enforcement ===
  // The on-chain vault program invokes Jupiter with program + `route_accounts` (or TL/setup/cleanup segments).
  // Each invoke cannot exceed 64 AccountInfos, so each segment must be <= 63 accounts.
  const tooMany = {
    tokenLedger: tlAccsLen > EC_PDA_MAX_JUPITER_CPI_ACCOUNTS ? tlAccsLen : 0,
    route: routeAccsLen > EC_PDA_MAX_JUPITER_CPI_ACCOUNTS ? routeAccsLen : 0,
    cleanup: cleanupAccsLen > EC_PDA_MAX_JUPITER_CPI_ACCOUNTS ? cleanupAccsLen : 0,
    setup: setupAccsLens?.find((n: number) => n > EC_PDA_MAX_JUPITER_CPI_ACCOUNTS) || 0,
  };
  if (tooMany.tokenLedger || tooMany.route || tooMany.cleanup || tooMany.setup) {
    attemptDiag.cpiAccountLimitExceeded = {
      max: EC_PDA_MAX_JUPITER_CPI_ACCOUNTS,
      tlAccsLen,
      routeAccsLen,
      cleanupAccsLen,
      setupAccsLens,
    };

    // === CPI account-limit overflow retry rung ===
    // If the selected Jupiter route is too large for CPI, re-enter EC-PDA with tighter quote constraints.
    // This is *not* a slippage re-quote: we keep the same slippage state but force smaller-account routes.
    if (accountBudgetRetryCount < 2) {
      const nextMax = Math.min(
        EC_PDA_MAX_JUPITER_CPI_ACCOUNTS,
        accountBudgetRetryCount === 0 ? 40 : 33
      );

      const addMeteora = accountBudgetRetryCount >= 1;
      const nextExcludeDexes = addMeteora
        ? [...extraExcludeDexes, ...METEORA_LABEL_SYNONYMS]
        : extraExcludeDexes;

      const nextExcludeProgIds = addMeteora
        ? [...extraExcludeProgIds, METEORA_LB_CLMM_PROGRAM_ID]
        : extraExcludeProgIds;

      attemptDiag.accountBudgetRetry = {
        retry: accountBudgetRetryCount + 1,
        forceDirectRoutes: true,
        maxAccountsOverride: nextMax,
        addMeteora,
      };

      diag.attempts.push(attemptDiag);
      return await executeSwapEcPdaFallback({
        ...params,
        accountBudgetRetryCount: accountBudgetRetryCount + 1,
        forceDirectRoutes: true,
        maxAccountsOverride: nextMax,
        extraExcludeDexes: nextExcludeDexes,
        extraExcludeProgIds: nextExcludeProgIds,
        // Preserve slippage re-quote counter; this retry is about account budgeting.
        reQuoteCount,
        seenRemainingMetas: _mergedSeen(),
        diag,
      });
    }

    // Best-effort cleanup prior to returning: reduce odds of stranded empty ephemerals.
    try {
      await tryPostCloseEcPdaIfEmpty({
        conn,
        programId,
        relayer,
        payer,
        vault,
        vaultAuthority,
        swapAuthority,
        inMint,
        outMint,
        inProgram,
        outProgram,
        ephSrc,
        ephDst,
        config,
        swapNonce,
        inAuthAta,
        outAuthAta,
        remainingMetas: _mergedSeen(),
      });
    } catch {}

    return {
      ok: false,
      error: "swap_failed",
      detail: "ec_pda_cpi_account_limit",
      diag: {
        ...diag,
        stage: "caught",
        attempts: [...diag.attempts, attemptDiag],
        message: `Jupiter route exceeds CPI account limit (max ${EC_PDA_MAX_JUPITER_CPI_ACCOUNTS})`,
      },
    };
  }

  const minOut = calcMinOut(quote, useSlippage);
  const disc = discriminator8("execute_swap_ec_pda");
  const platformFeeBpsTx = Math.max(
    0,
    Math.min(100, Number(process.env.NEXT_PUBLIC_PLATFORM_FEE_BPS || platformFeeBps || 0))
  );

  const data = Buffer.concat([
    disc,
    u64LE(swapNonce),
    u64LE(amountIn),
    u64LE(minOut),
    u16LE(platformFeeBpsTx),
    writeBytes(dataRoute),
    writeOptBytes(dataTL),
    writeVecBytes(dataSetups),
    writeOptBytes(dataCleanup),
    u32LE(tlAccsLen),
    writeVecU32(setupAccsLens),
    u32LE(routeAccsLen),
    u32LE(cleanupAccsLen),
  ]);

  const keysFixed = [
    { pubkey: relayer.publicKey, isWritable: true, isSigner: true }, // payer
    { pubkey: vault, isWritable: true, isSigner: false },
    { pubkey: vaultAuthority, isWritable: false, isSigner: false },
    { pubkey: swapAuthority, isWritable: false, isSigner: false },
    { pubkey: inAuthAta, isWritable: true, isSigner: false },
    { pubkey: outAuthAta, isWritable: true, isSigner: false },
    { pubkey: ephSrc, isWritable: true, isSigner: false },
    { pubkey: ephDst, isWritable: true, isSigner: false },
    { pubkey: inMint, isWritable: false, isSigner: false },
    { pubkey: outMint, isWritable: false, isSigner: false },
    { pubkey: treasuryAta, isWritable: true, isSigner: false },
    { pubkey: inProgram, isWritable: false, isSigner: false },
    { pubkey: outProgram, isWritable: false, isSigner: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: new PublicKey(routeIx.programId), isWritable: false, isSigner: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isWritable: false, isSigner: false },
    { pubkey: config, isWritable: false, isSigner: false },
  ];

  // Compute budget ixs are deterministic; build once per EC-PDA attempt.
  const _cuPriceEc = Number(process.env.JUP_CU_PRICE_MICROLAMPORTS || 0);
  const _cuIxsEc = ensureSetComputeBudgetIxs({
    cuLimit: 1_400_000,
    cuPriceMicroLamports: _cuPriceEc > 0 ? _cuPriceEc : "auto",
  });

  // Optimization: load LUTs once before buildTx. The LUT addresses come from the pack and
  // don't change between buildTx invocations (blockhash refreshes but pack is stable).
  const _ecPdaLutsLoaded = await loadLuts(conn, (pack as any).addressLookupTableAddresses || []);

  const buildTx = async () => {
    const ix = new TransactionInstruction({
      programId,
      keys: [...keysFixed, ...(remainingMetas ?? [])],
      data,
    });
    const instructions: TransactionInstruction[] = [];
    if (_cuIxsEc.length) instructions.push(..._cuIxsEc);
    instructions.push(ix);

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");

    // Include LUTs (pre-loaded above; stable for this pack)
    const msg = new TransactionMessage({
      payerKey: relayer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(_ecPdaLutsLoaded);
    const tx = new VersionedTransaction(msg);
  try {
    tx.sign([relayer]);
  } catch (e: any) {
    if (isEncodingOverrunErr(e)) {
      throw new Error("tx_too_large");
    }
    throw e;
  }
    return { tx, blockhash, lastValidBlockHeight };
  };

  // --- Pre-simulate EC-PDA tx; if slippage tolerance is exceeded in logs,
  //     re-quote with higher slippage (Jupiter Pro) up to EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_MAX times
  //     *before* we actually send a lamport-bearing transaction.
  let { tx, blockhash, lastValidBlockHeight } = await buildTx();
  let preSim = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed" as any,
  });
  attemptDiag.preSim = preSim?.value ?? null;

  // If shared-accounts router is incompatible, rebuild with useSharedAccounts=false (keeping same policy)
  if (isJupSharedRouteIncompatible(preSim?.value)) {
    attemptDiag.sharedAccountsRetry = true;
    const { jupProSwapInstructions } = await getJupProEc();
    const opts2: any = {
      destinationTokenAccount: ephDst.toBase58(),
      useSharedAccounts: false,
      useTokenLedger: false,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      maxAccounts: maxAccountsForAttempt(EC_ACCOUNT_BUDGET_BASE, 1),
    };
    const _qFeeBpsEcShared = feeAccount ? getQuotePlatformFeeBps(quote) : 0;
    if (feeAccount && _qFeeBpsEcShared > 0) opts2.feeAccount = feeAccount;
    const jitoEnabled2 = String(process.env.JITO_TIP_ENABLED || "").toLowerCase() === "true";
    const jitoThresh2 = Number(process.env.JITO_TIP_SLIPPAGE_THRESHOLD_BPS || 400) || 400;
    const jitoTipDefault2 = Math.max(1000, Number(process.env.JITO_TIP_LAMPORTS || 1000)) || 1000;
    const priorityCap2 = Number(
      process.env.JUP_AUTO_PRIORITY_CAP_LAMPORTS === undefined
        ? 2000
        : process.env.JUP_AUTO_PRIORITY_CAP_LAMPORTS
    ) || 2000;

    const applyJito2 = jitoEnabled2 && useSlippage >= jitoThresh2;
    const usePriorityCap2 = !applyJito2 && priorityCap2 > 0;

    if (applyJito2) {
      opts2.prioritizationFeeLamports = { jitoTipLamports: jitoTipDefault2 };
      attemptDiag.jitoTip = jitoTipDefault2;
    } else if (usePriorityCap2) {
      opts2.prioritizationFeeLamports = {
        priorityLevelWithMaxLamports: {
          maxLamports: priorityCap2,
          global: false,
          priorityLevel: "high",
        },
      };
      attemptDiag.autoPriorityCap = priorityCap2;
    }

    const pack2 = await jupProSwapInstructions(quote as any, swapAuthority.toBase58(), opts2);
    if (pack2 && pack2.swapInstruction) {
      const rebuilt = decomposePack(conn, pack2);
	      _addSeen(rebuilt?.remainingMetas ?? null);
      const ix2 = new TransactionInstruction({
        programId,
        keys: [...keysFixed, ...(rebuilt?.remainingMetas ?? [])],
        data: Buffer.concat([
          discriminator8("execute_swap_ec_pda"),
          u64LE(swapNonce),
          u64LE(amountIn),
          u64LE(calcMinOut(quote, useSlippage)),
          u16LE(platformFeeBpsTx),
          writeBytes(rebuilt.dataRoute),
          writeOptBytes(rebuilt.dataTL),
          writeVecBytes(rebuilt.dataSetups),
          writeOptBytes(rebuilt.dataCleanup),
          u32LE(rebuilt.tlAccsLen),
          writeVecU32(rebuilt.setupAccsLens),
          u32LE(rebuilt.routeAccsLen),
          u32LE(rebuilt.cleanupAccsLen),
        ]),
      });
      const { blockhash: bh2, lastValidBlockHeight: lvbh2 } =
        await conn.getLatestBlockhash("processed");
      const cuPrice2 = Number(process.env.JUP_CU_PRICE_MICROLAMPORTS || 0);
      const instructions2: TransactionInstruction[] = [
        ...ensureSetComputeBudgetIxs({
          cuLimit: 1_400_000,
          cuPriceMicroLamports: cuPrice2 > 0 ? cuPrice2 : "auto",
        }),
      ];
      instructions2.push(ix2);
      const msg2 = new TransactionMessage({
        payerKey: relayer.publicKey,
        recentBlockhash: bh2,
        instructions: instructions2,
      }).compileToV0Message(await loadLuts(conn, (pack2 as any).addressLookupTableAddresses || []));
      tx = new VersionedTransaction(msg2);
  try {
    tx.sign([relayer]);
  } catch (e: any) {
    if (isEncodingOverrunErr(e)) {
      throw new Error("tx_too_large");
    }
    throw e;
  }
      blockhash = bh2;
      lastValidBlockHeight = lvbh2;

      preSim = await conn.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "processed" as any,
      });
      attemptDiag.preSimSharedRetry = preSim?.value ?? null;
    }
  }

  // After any shared-accounts rebuild, decide if this tx is failing due to slippage.
  const finalPreSimValue = preSim?.value ?? null;
  const preSimSlippageExceeded = isSlippageExceeded(finalPreSimValue);
  attemptDiag.slippageExceededPre = preSimSlippageExceeded;

  if (preSimSlippageExceeded && reQuoteCount < EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_MAX) {
    const nextBaseSlip = Math.min(5000, baseSlipBps + EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_BPS);
    attemptDiag.stage = "pre_sim_slippage_requote";
    attemptDiag.nextBaseSlipBps = nextBaseSlip;
    diag.attempts.push(attemptDiag);

    // Re-enter EC-PDA fallback with higher base slippage (quote+pack+build+sim again, still no send).
    return await executeSwapEcPdaFallback({
      ...params,
      baseSlipBps: nextBaseSlip,
      reQuoteCount: reQuoteCount + 1,
	      seenRemainingMetas: _mergedSeen(),
      diag,
    });
  }

  try {
    attemptDiag.stage = "send";
    let _raw: Buffer | Uint8Array;
    try {
      _raw = tx.serialize();
    } catch (e: any) {
      if (isEncodingOverrunErr(e)) {
        // tx too large in a scope without attemptDiag; bubble up for retry handling
        throw new Error("tx_too_large");
      }
      throw e;
    }

    const sig = await conn.sendRawTransaction(_raw, {
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 3,
    });
    const conf = await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "processed"
    );
    const slotNum: number | undefined =
      typeof (conf as any)?.context?.slot === "number" ? (conf as any).context.slot : undefined;
    attemptDiag.result = {
      sig,
      slot: slotNum,
      routeProgram: (pack as any).swapInstruction?.programId,
    };
    diag.attempts.push(attemptDiag);

    // === Final post-swap EC-PDA cleanup pass (best-effort, no-throw) ===
    try {
      await tryPostCloseEcPdaIfEmpty({
        conn,
        programId,
        relayer,
        payer,
        vault,
        vaultAuthority,
        swapAuthority,
        inMint,
        outMint,
        inProgram,
        outProgram,
        ephSrc,
        ephDst,
        config,
        swapNonce,
        inAuthAta,
        outAuthAta,
	        remainingMetas: _mergedSeen(),
      });
    } catch {}
    return {
      ok: true,
      txPreview: "sent",
      signature: sig,
      slot: slotNum,
      outVaultAta: outAuthAta.toBase58(),
      quote,
      diag,
    };
  } catch (e: any) {
    attemptDiag.sendErr = String(e?.message || e);
    const sim = await conn
      .simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "processed" as any,
      })
      .catch(() => null);
    const simValue = sim?.value ?? null;
    attemptDiag.sim = simValue;

    const meteoraBitmapMissing = isMeteoraBitmapExtensionMissing(simValue, attemptDiag.sendErr);
    if (meteoraBitmapMissing) {
      const alreadyExcluded = (extraExcludeDexes || []).some((d) =>
        METEORA_LABEL_SYNONYMS.map((x) => x.toLowerCase()).includes(String(d || "").toLowerCase())
      );
      if (!alreadyExcluded) {
        attemptDiag.stage = "meteora_bitmap_missing_retry";
        attemptDiag.meteoraBitmapMissing = true;
        diag.attempts.push(attemptDiag);

        // Re-enter EC-PDA fallback but exclude Meteora DLMM/LB-CLMM routes, which can require
        // additional bitmap extension accounts that are sometimes omitted under account budgeting.
        return await executeSwapEcPdaFallback({
          ...params,
          extraExcludeDexes: [...(extraExcludeDexes || []), ...METEORA_LABEL_SYNONYMS],
          extraExcludeProgIds: [...(extraExcludeProgIds || []), METEORA_LB_CLMM_PROGRAM_ID],
          // Keep reQuoteCount as-is; this is not a slippage re-quote.
          reQuoteCount,
          seenRemainingMetas: _mergedSeen(),
          diag,
        });
      }

      // If we've already excluded Meteora by label but simulation still hits the bitmap-extension error,
      // force a strict venue set for the core SOL/USDC pair to maximize reliability.
      const isCore = isCorePair(inMint, outMint);
      const alreadyForcedOnly = !!(extraOnlyDexes && extraOnlyDexes.length);
      if (alreadyExcluded && isCore && !alreadyForcedOnly) {
        attemptDiag.stage = "meteora_bitmap_missing_force_core_only_dexes";
        attemptDiag.meteoraBitmapMissing = true;
        attemptDiag.corePairOnlyDexes = CORE_PAIR_ONLY_DEXES_CSV;
        diag.attempts.push(attemptDiag);
        return await executeSwapEcPdaFallback({
          ...params,
          extraOnlyDexes: CORE_PAIR_ONLY_DEXES,
          // Preserve exclusion state and seen metas
          extraExcludeDexes,
          extraExcludeProgIds,
          reQuoteCount,
          seenRemainingMetas: _mergedSeen(),
          diag,
        });
      }
    }

    const slipExceeded = isSlippageExceeded(simValue);
    attemptDiag.slippageExceededSend = slipExceeded;
    diag.attempts.push(attemptDiag);

	    // Best-effort cleanup even when the send path errors.
	    // If earlier EC-PDA attempts created additional temp token accounts/bins, we still want
	    // to reclaim rent/dust where possible. This call is safe & no-throw.
	    try {
	      await tryPostCloseEcPdaIfEmpty({
	        conn,
	        programId,
	        relayer,
	        payer,
	        vault,
	        vaultAuthority,
	        swapAuthority,
	        inMint,
	        outMint,
	        inProgram,
	        outProgram,
	        ephSrc,
	        ephDst,
	        config,
	        swapNonce,
	        inAuthAta,
	        outAuthAta,
	        remainingMetas: _mergedSeen(),
	      });
	    } catch {}

    // If the on-chain send failed due to slippage and we still have re-quote budget,
    // bump base slippage and try EC-PDA again (quote+pack+build+sim+send).
    if (slipExceeded && reQuoteCount < EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_MAX) {
      const nextBaseSlip = Math.min(5000, baseSlipBps + EC_PDA_ONCHAIN_SLIPPAGE_REQUOTE_BPS);
      return await executeSwapEcPdaFallback({
        ...params,
        baseSlipBps: nextBaseSlip,
        reQuoteCount: reQuoteCount + 1,
	        seenRemainingMetas: _mergedSeen(),
        diag,
      });
    }

    return {
      ok: false,
      error: "swap_failed",
      detail: String(e?.message || e),
      diag: { ...diag, stage: "caught" },
    };
  }
}

// Best-effort post-swap cleanup for EC-PDA ephemeral ATAs.
// We *cannot* close the PDAs from the client because the owner is the program PDA.
// However, most builds of `execute_swap_ec_pda` close empty EC-PDA bins during the cleanup phase.
// To coax late closure, we invoke a "cleanup-only" pass with the *same* `swapNonce` and no route,
// which is a no-op in programs that don't support it but will opportunistically close empties
// in those that do. All failures are swallowed.

async function tryPostCloseEcPdaIfEmpty(params: {
  conn: Connection;
  programId: PublicKey;
  relayer: Keypair;
  payer: PublicKey;
  vault: PublicKey;
  vaultAuthority: PublicKey;
  swapAuthority: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
  inProgram: PublicKey;
  outProgram: PublicKey;
  ephSrc: PublicKey;
  ephDst: PublicKey;
  config: PublicKey;
  swapNonce: bigint;
  inAuthAta: PublicKey;
  outAuthAta: PublicKey;
  // Optional: full Jupiter remaining accounts from the pack (route, setups, TL, cleanup).
  // These are appended to the post-swap cleanup instruction so the program can see all bins / temp token accounts.
  remainingMetas?: AccountMeta[] | null;
}): Promise<void> {
  if (!EC_PDA_ENABLE_POST_CLOSE) return;

  const {
    conn,
    programId,
    relayer,
    payer,
    vault,
    vaultAuthority,
    swapAuthority,
    inMint,
    outMint,
    inProgram,
    outProgram,
    ephSrc,
    ephDst,
    config,
    swapNonce,
    inAuthAta,
    outAuthAta,
  } = params;

  // Helper to probe ephemeral ATAs; treat missing account as zero (already closed).
  const probe = async () => {
    const [srcAi, dstAi] = await Promise.all([
      conn.getTokenAccountBalance(ephSrc).then((v: any) => v).catch(() => null),
      conn.getTokenAccountBalance(ephDst).then((v: any) => v).catch(() => null),
    ]);
    const srcExists = !!srcAi;
    const dstExists = !!dstAi;
    const srcZero = !srcAi || Number(srcAi?.value?.amount || 0) === 0;
    const dstZero = !dstAi || Number(dstAi?.value?.amount || 0) === 0;
    return { srcExists, dstExists, srcZero, dstZero };
  };

  try {
    // Initial small delay lets post-commit balances settle.
    if (EC_PDA_POST_CLOSE_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, EC_PDA_POST_CLOSE_DELAY_MS));
    }

    // Decide whether it's worth attempting cleanup.
    // We attempt if either ephemeral ATA exists OR we have any remaining metas (earlier bins).
    // Note: if the ephemerals are already closed and we only have remaining metas,
    // the program may reject the instruction due to missing accounts; that's fine (best-effort).
    const { srcExists, dstExists } = await probe();
    const hasRemaining = Array.isArray(params.remainingMetas) && params.remainingMetas.length > 0;
    if (!srcExists && !dstExists && !hasRemaining) return;


    // Best-effort: also include ANY EC-PDA-owned token accounts for src/dst mints discovered on-chain.
    // Rationale: Jupiter/Meteora can create temporary token accounts that are NOT present in quote remainingMetas
    // (or are missed due to retries/tx-size trimming). If they hold src/dst dust, on-chain cleanup can drain them
    // into vault custody ATAs and then close them, reclaiming rent.
    const extraDustMetas: AccountMeta[] = [];
    const maxExtra = Math.max(0, Number(process.env.EC_PDA_CLEANUP_EXTRA_ACCOUNTS || 32) || 32);
    const seen = new Set<string>();
      const markSeen = (pk: PublicKey) => {
        try {
          seen.add(pk.toBase58());
        } catch {
          // ignore
        }
      };
      const addMeta = (pk: PublicKey) => {
        const k = pk.toBase58();
        if (seen.has(k)) return;
        if (extraDustMetas.length >= maxExtra) return;
        seen.add(k);
        extraDustMetas.push({ pubkey: pk, isWritable: true, isSigner: false });
      };

    try {

      // Seed "seen" with all already-passed accounts so we don't bloat tx size.
      const seed: PublicKey[] = [
        payer,
        vault,
        vaultAuthority,
        swapAuthority,
        inAuthAta,
        outAuthAta,
        ephSrc,
        ephDst,
        inMint,
        outMint,
        inProgram,
        outProgram,
        config,
      ];
      for (const pk of seed) markSeen(pk);
      for (const m of params.remainingMetas ?? []) {
        try {
          markSeen(m.pubkey as PublicKey);
        } catch {
          // ignore
        }
      }

      // Helper to scan token accounts by owner for a given program and target mint.
      const scan = async (tokenProgram: PublicKey, mint: PublicKey) => {
        if (!maxExtra) return;
        let resp: any = null;
        try {
          resp = await conn.getParsedTokenAccountsByOwner(swapAuthority, { programId: tokenProgram });
        } catch {
          resp = { value: [] };
        }
        const arr = Array.isArray(resp?.value) ? resp.value : [];
        for (const it of arr) {
          if (extraDustMetas.length >= maxExtra) break;
          try {
            const pk = new PublicKey(it?.pubkey);
            const info = it?.account?.data?.parsed?.info;
            const mintStr = info?.mint;
            if (typeof mintStr !== "string" || mintStr !== mint.toBase58()) continue;

            // Include even if amount is "0" — on-chain cleanup will attempt close after sweep.
            // If non-zero and src/dst mint, on-chain cleanup will sweep into custody then close.
            addMeta(pk);
          } catch {
            // ignore
          }
        }
      };

      // Scan both token programs for both mints (cheap, parsed).
      await scan(inProgram, inMint);
      await scan(inProgram, outMint);
      if (!inProgram.equals(outProgram)) {
        await scan(outProgram, inMint);
        await scan(outProgram, outMint);
      }
    } catch {
      // ignore
    }

    
    // NEW: also include *all* EC-PDA-owned token accounts (any mint), not just in/out mints.
    // Some Jupiter routes open intermediate-mint "bin" accounts (e.g. wSOL or pool-side mints).
    // If we don't pass those accounts into cleanup-only, they can retain dust and never become
    // closeable (so sweepEmptyEcPdaBins can't close them).
    try {
      if (extraDustMetas.length < maxExtra) {
        const scanAllByOwner = async (programId: PublicKey) => {
          const res = await conn.getParsedTokenAccountsByOwner(swapAuthority, { programId });
          for (const a of res.value) {
            addMeta(a.pubkey);
          }
        };

        const progs = new Map<string, PublicKey>();
        progs.set(inProgram.toBase58(), inProgram);
        progs.set(outProgram.toBase58(), outProgram);
        await Promise.all(Array.from(progs.values()).map((p) => scanAllByOwner(p)));
      }
    } catch (e) {
      console.warn("[ec-pda] post-close: scanAllByOwner failed (continuing)", e);
    }

    // Filter/trim Jupiter remainingMetas aggressively.
    // Rationale:
    // - Passing the full Jupiter remaining metas (TL/setup/route/cleanup) can easily exceed v0 tx size.
    // - post_swap_cleanup_ec_pda only needs *writable token accounts* to sweep/close.
    // - If the cleanup-only tx is too large and we bail early, we still want sweep_ec_pda_bins to run.
    const MAX_POST_CLOSE_REMAINING = Math.max(
      0,
      Math.min(96, Number(process.env.EC_PDA_POST_CLOSE_MAX_REMAINING_METAS || 32) || 32)
    );
    const filteredRemaining: AccountMeta[] = [];
    try {
      const rem = Array.isArray(params.remainingMetas) ? params.remainingMetas : [];
      for (const m of rem) {
        if (!m) continue;
        // Keep only writable accounts (token accounts/bins are writable); skip program/sysvar/readonly.
        if (!m.isWritable) continue;
        const pk = (m as any).pubkey;
        if (!(pk instanceof PublicKey)) continue;
        const k = pk.toBase58();
        if (seen.has(k)) continue;
        if (filteredRemaining.length >= MAX_POST_CLOSE_REMAINING) break;
        seen.add(k);
        filteredRemaining.push({ pubkey: pk, isWritable: true, isSigner: false });
      }
    } catch {
      // ignore; filteredRemaining stays empty
    }

    // Build a 'cleanup-only' call. The on-chain handler performs the real checks.
    const disc = discriminator8('post_swap_cleanup_ec_pda');
    const data = Buffer.concat([disc, u64LE(swapNonce)]);

    const keys: AccountMeta[] = [
      { pubkey: payer, isWritable: true, isSigner: true }, // payer / relayer
      { pubkey: vault, isWritable: true, isSigner: false },
      { pubkey: vaultAuthority, isWritable: false, isSigner: false },
      { pubkey: swapAuthority, isWritable: false, isSigner: false },
      { pubkey: inAuthAta, isWritable: true, isSigner: false }, // src_vault_token
      { pubkey: outAuthAta, isWritable: true, isSigner: false }, // dst_vault_token
      { pubkey: ephSrc, isWritable: true, isSigner: false }, // ephemeral_src
      { pubkey: ephDst, isWritable: true, isSigner: false }, // ephemeral_dst
      { pubkey: inMint, isWritable: false, isSigner: false }, // src_mint
      { pubkey: outMint, isWritable: false, isSigner: false }, // dst_mint
      { pubkey: inProgram, isWritable: false, isSigner: false }, // src_token_program
      { pubkey: outProgram, isWritable: false, isSigner: false }, // dst_token_program
      { pubkey: config, isWritable: false, isSigner: false }, // governance allowlist
      ...extraDustMetas,
      ...filteredRemaining,
    ];

    const ix = new TransactionInstruction({ programId, keys, data });

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');
    const msg = new TransactionMessage({
      payerKey: relayer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...ensureSetComputeBudgetIxs({ cuLimit: 900_000, cuPriceMicroLamports: 'auto' }), ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    try {
      tx.sign([relayer]);
    } catch (e: any) {
      if (isEncodingOverrunErr(e)) throw new Error('tx_too_large');
      throw e;
    }

    let raw: Buffer | Uint8Array;
    try {
      raw = tx.serialize();
    } catch (e: any) {
      if (isEncodingOverrunErr(e)) throw new Error('tx_too_large');
      throw e;
    }

    try {
      const sig = await conn.sendRawTransaction(raw, {
        skipPreflight: true,
        preflightCommitment: 'processed' as any,
        maxRetries: 2,
      });
      conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'processed').catch(() => {});
    } catch {
      // ignored
    } finally {
      // ALWAYS attempt sweep/close of empty EC-PDA bins, even if cleanup-only tx was too large or failed.
      // This path is chunked, bounded, and only targets amount==0 accounts.
      try {
        await sweepEmptyEcPdaBins({
          conn,
          programId,
          relayer,
          vault,
          swapAuthority,
          config,
          swapNonce,
        });
      try {
        await sweepEmptyRelayerBins({ conn, relayer });
      } catch {}
      } catch {
        // ignored
      }
    }

    return;
  } catch {
    // absolute no-op on errors (never block swaps)
    try {
      // One last best-effort sweep attempt even if we failed earlier.
      await sweepEmptyEcPdaBins({
        conn,
        programId,
        relayer,
        vault,
        swapAuthority,
        config,
        swapNonce,
      });
      try {
        await sweepEmptyRelayerBins({ conn, relayer });
      } catch {}
    } catch {}
    return;
  }

}



// Best-effort sweep/close of *all empty* EC-PDA-owned token accounts by scanning chain state.
// This is complementary to post_swap_cleanup_ec_pda:
// - post_swap_cleanup_ec_pda can sweep src/dst dust then close; but may not see all bins.
// - sweep_ec_pda_bins can close any empty EC-PDA token accounts (amount==0) if provided as remaining pairs.
async function sweepEmptyEcPdaBins(params: {
  conn: Connection;
  programId: PublicKey;
  relayer: Keypair;
  vault: PublicKey;
  swapAuthority: PublicKey;
  config: PublicKey;
  swapNonce: bigint;
}): Promise<void> {
  if (!EC_PDA_ENABLE_EMPTY_BIN_SWEEP) return;

  const { conn, programId, relayer, vault, swapAuthority, config, swapNonce } = params;

  // Pull all token accounts owned by the swapAuthority under both Token programs.
  // We use parsed accounts to cheaply read token amount.
  const classicProg = TOKEN_PROGRAM_CLASSIC;
  const token2022Prog = TOKEN_2022_PROGRAM_ID;

  let parsedClassic: any = null;
  let parsed2022: any = null;
  try {
    parsedClassic = await conn.getParsedTokenAccountsByOwner(swapAuthority, { programId: classicProg });
  } catch {
    parsedClassic = { value: [] };
  }
  try {
    parsed2022 = await conn.getParsedTokenAccountsByOwner(swapAuthority, { programId: token2022Prog });
  } catch {
    parsed2022 = { value: [] };
  }

  const empties: { tokenProgram: PublicKey; tokenAccount: PublicKey }[] = [];

  const collect = (resp: any, tokenProgram: PublicKey) => {
    const arr = Array.isArray(resp?.value) ? resp.value : [];
    for (const it of arr) {
      try {
        const pubkey = new PublicKey(it?.pubkey);
        const info = it?.account?.data?.parsed?.info;
        const amt = info?.tokenAmount?.amount;
        if (typeof amt === "string" && amt === "0") {
          empties.push({ tokenProgram, tokenAccount: pubkey });
        }
      } catch {
        // ignore
      }
    }
  };

  collect(parsedClassic, classicProg);
  collect(parsed2022, token2022Prog);

  if (!empties.length) return;

  // Chunk to keep tx size in-bounds.
  const chunkSize = EC_PDA_EMPTY_BIN_SWEEP_CHUNK;

  for (let i = 0; i < empties.length; i += chunkSize) {
    const slice = empties.slice(i, i + chunkSize);
    if (!slice.length) continue;

    const disc = discriminator8("sweep_ec_pda_bins");
    // Args: (vault_pubkey: Pubkey, swap_nonce: u64)
    const data = Buffer.concat([disc, vault.toBuffer(), u64LE(swapNonce)]);

    const keys: AccountMeta[] = [
      { pubkey: relayer.publicKey, isWritable: true, isSigner: true },
      { pubkey: swapAuthority, isWritable: false, isSigner: false },
      { pubkey: config, isWritable: false, isSigner: false },
    ];

    // remaining_accounts are pairs: [token_program, token_account] ...
    for (const p of slice) {
      keys.push({ pubkey: p.tokenProgram, isWritable: false, isSigner: false });
      keys.push({ pubkey: p.tokenAccount, isWritable: true, isSigner: false });
    }

    const ix = new TransactionInstruction({ programId, keys, data });

    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");
      const msg = new TransactionMessage({
        payerKey: relayer.publicKey,
        recentBlockhash: blockhash,
        instructions: [...ensureSetComputeBudgetIxs({ cuLimit: 900_000, cuPriceMicroLamports: "auto" }), ix],
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);
      try {
        tx.sign([relayer]);
      } catch (e: any) {
        if (isEncodingOverrunErr(e)) throw new Error("tx_too_large");
        throw e;
      }

      let raw: Buffer | Uint8Array;
      try {
        raw = tx.serialize();
      } catch (e: any) {
        if (isEncodingOverrunErr(e)) throw new Error("tx_too_large");
        throw e;
      }

      const sig = await conn.sendRawTransaction(raw, {
        skipPreflight: true,
        preflightCommitment: "processed" as any,
        maxRetries: 2,
      });
      conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "processed").catch(() => {});

      // Small delay between sweeps to avoid hammering RPC in tight loops.
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      // best-effort; continue to next chunk
      continue;
    }
  }
}


// Best-effort sweep/close of *all empty* relayer-owned token accounts by scanning chain state.
// Why this exists:
// - Some Jupiter/Meteora route setups create temporary token accounts owned by the fee payer (relayer),
//   not by the EC-PDA swap authority.
// - Those accounts are not closable by `sweep_ec_pda_bins`, but *are* closable by the relayer signature.
// - We only target amount==0 accounts and we skip delegated / foreign closeAuthority cases by relying on RPC parsing.
// This is best-effort and never blocks swaps.
async function sweepEmptyRelayerBins(params: {
  conn: Connection;
  relayer: Keypair;
}): Promise<void> {
  if (!RELAYER_ENABLE_EMPTY_BIN_SWEEP) return;

  const { conn, relayer } = params;
  const owner = relayer.publicKey;

  const programs = [TOKEN_PROGRAM_CLASSIC, TOKEN_2022_PROGRAM_ID];

  // Collect empty accounts across both token programs.
  // We keep mint so we can (optionally) detect/skip ATAs.
  const empties: { tokenProgram: PublicKey; tokenAccount: PublicKey; mint: PublicKey }[] = [];

  for (const programId of programs) {
    let parsed: any = null;
    try {
      parsed = await conn.getParsedTokenAccountsByOwner(owner, { programId });
    } catch {
      parsed = { value: [] };
    }
    const arr = Array.isArray(parsed?.value) ? parsed.value : [];
    for (const it of arr) {
      try {
        const pubkey = new PublicKey(it?.pubkey);
        const info = it?.account?.data?.parsed?.info;
        const mintStr = String(info?.mint || "");
        if (!mintStr) continue;
        const mint = new PublicKey(mintStr);

        const amt = info?.tokenAmount?.amount;
        if (!(typeof amt === "string" && amt === "0")) continue;

        // Skip ATAs for safety (default on). This prevents closing persistent vault authority ATAs.
        if (RELAYER_SWEEP_SKIP_ATAS) {
          try {
            const ata = getAssociatedTokenAddressSync(
              mint,
              owner,
              false,
              programId,
              ASSOCIATED_TOKEN_PROGRAM_ID
            );
            if (ata.equals(pubkey)) continue;
          } catch {
            // If ATA derivation fails, don't block the sweep.
          }
        }

        // Only close if relayer is allowed to close:
        // - closeAuthority unset => owner can close
        // - closeAuthority == owner => owner can close
        const closeAuth = info?.closeAuthority ? String(info.closeAuthority) : null;
        if (closeAuth && closeAuth !== owner.toBase58()) continue;

        empties.push({ tokenProgram: programId, tokenAccount: pubkey, mint });
      } catch {
        // ignore
      }
    }
  }

  if (!empties.length) return;

  const chunkSize = RELAYER_EMPTY_BIN_SWEEP_CHUNK;

  // Close in small chunks to stay under tx size/compute limits.
  for (let i = 0; i < empties.length; i += chunkSize) {
    const slice = empties.slice(i, i + chunkSize);
    if (!slice.length) continue;

    const ixs: TransactionInstruction[] = [];
    for (const a of slice) {
      // Close token account to the relayer's system account.
      // This will only succeed if the relayer is the close authority (usually the owner)
      // and the token amount is zero.
      ixs.push(
        createCloseAccountInstruction(
          a.tokenAccount,
          owner,
          owner,
          [],
          a.tokenProgram
        )
      );
    }

    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("processed");
      const msg = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: [...ensureSetComputeBudgetIxs({ cuLimit: 400_000, cuPriceMicroLamports: "auto" }), ...ixs],
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);
      tx.sign([relayer]);

      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        preflightCommitment: "processed" as any,
        maxRetries: 1,
      });
      conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "processed").catch(() => {});

      // tiny delay to avoid tight RPC loops under high webhook concurrency
      await new Promise((r) => setTimeout(r, 120));
    } catch {
      // best-effort: continue
      continue;
    }
  }
}


// ---------- Helpers: pack decomposition, LUTs, detectors, encoding ----------
function decomposePack(conn: Connection, pack: any) {
  const tokenLedgerIx = (pack as any).tokenLedgerInstruction || null;
  const setupList = Array.isArray((pack as any).setupInstructions)
    ? (pack as any).setupInstructions
    : [];
  const cleanupIx = (pack as any).cleanupInstruction || null;
  const routeIx = (pack as any).swapInstruction;

  const accOf = (ix: any) =>
    (ix?.accounts ?? []).map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isWritable: !!a.isWritable,
      isSigner: false,
    }));

  const remTL = tokenLedgerIx ? accOf(tokenLedgerIx) : [];
  const remSetups = setupList.map(accOf);
  const remRoute = accOf(routeIx);
  const remCleanup = cleanupIx ? accOf(cleanupIx) : [];

  const dataTL = tokenLedgerIx ? ensureBuf(tokenLedgerIx.data) : null;
  const dataSetups = setupList.map((ix: any) => ensureBuf(ix.data));
  const dataRoute = ensureBuf(routeIx.data);
  const dataCleanup = cleanupIx ? ensureBuf(cleanupIx.data) : null;

  const tlAccsLen = remTL.length >>> 0;
  const setupAccsLens = remSetups.map((arr) => arr.length >>> 0);
  const routeAccsLen = remRoute.length >>> 0;
  const cleanupAccsLen = remCleanup.length >>> 0;

  const remainingRaw = [
    ...(tokenLedgerIx ? remTL : []),
    ...remSetups.flat(),
    ...remRoute,
    ...(cleanupIx ? remCleanup : []),
  ];
  const remainingMetas = remainingRaw.map((m) => ({ ...m, isSigner: false }));

  const jupProgram = new PublicKey(routeIx.programId);

  // Security: ensure we only ever CPI into known Jupiter swap program(s).
  // If this trips, it likely means the quote/pack source returned an unexpected programId.
  assertAllowedJupiterProgram(jupProgram, { stage: "decomposePack" });

  return {
    tokenLedgerIx,
    setupList,
    cleanupIx,
    routeIx,
    remainingMetas,
    tlAccsLen,
    setupAccsLens,
    routeAccsLen,
    cleanupAccsLen,
    dataRoute,
    dataTL,
    dataSetups,
    dataCleanup,
    jupProgram,
    luts: [] as AddressLookupTableAccount[], // we load LUTs directly from pack.addressLookupTableAddresses
  };
}

// --- LUT cache (module-scope) ----------------------------------------------
// LUT fetches are expensive; cache them with TTL to reduce redundant RPC calls.
// P0: Bounded to prevent unbounded growth between cold starts.
const _lutCache = new Map<string, { v: AddressLookupTableAccount | null; t: number }>();
const _LUT_CACHE_MAX = Math.max(64, Number(process.env.MOJOMAXI_LUT_CACHE_MAX || 512) || 512);
// ---------------------------------------------------------------------------

async function loadLuts(conn: Connection, lutAddrs: string[]) {
  // Dedupe/sanitize LUT addresses to avoid duplicate RPC and malformed keys under load.
  lutAddrs = Array.from(new Set((lutAddrs || []).filter((s) => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())));

  const luts: AddressLookupTableAccount[] = [];
  if (!Array.isArray(lutAddrs) || !lutAddrs.length) return luts;

  const now = Date.now();
  const ttlMs = Math.max(5_000, Number(process.env.MOJOMAXI_LUT_CACHE_TTL_MS || 60_000) || 60_000);
  const nullTtlMs = Math.max(1_000, Number(process.env.MOJOMAXI_LUT_CACHE_NULL_TTL_MS || 5_000) || 5_000);

  const fetched = await Promise.all(
    lutAddrs.map(async (a: string) => {
      const k = String(a);
      const hit = _lutCache.get(k);
      if (hit) {
        const age = now - hit.t;
        const maxAge = hit.v ? ttlMs : nullTtlMs;
        if (age >= 0 && age <= maxAge) return hit.v;
      }

      try {
        const { value } = await conn.getAddressLookupTable(new PublicKey(k));
        _lutCache.set(k, { v: value ?? null, t: now });
        return value ?? null;
      } catch {
        _lutCache.set(k, { v: null, t: now });
        return null;
      }
    })
  );

  for (const v of fetched) if (v) luts.push(v);
  // P0: Evict oldest entries when cache exceeds cap
  if (_lutCache.size > _LUT_CACHE_MAX) {
    const target = Math.floor(_LUT_CACHE_MAX * 0.85);
    let n = _lutCache.size - target;
    for (const key of _lutCache.keys()) { _lutCache.delete(key); if (--n <= 0) break; }
  }
  return luts;
}


async function preSimPackPas(params: {
  conn: Connection;
  blockhash: string;
  payer: PublicKey;
  relayer: Keypair;
  pack: any;
  ensureIxs: TransactionInstruction[];
  programId: PublicKey;
  vault: PublicKey;
  vaultAuthority: PublicKey;
  config: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
  inProgram: PublicKey;
  outProgram: PublicKey;
  inAuthAta: PublicKey;
  outAuthAta: PublicKey;
  treasuryAta: PublicKey;
  treasuryOwner: PublicKey;
  quote: any;
  amountIn: bigint;
  useSlippage: number;
  luts: AddressLookupTableAccount[];
}) {
  const {
    conn,
    payer,
    relayer,
    pack,
    ensureIxs,
    programId,
    vault,
    vaultAuthority,
    config,
    inMint,
    outMint,
    inProgram,
    outProgram,
    inAuthAta,
    outAuthAta,
    treasuryAta,
    quote,
    amountIn,
    useSlippage,
    luts,
  } = params;

  const {
    setupList,
    cleanupIx,
    routeIx,
    remainingMetas,
    tlAccsLen,
    setupAccsLens,
    routeAccsLen,
    cleanupAccsLen,
    dataRoute,
    dataTL,
    dataSetups,
    dataCleanup,
    jupProgram,
  } = decomposePack(conn, pack);

  const [programAsSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from("program_as_signer")],
    jupProgram
  );
  const disc = discriminator8("execute_swap");
  const minOut = calcMinOut(quote, useSlippage);
  const platformFeeBpsTx = Math.max(
    0,
    Math.min(100, Number(process.env.NEXT_PUBLIC_PLATFORM_FEE_BPS || 0))
  );

  const data = Buffer.concat([
    disc,
    u64LE(amountIn),
    u64LE(minOut),
    u16LE(platformFeeBpsTx),
    writeBytes(dataRoute),
    writeOptBytes(dataTL),
    writeVecBytes(dataSetups),
    writeOptBytes(dataCleanup),
    u32LE(tlAccsLen),
    writeVecU32(setupAccsLens),
    u32LE(routeAccsLen),
    u32LE(cleanupAccsLen),
  ]);

  const keysFixed = [
    { pubkey: payer, isWritable: true, isSigner: true },
    { pubkey: vault, isWritable: true, isSigner: false },
    { pubkey: vaultAuthority, isWritable: false, isSigner: false },
    { pubkey: inAuthAta, isWritable: true, isSigner: false },
    { pubkey: outAuthAta, isWritable: true, isSigner: false },
    { pubkey: inMint, isWritable: false, isSigner: false },
    { pubkey: outMint, isWritable: false, isSigner: false },
    { pubkey: treasuryAta, isWritable: true, isSigner: false },
    { pubkey: inProgram, isWritable: false, isSigner: false },
    { pubkey: outProgram, isWritable: false, isSigner: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    { pubkey: new PublicKey(routeIx.programId), isWritable: false, isSigner: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isWritable: false, isSigner: false },
    { pubkey: programAsSigner, isWritable: false, isSigner: false },
    { pubkey: config, isWritable: false, isSigner: false },
  ];

  const ix = new TransactionInstruction({
    programId,
    keys: [...keysFixed, ...(remainingMetas ?? [])],
    data,
  });
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: params.blockhash,
    instructions: [
      ...ensureIxs,
      ...ensureSetComputeBudgetIxs({ cuLimit: 1_400_000, cuPriceMicroLamports: "auto" }),
      ix,
    ],
  }).compileToV0Message(luts);
  const tx = new VersionedTransaction(msg);
  try {
      tx.sign([relayer]);
    } catch (e: any) {
    if (isEncodingOverrunErr(e)) {
      return {
        ok: false,
        error: "swap_failed",
        detail: "tx_too_large",
        diag: {
          stage: "caught",
          attempts: [],
          message: "tx_too_large",
        },
      };
    }
    throw e;
  }
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed" as any,
  });
  return { needsNoLedger: isDesiredInZero(sim?.value) };
}

// Detect when Jupiter's shared-accounts router fails so we can rebuild with useSharedAccounts=false.
function isJupSharedRouteIncompatible(sim: any): boolean {
  try {
    if (!sim || !Array.isArray(sim.logs)) return false;
    const logs: string[] = sim.logs;
    const usedSharedRouter = logs.some(
      (l) =>
        l.includes("Instruction: SharedAccountsRouteWithTokenLedger") ||
        l.includes("Instruction: SharedAccountsRoute")
    );
    if (!usedSharedRouter) return false;
    const sharedRouterFailed =
      logs.some((l) => /invalid account data for instruction/i.test(l)) ||
      logs.some((l) => /InvalidAccountData/i.test(l)) ||
      logs.some((l) => /custom program error:\s*0xc4/i.test(l));
    return sharedRouterFailed;
  } catch {
    return false;
  }
}
// Detect “Desired amount in is zero or negative”
function isDesiredInZero(sim: any): boolean {
  try {
    if (!sim || !Array.isArray(sim.logs)) return false;
    const logs: string[] = sim.logs;
    return logs.some((l) =>
      /Desired amount in is zero or negative|desired_amount_in.amount=0/i.test(l)
    );
  } catch {
    return false;
  }
}

// Detect generic “slippage tolerance exceeded” / “slippage exceeded” messages in sim logs.
function isSlippageExceeded(sim: any): boolean {
  try {
    if (!sim || !Array.isArray(sim.logs)) return false;
    const logs: string[] = sim.logs;
    return logs.some((l) =>
      /slippage tolerance exceeded|slippage exceeded|slippage limit/i.test(l)
    );
  } catch {
    return false;
  }
}

// ---------- Encoding helpers ----------
function u8(n: number): Buffer {
  const b = Buffer.alloc(1);
  b[0] = n & 0xff;
  return b;
}
function u16LE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}
function u32LE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
function writeBytes(bytes: Buffer): Buffer {
  return Buffer.concat([u32LE(bytes.length), bytes]);
}
function writeVecBytes(items: Buffer[]): Buffer {
  return Buffer.concat([u32LE(items.length), ...items.map(writeBytes)]);
}
function writeVecU32(nums: number[]): Buffer {
  return Buffer.concat([u32LE(nums.length), ...nums.map((n) => u32LE(n >>> 0))]);
}
function writeOptBytes(b: Buffer | null): Buffer {
  return b && b.length ? Buffer.concat([u8(1), writeBytes(b)]) : Buffer.concat([u8(0)]);
}
function discriminator8(
  name: "execute_swap" | "execute_swap_ec_pda" | "post_swap_cleanup_ec_pda" | "sweep_ec_pda_bins"
): Buffer {
  // Precomputed Anchor 8-byte discriminators (sha256("global:<name>")[:8])
  switch (name) {
    case "execute_swap":
      return Buffer.from([56, 182, 124, 215, 155, 140, 157, 102]);
    case "execute_swap_ec_pda":
      return Buffer.from([21, 159, 161, 210, 55, 124, 221, 150]);
    case "post_swap_cleanup_ec_pda":
      return Buffer.from([23, 113, 173, 61, 165, 89, 140, 95]);
    case "sweep_ec_pda_bins":
      return Buffer.from([12, 171, 100, 146, 30, 27, 53, 202]);
    default:
      throw new Error(`unknown_discriminator:${name}`);
  }
}
function ensureBuf(x: any): Buffer {
  if (!x) return Buffer.alloc(0);
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x);
  if (typeof x === "string") return x.length ? Buffer.from(x, "base64") : Buffer.alloc(0);
  if (typeof x === "object" && Array.isArray((x as any).data))
    return Buffer.from((x as any).data);
  return Buffer.alloc(0);
}

// --- Exports ---
export { executeSwapCPI };
export default executeSwapCPI;
