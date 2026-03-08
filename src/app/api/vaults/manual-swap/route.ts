// filepath: src/app/api/vaults/manual-swap/route.ts
// RUNTIME: nodejs
// PURPOSE: User-initiated manual swap from the dashboard.
//
// Intended behavior (unchanged):
// - Only allowed when set status is RUNNING
// - If vault has any Token B => swap B -> A, else if vault has any Token A => swap A -> B
// - Executes via internal-only /api/rebalance/execute-swap to match existing swap pipeline
//
// Reliability additions (non-breaking):
// - Hard timeouts around RPC + internal fetch to prevent Cloudflare 502 (origin timeout/crash).
// - Always returns JSON on failures (even if upstream RPC/provider flakes).
// - Adds `stage` + `rpcUrl` diagnostics to pinpoint where failures happen.
// - Optional safety cap via SWAP_MAX_PCT (default 100% = no cap) for Token-2022 extension mints.

import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { redis } from "@/lib/redis";
import { POST as execSwapPOST } from "@/app/api/rebalance/execute-swap/route";
import crypto from "crypto";

import { getSessionWalletFromRequest } from "@/lib/auth/session.server";
import { normalizeWebhookMintsFromDoc } from "@/lib/immutability.guard";
import { logWebhookStyleSwapEvent } from "@/lib/webhook-swap-event-builder.server";
import { getSetById, pushRecentEvent } from "@/lib/store";


type AnyObj = Record<string, any>;

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function safeStr(x: any) {
  return typeof x === "string" ? x : String(x ?? "");
}

function stripDashes(s: string): string {
  return safeStr(s).trim().replace(/-/g, "");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: any;
  const timeout = new Promise<T>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout:${label}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t)) as Promise<T>;
}

// Match common setId16 behavior: 32-hex -> 16 bytes, else md5 -> 16 bytes.
function setIdToBytes16(setId: string): Buffer {
  const raw = stripDashes(setId);
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("md5").update(raw, "utf8").digest();
}

function buildInternalHeaders(req: NextRequest, walletHeader: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-wallet": walletHeader };
  const auth = safeStr(
    req.headers.get("authorization") ||
      (process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "") ||
      "",
  ).trim();
  if (auth) headers["authorization"] = auth;
  const bypass = safeStr(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  return headers;
}

async function isSetRunning(setId: string): Promise<boolean> {
  if (!setId) return false;
  try {
    const key = `mm:set:${setId}:status`;
    const state = await withTimeout(redis.hget<string>(key as any, "state") as any, 1500, "redis_state").catch(
      () => null,
    );
    if (safeStr(state || "").toLowerCase() === "running") return true;

    const legacy = await withTimeout(redis.hget<string>(`mm:set:${setId}` as any, "status") as any, 1500, "redis_legacy").catch(
      () => null,
    );
    if (safeStr(legacy || "").toLowerCase() === "running") return true;
  } catch {}
  return false;
}

async function pk(s: string, label: string): Promise<any> {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    return new PublicKey(safeStr(s).trim());
  } catch {
    throw new Error(`${label}_invalid`);
  }
}

function rpcUrlFromEnv(): string {
  return (
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.SOLANA_MAINNET_RPC ||
    process.env.SOLANA_RPC_ENDPOINT ||
    process.env.RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  ).trim();
}

function rpcHeadersFromEnv(): Record<string, string> | undefined {
  const raw = safeStr(process.env.SOLANA_RPC_HEADERS || "").trim();
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return j;
  } catch {}
  return undefined;
}

async function getConn(): Promise<{ conn: any; rpcUrl: string }> {
  const { Connection } = await import("@solana/web3.js");
  const rpcUrl = rpcUrlFromEnv();
  const headers = rpcHeadersFromEnv();
  const conn = new Connection(rpcUrl, { commitment: "processed", httpHeaders: headers } as any);
  return { conn, rpcUrl };
}

const TOKEN_PROGRAM_CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

async function getVaultProgramId(): Promise<any> {
  const { PublicKey } = await import("@solana/web3.js");
  const pidStr = safeStr(process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID || "").trim();
  if (!pidStr) throw new Error("missing_vault_program_id");
  return new PublicKey(pidStr);
}

async function tokenProgramIdForMint(conn: any, mint: any): Promise<any> {
  const { PublicKey } = await import("@solana/web3.js");
  for (const c of ["processed", "confirmed", "finalized"] as const) {
    try {
      const ai: any = await withTimeout(conn.getAccountInfo(mint, c) as any, 3500, `mint_account_${c}`);
      if ((ai as any)?.owner) return new PublicKey((ai as any).owner);
    } catch {}
  }
  return new PublicKey(TOKEN_PROGRAM_CLASSIC);
}

async function readAtaAmountRobust(
  conn: any,
  ata: any,
): Promise<{ amount: string; decimals: number; uiAmount: number }> {
  const commitments = ["processed", "confirmed", "finalized"] as const;
  let best = { amount: "0", decimals: 0, uiAmount: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const c of commitments) {
      try {
        const bal: any = await withTimeout(conn.getTokenAccountBalance(ata, c as any) as any, 3500, `ata_balance_${c}`);
        const v: any = (bal as any)?.value || {};
        const amount = safeStr(v?.amount ?? "0");
        const decimals = Number(v?.decimals ?? 0);
        const uiAmount = typeof v?.uiAmount === "number" ? v.uiAmount : 0;
        const cur = { amount, decimals, uiAmount };
        if (/^[0-9]+$/.test(amount) && BigInt(amount) > BigInt(best.amount)) best = cur;
        if (/^[0-9]+$/.test(amount) && BigInt(amount) > 0n) return cur;
      } catch {}
    }
    await sleep(60);
  }
  return best;
}

async function readAtaAmountFast(
  conn: any,
  ata: any,
): Promise<{ amount: string; decimals: number; uiAmount: number }> {
  const commitments = ["processed", "confirmed"] as const;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const c of commitments) {
      try {
        const bal: any = await withTimeout(conn.getTokenAccountBalance(ata, c as any) as any, 2200, `ata_balance_${c}`);
        const v: any = (bal as any)?.value || {};
        const amount = safeStr(v?.amount ?? "0");
        const decimals = Number(v?.decimals ?? 0);
        const uiAmount = typeof v?.uiAmount === "number" ? v.uiAmount : 0;
        if (/^[0-9]+$/.test(amount)) return { amount, decimals, uiAmount };
      } catch {}
    }
    await sleep(40);
  }
  return { amount: "0", decimals: 0, uiAmount: 0 };
}

async function readBestAtaAmountFast(
  conn: any,
  atas: any[],
): Promise<{ ata: any | null; amount: string; decimals: number; uiAmount: number }> {
  let best = { ata: null as any, amount: "0", decimals: 0, uiAmount: 0 };
  for (const ata of atas) {
    try {
      const cur = await readAtaAmountFast(conn, ata);
      if (/^[0-9]+$/.test(cur.amount)) {
        if (best.ata === null || BigInt(cur.amount) > BigInt(best.amount)) best = { ata, ...cur };
      }
    } catch {}
  }
  return best;
}

async function deriveAuthorityFromVault(vaultB58: string): Promise<any> {
  const { PublicKey } = await import("@solana/web3.js");
  const { deriveVaultAuthorityPda } = await import("@/lib/vault-sdk");
  const programId = await getVaultProgramId();
  const vaultPk = new PublicKey(vaultB58);
  const [auth] = deriveVaultAuthorityPda(programId as any, vaultPk);
  return auth;
}

async function deriveVaultPdaFallback(ownerB58: string, setId: string): Promise<any> {
  const { PublicKey } = await import("@solana/web3.js");
  const programId = await getVaultProgramId();
  const ownerPk = new PublicKey(ownerB58);
  const setBytes16 = setIdToBytes16(setId);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault", "utf8"), ownerPk.toBuffer(), Buffer.from(setBytes16)],
    programId,
  );
  return vault;
}

export async function POST(req: NextRequest) {
  let stage = "start";
  let rpcUrl = "";
  try {
    stage = "parse_body";
    const raw = (await req.json().catch(() => ({} as AnyObj))) as AnyObj;

    const setIdRaw = safeStr(raw?.setId || "").trim();
    const setId = stripDashes(setIdRaw);
    const owner = safeStr(raw?.ownerPubkey || raw?.owner || "").trim();
    const vaultOverride = safeStr(raw?.vault || "").trim();

    if (!setId || !owner) return json(400, { ok: false, error: "invalid_body" });

    stage = "session_gate";
    // Require a valid signed wallet session cookie (same model used to reveal webhooks / start-stop).
    // This prevents unauthenticated callers (e.g., Ledger without session) from triggering expensive RPC/swap work.
    const sessionWallet = await withTimeout(getSessionWalletFromRequest(req as any).catch(() => null), 1200, "session");
    if (!sessionWallet) return json(401, { ok: false, error: "unauthorized", stage, rpcUrl: rpcUrl || undefined });
    if (sessionWallet !== owner) return json(403, { ok: false, error: "wallet_mismatch_session", stage, sessionWallet, owner });

    stage = "load_set";
    const set = await withTimeout(getSetById(setId).catch(() => null as any), 2500, "get_set");
    if (!set) return json(404, { ok: false, error: "set_not_found" });
    const setWallet = safeStr((set as any)?.wallet || "").trim();
    if (setWallet && setWallet !== owner) return json(403, { ok: false, error: "wallet_mismatch" });

    stage = "running_gate";
    const running = await isSetRunning(setId);
    if (!running) return json(409, { ok: false, error: "set_not_running" });

    stage = "resolve_mints";
    const { mintA, mintB, mintIn, mintOut } = normalizeWebhookMintsFromDoc(set || {});
    const A: string | undefined =
      typeof mintA === "string" && mintA ? mintA : typeof mintIn === "string" && mintIn ? mintIn : undefined;
    const B: string | undefined =
      typeof mintB === "string" && mintB ? mintB : typeof mintOut === "string" && mintOut ? mintOut : undefined;
    if (!A || !B) return json(400, { ok: false, error: "mints_not_set" });

    stage = "rpc_connect";
    const c = await getConn();
    rpcUrl = c.rpcUrl;
    const conn = c.conn;
    const programId = await getVaultProgramId();

    stage = "resolve_vault";
    let vault: any;
    if (vaultOverride) {
      vault = await pk(vaultOverride, "vault");
    } else {
      const vDoc = safeStr((set as any)?.vault || (set as any)?.vaultAddress || "").trim();
      if (vDoc) vault = await pk(vDoc, "vault");
      else vault = await deriveVaultPdaFallback(owner, setId);
    }

    stage = "derive_authority";
    const authority = await deriveAuthorityFromVault(vault.toBase58());

    stage = "ensure_atas";
    try {
      const { ensureVaultAtasForMints } = await import("@/lib/vault-atas.server");
      await withTimeout(
        ensureVaultAtasForMints({
          setId,
          vault: vault.toBase58(),
          authority: authority.toBase58(),
          mints: [A, B],
          clientRef: "ingest-manual-swap",
        } as any),
        5000,
        "ensure_atas",
      );
    } catch {
      // ignore
    }

    stage = "read_balances";
    const spl = await import("@solana/spl-token");
    const A_pk = await pk(A, "mintA");
    const B_pk = await pk(B, "mintB");

    // Avoid slow mint-program lookups (getAccountInfo) just to derive ATAs.
    // Compute both classic-token and token-2022 ATA candidates and read whichever holds funds.
    const aAtaClassic = spl.getAssociatedTokenAddressSync(
      A_pk,
      authority,
      true,
      spl.TOKEN_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const aAta2022 = spl.getAssociatedTokenAddressSync(
      A_pk,
      authority,
      true,
      spl.TOKEN_2022_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const bAtaClassic = spl.getAssociatedTokenAddressSync(
      B_pk,
      authority,
      true,
      spl.TOKEN_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const bAta2022 = spl.getAssociatedTokenAddressSync(
      B_pk,
      authority,
      true,
      spl.TOKEN_2022_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const [aBest, bBest] = await Promise.all([
      readBestAtaAmountFast(conn, [aAtaClassic, aAta2022]),
      readBestAtaAmountFast(conn, [bAtaClassic, bAta2022]),
    ]);

    const aAta = aBest.ata || aAtaClassic;
    const bAta = bBest.ata || bAtaClassic;

    const aAtoms = safeStr(aBest?.amount || "0");
    const bAtoms = safeStr(bBest?.amount || "0");

    const bAmt = /^[0-9]+$/.test(bAtoms) ? BigInt(bAtoms) : 0n;
    const aAmt = /^[0-9]+$/.test(aAtoms) ? BigInt(aAtoms) : 0n;

    const tokenProgramA = (aBest.ata && aBest.ata.equals?.(aAta2022)) ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID;
    const tokenProgramB = (bBest.ata && bBest.ata.equals?.(bAta2022)) ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID;

    stage = "select_direction";
    let inMint: string;
    let outMint: string;
    let amountInAtoms: string;
    let direction: "buy" | "sell";

    // IMPORTANT: Webhook ingestion knows direction (buy vs sell) explicitly.
    // Manual swap is a single button, so if both A and B have non-zero balances, we must avoid
    // "dust wins" (tiny residual input amount causing no-route/amount-too-small failures).
    // We mirror ingest/webhook behavior by:
    //  1) applying a conservative dust threshold per mint, and
    //  2) when both sides are meaningful, using the webhook position state (mm:set:${setId}:pos)
    //     to decide whether the next action should be buy or sell.
    const dustAtomsFor = (decimals: number) => {
      // 0.0001 token in atoms (min 1 atom). e.g. 6dp => 100 atoms, 9dp => 100_000 atoms
      const p = Math.max(0, Math.min(18, Number(decimals || 0)));
      const base = 10n ** BigInt(p);
      const t = base / 10_000n;
      return t > 0n ? t : 1n;
    };

    const aDust = dustAtomsFor(Number((aBest as any)?.decimals || 0));
    const bDust = dustAtomsFor(Number((bBest as any)?.decimals || 0));

    const aSignificant = aAmt > aDust;
    const bSignificant = bAmt > bDust;

    // Default heuristic (matches prior behavior when only one side is meaningful)
    const defaultDirection: "buy" | "sell" = bSignificant ? "buy" : "sell";

    // Read webhook position if available (best-effort). qtyTokens > 0 implies we are "in A" (so prefer sell).
    let posPreferred: "buy" | "sell" | null = null;
    try {
      const posKey = `mm:set:${setId}:pos`;
      const raw = await (redis as any).get(posKey).catch(() => null);
      const pos = raw && typeof raw === "string" ? JSON.parse(raw) : raw;
      const qty = Number((pos as any)?.qtyTokens || 0);
      if (Number.isFinite(qty)) posPreferred = qty > 0 ? "sell" : "buy";
    } catch {
      posPreferred = null;
    }

    const choose = (d: "buy" | "sell") => {
      if (d === "buy") {
        inMint = B;
        outMint = A;
        amountInAtoms = bAtoms;
        direction = "buy";
      } else {
        inMint = A;
        outMint = B;
        amountInAtoms = aAtoms;
        direction = "sell";
      }
    };

    // "bigger balance wins" heuristic with guardrails:
    // - If one side is meaningful and the other is not, follow that side (same as before).
    // - If both sides are meaningful, choose the direction based on which side dominates.
    // - If both are meaningful but close (within ~5%), fall back to webhook-style position state,
    //   and finally to the prior default heuristic.
    const dominancePct = 5; // 5% dominance threshold to avoid flip-flopping near 50/50
    const dominates = (bigger: bigint, smaller: bigint) => {
      if (smaller <= 0n) return true;
      // bigger >= smaller * (100 + dominancePct) / 100
      return bigger * 100n >= smaller * BigInt(100 + dominancePct);
    };

    if (bSignificant && !aSignificant) {
      choose("buy");
    } else if (aSignificant && !bSignificant) {
      choose("sell");
    } else if (aSignificant && bSignificant) {
      const bBigger = bAmt >= aAmt;
      const bigger = bBigger ? bAmt : aAmt;
      const smaller = bBigger ? aAmt : bAmt;
      if (dominates(bigger, smaller)) {
        choose(bBigger ? "buy" : "sell");
      } else {
        // Too close: follow position when present; otherwise preserve prior heuristic.
        choose(posPreferred || defaultDirection);
      }
    } else if (bAmt > 0n || aAmt > 0n) {
      // Only dust remains: choose the larger side to avoid "dust wins".
      choose(bAmt >= aAmt ? "buy" : "sell");
    } else {
      return json(409, {
        ok: false,
        error: "no_vault_balance",
        diag: {
          stage,
          rpcUrl,
          setId,
          vault: vault.toBase58(),
          authority: authority.toBase58(),
          mintA: A,
          mintB: B,
          aAta: aAta.toBase58(),
          bAta: bAta.toBase58(),
          aAtoms,
          bAtoms,
          tokenProgramA: tokenProgramA.toBase58(),
          tokenProgramB: tokenProgramB.toBase58(),
        },
      });
    }

    if (!/^[0-9]+$/.test(amountInAtoms) || BigInt(amountInAtoms) <= 0n) {
      return json(409, { ok: false, error: "no_vault_balance" });
    }

    const pct = Number.isFinite(Number(process.env.SWAP_MAX_PCT)) ? Number(process.env.SWAP_MAX_PCT) : 100;
    const capPct = Math.max(1, Math.min(100, Math.floor(pct)));
    if (capPct < 100) {
      const cap = (BigInt(amountInAtoms) * BigInt(capPct)) / 100n;
      if (cap > 0n && cap < BigInt(amountInAtoms)) amountInAtoms = cap.toString();
    }

    stage = "execute_swap";
    const headers = buildInternalHeaders(req, owner);
    const execUrl = new URL("/api/rebalance/execute-swap", req.url);
    const runId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const body = {
      setId,
      ownerWallet: owner,
      runId,
      inMint,
      outMint,
      amountIn: String(amountInAtoms),
      vault: vault.toBase58(),
      vaultAuthority: authority.toBase58(),
      programId: programId.toBase58(),
      wrapAndUnwrapSol: true,
      preferNativeSolInput: true,
      clientRef: "ingest-manual-swap",
      setKind: "webhook",
      direction,
    };

    // Execute swap via the shared swap pipeline.
    // NOTE: Manual swaps are user-facing and can occasionally be "slow" (RPC / confirmation),
    // and a hard request abort can cause a false-negative even if the tx lands shortly after.
    // To avoid "swap failed" when the swap actually succeeded, we:
    //  1) do a few best-effort attempts with a per-attempt timeout
    //  2) if still failing, re-check vault ATA balances briefly to detect a late-confirmed swap

    const startMs = Date.now();
    const overallDeadlineMs = startMs + 55_000;
    const MAX_ATTEMPTS = 3;

    const execOnce = async (timeoutMs: number, bodyOverride?: any) => {
      // Avoid internal HTTP hops for reliability + latency (match ingest path).
      const req2 = new NextRequest(execUrl.toString(), {
        method: "POST",
        headers: headers as any,
        body: JSON.stringify(bodyOverride ?? body),
      } as any);

      const res = (await withTimeout(execSwapPOST(req2 as any) as any, timeoutMs, "exec_swap")) as any;
      const j = await (res as any).json?.().catch(() => ({} as any));
      return { res: res as Response, j };
    };

    const isRetriable = (status: number, j: any, err: any) => {
      const msg = safeStr(err?.message || "");
      const e = safeStr(j?.error || j?.reason || "").toLowerCase();
      if (msg.startsWith("timeout:")) return true;
      if (status === 0) return true;
      if (status === 408 || status === 425 || status === 429) return true;
      if (status >= 500 && status <= 599) return true;
      if (e.includes("timeout") || e.includes("network")) return true;
      // swap_failed is common for transient conditions; we'll post-check late confirm
      if (e === "swap_failed") return true;
      return false;
    };

    const postCheckLateSwap = async (): Promise<boolean> => {
      try {
        // We only have two mints in webhook vaults, so a simple balance delta check is safe.
        const inBefore = direction === "buy" ? bAtoms : aAtoms;
        const outBefore = direction === "buy" ? aAtoms : bAtoms;
        const inAta = direction === "buy" ? bAta : aAta;
        const outAta = direction === "buy" ? aAta : bAta;

        const inBeforeBn = BigInt(inBefore || "0");
        const outBeforeBn = BigInt(outBefore || "0");

        const deadline = Date.now() + 18_000; // best-effort, bounded to avoid serverless timeouts
        while (Date.now() < deadline) {
          await sleep(1500);

          const inAfter = (await readAtaAmountRobust(conn, inAta)).amount;
          const outAfter = (await readAtaAmountRobust(conn, outAta)).amount;

          const inAfterBn = BigInt(inAfter || "0");
          const outAfterBn = BigInt(outAfter || "0");

          // Swap success heuristic:
          // - "in" decreased (spent something) AND "out" increased (received something)
          const inSpent = inAfterBn < inBeforeBn;
          const outReceived = outAfterBn > outBeforeBn;
          if (inSpent && outReceived) return true;
        }
      } catch {
        // best-effort only
      }
      return false;
    };

    let res: Response | null = null;
    let j: any = null;
    let lastErrStage = stage;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = overallDeadlineMs - Date.now();
      if (remaining <= 4_000) break;

      const timeoutMs = Math.max(25_000, Math.min(remaining - 3_000, 45_000));
      stage = `execute_swap_attempt_${attempt}`;

      try {
        const out = await execOnce(timeoutMs);
        res = out.res;
        j = out.j;

        // If executor is busy but queued the swap for later, treat as accepted.
        // This prevents "false failures" where the swap lands shortly after.
        const statusNow = Number((res as any)?.status || 0);
        if (statusNow === 429 && safeStr(j?.error || "").toLowerCase() === "busy" && !!j?.queued) {
          return json(202, {
            ok: true,
            queued: true,
            jobId: j?.jobId || undefined,
            message: safeStr(j?.message || "Swap queued for retry."),
          });
        }

        if ((res as any)?.ok && j?.ok) break;

        const status = Number((res as any)?.status || 0);
        if (isRetriable(status, j, null)) {
          await sleep(450 + attempt * 450);
          continue;
        }
        lastErrStage = stage;
        break;
      } catch (e: any) {
        lastErrStage = stage;
        const status = Number((res as any)?.status || 0);
        if (isRetriable(status, j, e)) {
          await sleep(450 + attempt * 450);
          continue;
        }
        j = { ok: false, error: "swap_failed", message: safeStr(e?.message || e) };
        break;
      }
    }

    if (!res || !(res as any).ok || !j?.ok) {
      // If the executor returned a "swap_failed"-style error, one common cause is attempting to swap the *entire*
      // input balance when the effective spendable amount is slightly lower (rounding/fees/withheld extensions).
      // Before we declare failure, do one extra best-effort attempt with a slightly reduced amount.
      try {
        const errCode = safeStr(j?.error || j?.reason || "").toLowerCase();
        const tryReduce =
          errCode === "swap_failed" ||
          errCode === "no_route" ||
          errCode === "amount_too_small" ||
          errCode === "insufficient_funds";

        if (tryReduce) {
          const orig = /^[0-9]+$/.test(String(amountInAtoms)) ? BigInt(String(amountInAtoms)) : 0n;
          if (orig > 2n) {
            // 0.5% haircut, and always strictly smaller than orig.
            let next = (orig * 995n) / 1000n;
            if (next <= 0n) next = orig - 1n;
            if (next >= orig) next = orig - 1n;

            if (next > 0n && next < orig) {
              stage = "execute_swap_reduced_amount";
              const out2 = await execOnce(28_000, { ...body, amountIn: String(next) });
              const status2 = Number((out2.res as any)?.status || 0);
              const j2 = out2.j;

              // Busy-but-queued counts as accepted (same semantics as above).
              if (
                status2 === 429 &&
                safeStr(j2?.error || "").toLowerCase() === "busy" &&
                !!j2?.queued
              ) {
                return json(202, {
                  ok: true,
                  queued: true,
                  jobId: j2?.jobId || undefined,
                  message: safeStr(j2?.message || "Swap queued for retry."),
                });
              }

              if ((out2.res as any)?.ok && j2?.ok) {
                res = out2.res;
                j = j2;
              }
            }
          }
        }
      } catch {}

      // If we still failed to get a success response, check for late-confirmed swap before returning failure.
      const lateOk = await postCheckLateSwap();
      if (!lateOk) {
        const err = safeStr(j?.error || "swap_failed");
        return json(502, { ok: false, error: err, stage: lastErrStage, rpcUrl, diag: j?.diag ?? null });
      }
      // Late success: proceed as success, but preserve any diagnostic payload we got.
      j = { ...(j || {}), ok: true, late: true };
    }

    stage = "log_event";
    try {
      // compute out delta using the same authority ATAs we already resolved above (matches ingest semantics)
      let outDeltaAtoms: string | null = null;
      try {
        const outAta = direction === "buy" ? aAta : bAta; // buy: outMint=A => aAta; sell: outMint=B => bAta
        const outBeforeAtoms = direction === "buy" ? aAtoms : bAtoms;
        const outAfter = (await readAtaAmountRobust(conn, outAta)).amount;
        const d = BigInt(outAfter || "0") - BigInt(outBeforeAtoms || "0");
        outDeltaAtoms = d > 0n ? d.toString() : null;
      } catch {}

      await logWebhookStyleSwapEvent({
        redis,
        pushRecentEvent,
        set,
        kind: direction,
        owner,
        vault: vault.toBase58(),
        inMint,
        outMint,
        amountInAtoms: String(amountInAtoms),
        outDeltaAtoms,
        res: j,
        res0: null,
        ingestId: null,
      });
    } catch (e: any) {
      // best-effort only; do not fail the swap if logging fails
      console.warn("[manual-swap] event log failed", String(e?.message || e));
    }

    stage = "done";
    await sleep(350);
    return json(200, { ok: true, direction, inMint, outMint, amountIn: String(amountInAtoms), signature: j?.signature || null });

  } catch (e: any) {
    const msg = safeStr(e?.message || "internal_error");
    console.error("[manual-swap] error", { stage, rpcUrl, msg });
    return json(500, { ok: false, error: msg, stage, rpcUrl });
  }
}
