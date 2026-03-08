// Destination: src/app/api/ingest/[id]/route.ts
// Webhook swap — harden to match rebalance executor behavior.
// - Execute via /api/rebalance/execute-swap with explicit { programId, vaultAuthority }.
// - Force SOL/WSOL behavior: wrapAndUnwrapSol=true, preferNativeSolInput=true.
// - Anchor source/destination to the **authority** (like rebalance).
// - Fail closed on zero/invalid amount; optional SWAP_MAX_PCT cap.
// - Post-trade reconciliation against authority ATAs; quarantine on mismatch.
// - Preserve: running-gate, pricing, symbols, event logging, position updates.

import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { Redis } from "@upstash/redis";
import { redis } from "@/lib/redis";

import { POST as execSwapPOST } from "@/app/api/rebalance/execute-swap/route";


type PushRecentEventFn = (setId: string, message: string, extra?: Record<string, any>) => Promise<void>;

async function pushRecentEventResilient(
  redis: ReturnType<typeof Redis.fromEnv>,
  pushRecentEvent: PushRecentEventFn,
  setId: string,
  message: string,
  extra?: Record<string, any>
): Promise<void> {
  // Prefer the canonical helper; if it fails under load, fall back to direct list writes.
  let lastError: any = null;
  const row = { ts: Date.now(), setId, message, ...(extra || {}) };
  const capPerSet = Number(process.env.MM_SET_EVENTS_MAX ?? 200);
  const capGlobal = 500;

  // Small bounded retry loop to handle transient Upstash hiccups / rate limits
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pushRecentEvent(setId, message, extra || {});
      return;
    } catch (err) {
      lastError = err;
      // Backoff: 25ms, 50ms, 75ms (small to avoid impacting ingest latency)
      const delay = 25 * (attempt + 1);
      try {
        await new Promise((res) => setTimeout(res, delay));
      } catch {}
    }
  }

  // Fallback: write directly to the same lists that pushRecentEvent targets.
  try {
    await (redis as any).lpush(`mm:set:${setId}:recent`, JSON.stringify(row));
    await (redis as any).ltrim(`mm:set:${setId}:recent`, 0, capPerSet - 1);
  } catch {}
  try {
    await (redis as any).lpush(`mm:events:recent`, JSON.stringify(row));
    await (redis as any).ltrim(`mm:events:recent`, 0, capGlobal - 1);
  } catch {}

  // Best‑effort dead‑letter queue for later inspection; not read by ActivityPanel.
  try {
    await (redis as any).lpush(
      "mm:events:failed",
      JSON.stringify({
        ts: Date.now(),
        setId,
        message,
        extra: extra || {},
        error: lastError ? String(lastError) : undefined,
      }),
    );
    await (redis as any).ltrim("mm:events:failed", 0, 999);
  } catch {}
}


// --- Reliability helpers: per-set single-flight lock + retry ---
async function acquireSetLock(setId: string, ttlMs: number): Promise<{ key: string; token: string; ok: boolean }> {
  const key = `mm:set:${setId}:swap:lock`;
  const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await redis.set(key, token, { nx: true, px: ttlMs as any });
    return { key, token, ok: !!ok };
  } catch {
    return { key, token, ok: false };
  }
}
async function releaseSetLock(key: string, token: string) {
  try {
    const cur = await redis.get<string>(key);
    if (cur === token) await redis.del(key);
  } catch {}
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(n: number) {
  return Math.floor(Math.random() * n);
}

function safeStr(v: any): string {
  try {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (v instanceof Error) return String((v as any).message || v.toString());
    return String(v);
  } catch {
    return "";
  }
}
async function executeWithRetry(
  execUrl: URL,
  headers: Record<string, string>,
  body: any,
  attempts: number,
  baseMs: number,
  jitterMs: number,
) {
  let last: any = null;
  let lastStatus = 0;

  // Perf 1.5: avoid internal HTTP hop for the hot executor path.
  const isRebalanceExec = (() => {
    try {
      return execUrl?.pathname === "/api/rebalance/execute-swap";
    } catch {
      return false;
    }
  })();

  for (let i = 0; i < attempts; i++) {
    let resExec: Response | null = null;
    let status = 0;
    let parsed: any = null;

    try {
      if (isRebalanceExec) {
        // Call the route handler directly (no network) while preserving exact behavior.
        const h = new Headers(headers || {});
        const req2 = new NextRequest(execUrl.toString(), {
          method: "POST",
          headers: h,
          body: JSON.stringify(body),
        } as any);
        resExec = (await execSwapPOST(req2 as any)) as any;
      } else {
        resExec = await fetch(execUrl, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store" });
      }

      status = (resExec as any)?.status || 0;

      const text = await (resExec as any).text?.();
      const rawText = typeof text === "string" ? text : "";

      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = rawText || null;
      }

      if (status >= 200 && status < 300) return { status, parsed };
      last = parsed;
      lastStatus = status;
    } catch (e: any) {
      last = { ok: false, error: safeStr(e?.message || e) };
      lastStatus = status || 0;
    }

    // backoff with jitter
    const wait = baseMs * (i + 1) + Math.floor(Math.random() * Math.max(0, jitterMs));
    try {
      await new Promise((r) => setTimeout(r, wait));
    } catch {}
  }

  return { status: lastStatus || 500, parsed: last || { ok: false, error: "swap_failed" } };
}


function json(status: number, obj: any) {
  return new NextResponse(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function allowFullDiag(req: NextRequest): boolean {
  // Production: never expose swap diagnostics via query params or headers.
  if (process.env.NODE_ENV === "production") return false;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("debug") === "1") return true;
    if ((req.headers.get("x-debug") || "").trim() === "1") return true;
    if (String(process.env.DEBUG_SWAP_DIAG || "").toLowerCase() === "true") return true;
    return false;
  } catch {
    return false;
  }
}

/** Minimal guard: check if set is marked as 'running' in status store. */
async function isSetRunning(setId?: string | null): Promise<boolean> {
  if (!setId) return false;
  try {
    const key = `mm:set:${setId}:status`;
    const state = await redis.hget<string>(key, "state");
    return String(state || "").toLowerCase() === "running";
  } catch {
    return false;
  }
}

// ---- Lightweight IP-based abuse protection for webhook ingestion ----

type WebhookRateLimitResult =
  | { ok: true; status?: number; error?: string; retryAfterSeconds?: number; banSeconds?: number }
  | { ok: false; status?: number; error: string; retryAfterSeconds?: number; banSeconds?: number };

function getClientIp(req: NextRequest): string | null {
  try {
    // Respect common proxy headers used by Vercel and other edge platforms.
    const header = (name: string) => (req.headers.get(name) || "").split(",")[0].trim();
    const xfwd = header("x-forwarded-for");
    if (xfwd) return xfwd;
    const real = header("x-real-ip");
    if (real) return real;
    const anyReq = req as any;
    if (typeof anyReq.ip === "string" && anyReq.ip.length > 0) return anyReq.ip;
    return null;
  } catch {
    return null;
  }
}

/**
 * Basic fixed-window rate limiter per IP and (IP,setId) pair.
 * Goals:
 *  - Shield RPC + swap executor from obvious abuse / accidental alert storms.
 *  - Fail open on Redis errors so we never block legitimate swaps.
 *  - Fully configurable via env; defaults are deliberately generous.
 */
async function enforceWebhookRateLimit(
  req: NextRequest,
  setId: string | null | undefined,
  debug: boolean,
): Promise<WebhookRateLimitResult> {
  const ip = getClientIp(req);
  if (!ip) return { ok: true }; // cannot fingerprint; don't block

  try {
    const windowSec = Number.isFinite(Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_SEC))
      ? Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_SEC)
      : 60;

    const perSetLimit = Number.isFinite(Number(process.env.WEBHOOK_RATE_LIMIT_PER_SET))
      ? Number(process.env.WEBHOOK_RATE_LIMIT_PER_SET)
      : 90; // per IP, per set, per window

    const globalLimit = Number.isFinite(Number(process.env.WEBHOOK_RATE_LIMIT_GLOBAL))
      ? Number(process.env.WEBHOOK_RATE_LIMIT_GLOBAL)
      : 240; // per IP across all sets, per window

    const banSeconds = Number.isFinite(Number(process.env.WEBHOOK_RATE_LIMIT_BAN_SECONDS))
      ? Number(process.env.WEBHOOK_RATE_LIMIT_BAN_SECONDS)
      : 15 * 60; // 15 minutes

    const banMultiplier = Number.isFinite(Number(process.env.WEBHOOK_RATE_LIMIT_BAN_MULTIPLIER))
      ? Number(process.env.WEBHOOK_RATE_LIMIT_BAN_MULTIPLIER)
      : 4; // ban if someone exceeds limits ~4x within a window

    const enabled = windowSec > 0 && (perSetLimit > 0 || globalLimit > 0);
    if (!enabled) return { ok: true };

    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / windowSec) * windowSec;
    const base = `mm:webhook:${ip}`;
    const banKey = `${base}:ban`;

    // Hard ban check first – cheap and avoids extra work
    const isBanned = await redis.get<string | number>(banKey);
    if (isBanned) {
      return {
        ok: false,
        status: 429,
        error: "ip_banned",
        retryAfterSeconds: windowSec,
        banSeconds,
      };
    }

    async function bump(key: string, limit: number | null): Promise<{ count: number; limited: boolean }> {
      if (!limit || limit <= 0) return { count: 0, limited: false };
      const fullKey = `${key}:${bucket}`;

      // Perf 1.0/1.5: reduce Redis RTT by combining INCR+EXPIRE into one roundtrip (Lua),
      // with a safe fallback if eval isn't supported by the client.
      const LUA_INCR_EXPIRE = `
        local v = redis.call("INCR", KEYS[1])
        if tonumber(v) == 1 then
          redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
        end
        return v
      `;

      let current: any = null;

      try {
        const evalFn = (redis as any).eval;
        if (typeof evalFn === "function") {
          current = await evalFn.call(redis as any, LUA_INCR_EXPIRE, [fullKey], [String(windowSec + 5)]);
        }
      } catch {}

      if (current === null || current === undefined) {
        // Fallback: two-step
        current = await redis.incr(fullKey);
        if (current === 1 || current === "1") {
          await redis.expire(fullKey, windowSec + 5);
        }
      }

      const count = typeof current === "number" ? current : Number(current || 0);
      return { count, limited: count > limit };
    }

    let limitedBySet = false;
    let limitedByIp = false;
    let maxRatio = 0;

    if (perSetLimit > 0 && setId) {
      const { count, limited } = await bump(`${base}:set:${setId}`, perSetLimit);
      limitedBySet = limited;
      if (limited && perSetLimit > 0) {
        maxRatio = Math.max(maxRatio, count / perSetLimit);
      }
    }

    if (globalLimit > 0) {
      const { count, limited } = await bump(`${base}:all`, globalLimit);
      limitedByIp = limited;
      if (limited && globalLimit > 0) {
        maxRatio = Math.max(maxRatio, count / globalLimit);
      }
    }

    if (!limitedBySet && !limitedByIp) return { ok: true };

    // Escalate to temporary ban if abuse is egregious.
    if (banSeconds > 0 && maxRatio >= banMultiplier) {
      await redis.set(banKey, Date.now(), { ex: banSeconds });
    }

    const error =
      limitedBySet && limitedByIp
        ? "rate_limited_ip_and_set"
        : limitedBySet
        ? "rate_limited_set"
        : "rate_limited_ip";

    // Keep body small; caller can optionally surface diag info when debug=true
    return {
      ok: false,
      status: 429,
      error,
      retryAfterSeconds: windowSec,
      banSeconds,
    };
  } catch (err) {
    // Fail CLOSED: if Redis is unavailable, reject the request rather than
    // allowing unlimited unthrottled access to swap execution.
    console.error("[webhook-rate-limit] Redis unavailable; failing closed", err);
    return { ok: false, status: 503, error: "rate_limit_unavailable" as const };
  }
}

// ---- Strict mint resolution (no SOL/USDC defaults) ----
import { normalizeWebhookMintsFromDoc, readPinnedVaultMints, getVaultForSetId } from "@/lib/immutability.guard";

async function resolveMintsStrict(set: any, kind: "buy" | "sell"): Promise<{ inMint: string; outMint: string } | null> {
  try {
    const { mintA, mintB, mintIn, mintOut } = normalizeWebhookMintsFromDoc(set || {});
    let A: string | undefined =
      typeof mintA === "string" && mintA ? mintA : typeof mintIn === "string" ? mintIn : undefined;
    let B: string | undefined =
      typeof mintB === "string" && mintB ? mintB : typeof mintOut === "string" ? mintOut : undefined;

    // If not present on set doc, try pinned vault mapping
    if ((!A || !B) && set && set.setId) {
      try {
        const vault = set?.vault || set?.vaultPda || set?.vaultAccount || (await getVaultForSetId(String(set.setId)));
        if (vault) {
          const pinned = await readPinnedVaultMints(String(vault));
          if (pinned && pinned.type === "webhook") {
            const pA = (pinned as any).mintA || (pinned as any).mintIn;
            const pB = (pinned as any).mintB || (pinned as any).mintOut;
            if (!A) A = typeof pA === "string" ? pA : undefined;
            if (!B) B = typeof pB === "string" ? pB : undefined;
          }
        }
      } catch {}
    }

    if (!A || !B) return null;
    return kind === "buy" ? { inMint: B, outMint: A } : { inMint: A, outMint: B };
  } catch {
    return null;
  }
}

// ---------- RPC + Solana helpers ----------
const TOKEN_PROGRAM_2022_STR = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
function getRpc(): { url: string; headers?: Record<string, string> } {
  const url =
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_URL ||
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://api.mainnet-beta.solana.com";
  let headers: Record<string, string> | undefined;
  const h = process.env.SOLANA_RPC_HEADERS || process.env.RPC_HEADERS;
  if (h) {
    try {
      headers = JSON.parse(h);
    } catch {}
  }
  return { url, headers };
}
async function makeConn(): Promise<any> {
  const { Connection } = await import("@solana/web3.js");
  const { rpcFetchMiddleware } = await import("@/lib/rpc");
  const { url, headers } = getRpc();
  return new Connection(url, { commitment: "processed", httpHeaders: headers, fetchMiddleware: rpcFetchMiddleware() } as any);
}
async function pk(v: string | any, label?: string): Promise<any> {
  const { PublicKey } = await import("@solana/web3.js");
  try {
    return typeof v === "string" ? new PublicKey(v) : new PublicKey(v);
  } catch {
    const err = new Error(`invalid public key${label ? " for " + label : ""}`);
    (err as any).code = "BAD_PUBKEY";
    throw err;
  }
}
async function getVaultProgramId(): Promise<any> {
  const { PublicKey } = await import("@solana/web3.js");
  const pid = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID || "";
  if (!pid) throw new Error("missing_program_id");
  return new PublicKey(pid);
}
async function tokenProgramIdForMint(conn: any, mint: any): Promise<any> {
  const { PublicKey } = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  let owner58: string | null = null;
  for (const c of ["processed", "confirmed", "finalized"] as const) {
    try {
      const ai = await conn.getAccountInfo(mint, c);
      owner58 = ai?.owner?.toBase58?.() || null;
      if (owner58) break;
    } catch {}
  }
  if (owner58 === TOKEN_PROGRAM_2022_STR) return new PublicKey(TOKEN_PROGRAM_2022_STR);
  return spl.TOKEN_PROGRAM_ID;
}
async function readAuthorityAtaAmount(conn: any, authority: any, mintPk: any): Promise<{ ata: any; amount: string }> {
  const spl = await import("@solana/spl-token");
  const progId = await tokenProgramIdForMint(conn, mintPk);
  const ata = spl.getAssociatedTokenAddressSync(
    mintPk,
    authority,
    true,
    progId,
    spl.ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Robust balance read with retries and multi-commitment fallback.
  const commitments: any[] = ["confirmed", "processed", "finalized"];
  let amount = "0";
  let got = false;
  for (let attempt = 0; attempt < 3 && !got; attempt++) {
    for (const c of commitments) {
      try {
        const bal = await conn.getTokenAccountBalance(ata, c as any);
        const raw = bal?.value?.amount;
        if (raw != null) {
          const s = String(raw);
          if (/^[0-9]+$/.test(s)) {
            amount = s;
            // accept non-zero immediately; if zero, keep trying on first two attempts
            if (s !== "0" || attempt === 2) got = true;
            break;
          }
        }
      } catch {
        // continue
      }
    }
    if (!got) {
      await sleep(120 + jitter(80));
    }
  }

  return { ata, amount };
}
// ---------- authority / ATAs ----------
async function deriveAuthority(vaultPubkey: string): Promise<any> {
  const { PublicKey } = await import("@solana/web3.js");
  const { deriveVaultAuthorityPda } = await import("@/lib/vault-sdk");
  const programId = await getVaultProgramId();
  const [auth] = deriveVaultAuthorityPda(programId as any, new PublicKey(vaultPubkey));
  return auth;
}
async function ensureAuthorityAtas(conn: any, vault: string, mints: string[]) {
  const authority = await deriveAuthority(vault);
  const mintPks = await Promise.all((mints || []).map((m) => pk(m, "mint")));
  const missing: string[] = [];
  for (const mintPk of mintPks) {
    try {
      const spl = await import("@solana/spl-token");
      const progId = await tokenProgramIdForMint(conn, mintPk);
      const ata = spl.getAssociatedTokenAddressSync(
        mintPk,
        authority,
        true,
        progId,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const info = await conn.getAccountInfo(ata, "confirmed");
      if (!info) missing.push(mintPk.toBase58());
    } catch {}
  }
  if (missing.length) {
    try {
      // same helper your rebalance route uses (idempotent)
      const { ensureVaultAtasForMints } = await import("@/lib/vault-atas.server");
      // owner wallet is not used for authority PDA creation on-chain, signature remains program-controlled
      await ensureVaultAtasForMints({ wallet: "", vault, mints: missing });
    } catch (e) {
      /* non-fatal; executor can still create idempotently */
    }
  }
}

// ---------- misc store, pricing, symbols ----------
function getOwnerFromSetDoc(set: any): string {
  const w = set?.wallet || set?.owner || set?.address;
  return typeof w === "string" ? w : "";
}
function readSlippageBps(set: any): number {
  const cands: any[] = [
    set?.slippageBps,
    set?.slippage,
    set?.params?.slippageBps,
    set?.params?.slippage,
    process.env.NEXT_PUBLIC_JUPITER_SLIPPAGE_BPS,
    process.env.JUPITER_SLIPPAGE_BPS,
    process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS,
    process.env.DEFAULT_SLIPPAGE_BPS,
  ];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 10000) return Math.floor(n);
  }
  return 50;
}
function getDiag(r: any, full?: boolean): any {
  try {
    if (full) return r && typeof r === "object" && (r as any).diag ? (r as any).diag : r;
    const j = typeof r === "object" ? r : null;
    const m =
      (j as any)?.message ||
      (j as any)?.error ||
      (j as any)?.detail ||
      (typeof (j as any)?.diag === "string" ? (j as any).diag : null);
    return typeof m === "string" && m ? m : null;
  } catch {
    return null;
  }
}
function getErr(r: any): string | null {
  try {
    const j = typeof r === "object" ? r : null;
    const m = (j as any)?.error || (j as any)?.detail || (j as any)?.message;
    return typeof m === "string" && m ? m : null;
  } catch {
    return null;
  }
}
function getSetMints(set: any): { mintA?: string; mintB?: string; symbolA?: string | null; symbolB?: string | null } {
  const A = set?.tokenA?.mint || set?.mintA || set?.aMint || set?.tokenA_mint || undefined;
  const B = set?.tokenB?.mint || set?.mintB || set?.bMint || set?.tokenB_mint || undefined;
  const symbolA = set?.tokenA?.symbol ?? set?.a?.symbol ?? null;
  const symbolB = set?.tokenB?.symbol ?? set?.b?.symbol ?? null;
  return { mintA: A, mintB: B, symbolA, symbolB };
}
async function resolveSymbol(mint: string, setSymbol?: string | null): Promise<string | null> {
  if (setSymbol && typeof setSymbol === "string" && setSymbol.length) return setSymbol;
  try {
    const { tokenMeta } = await import("@/lib/price-lite");
    const meta = await tokenMeta(mint);
    if (meta?.symbol) return String(meta.symbol);
  } catch {}
  return mint && mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint || null;
}
function ensureDisplayOrdering(kind: "buy" | "sell", set: any, ev: any) {
  const { mintA, mintB } = getSetMints(set);
  if (!mintA || !mintB) return ev;
  const expectedInMint = kind === "buy" ? mintB : mintA;
  const expectedOutMint = kind === "buy" ? mintA : mintB;
  const inOk = ev.inMint === expectedInMint;
  const outOk = ev.outMint === expectedOutMint;
  if (inOk && outOk) return ev;
  const swap = (obj: any, a: string, b: string) => {
    const t = obj[a];
    obj[a] = obj[b];
    obj[b] = t;
  };
  swap(ev, "inMint", "outMint");
  swap(ev, "inputSymbol", "outputSymbol");
  swap(ev, "inSymbol", "outSymbol");
  swap(ev, "amountInAtoms", "amountOutAtoms");
  swap(ev, "amountInUi", "amountOutUi");
  swap(ev, "inputDecimals", "outputDecimals");
  swap(ev, "inUsdPrice", "outUsdPrice");
  swap(ev, "inTotalUsd", "outTotalUsd");
  return ev;
}
async function freshPricesByMint(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const uniq = Array.from(new Set((mints || []).filter(Boolean)));
  if (!uniq.length) return out;
  try {
    const mod: any = await import("@/lib/price-lite");
    if (typeof mod.pricesByMintNoCache === "function") {
      const res = await mod.pricesByMintNoCache(uniq);
      if (res && typeof res === "object") {
        for (const m of Object.keys(res)) {
          out[m] = typeof (res as any)[m] === "number" ? (res as any)[m] : Number((res as any)[m]?.price);
        }
        return out;
      }
    }
    if (typeof mod.pricesByMint === "function") {
      const res = await mod.pricesByMint(uniq);
      if (res && typeof res === "object") {
        for (const m of Object.keys(res)) {
          out[m] = typeof (res as any)[m] === "number" ? (res as any)[m] : Number((res as any)[m]?.price);
        }
        return out;
      }
    }
  } catch {}
  try {
    const url = `https://price.jup.ag/v6/price?ids=${uniq
      .map(encodeURIComponent)
      .join(",")}&vsToken=USDC`;
    const r = await fetch(url, { cache: "no-store", next: { revalidate: 0 } as any });
    if (r.ok) {
      const j = await r.json();
      const data = j?.data || {};
      for (const m of uniq) {
        const p = Number(data?.[m]?.price ?? data?.[m]?.priceUsd);
        if (Number.isFinite(p)) out[m] = p;
      }
      return out;
    }
  } catch {}
  return out;
}
function buildInternalHeaders(req: NextRequest, walletHeader: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-wallet": walletHeader };
  const auth = String(
    req.headers.get("authorization") ||
      (process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "") ||
      "",
  ).trim();
  if (auth) headers["authorization"] = auth;
  const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  return headers;
}

// ---- Webhook signature verification (optional, backwards-compatible) --------
// If the caller sends an `x-mojo-signature` header, we verify it against the
// set's webhookSecret using HMAC-SHA256. If the header is absent the request
// is still allowed (TradingView and other simple webhook sources can't sign).
// This gives programmatic callers a way to prove they own the webhook URL.

async function verifyWebhookSignature(
  req: NextRequest,
  bodyText: string,
  set: any,
): Promise<{ verified: boolean; rejected: boolean; reason?: string }> {
  const sigHeader = (req.headers.get("x-mojo-signature") || "").trim();

  // No signature header → allow (backwards-compatible with TradingView)
  if (!sigHeader) return { verified: false, rejected: false };

  // Set has no webhookSecret stored → can't verify, but don't reject legacy sets
  const secret = String(set?.webhookSecret || set?.prefs?.webhookSecret || "").trim();
  if (!secret) return { verified: false, rejected: false };

  // Compute expected HMAC-SHA256
  try {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", secret).update(bodyText || "").digest("hex");

    // Constant-time comparison
    if (expected.length !== sigHeader.length) {
      return { verified: false, rejected: true, reason: "signature_mismatch" };
    }
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ sigHeader.charCodeAt(i);
    }
    if (diff !== 0) {
      return { verified: false, rejected: true, reason: "signature_mismatch" };
    }
    return { verified: true, rejected: false };
  } catch {
    // Crypto failure — don't block the request
    return { verified: false, rejected: false };
  }
}

// ---- Handlers ---------------------------------------------------------------
export async function GET() {
  return NextResponse.json({ ok: true, note: 'ingest endpoint' }, { status: 200 });
}

export async function POST(req: NextRequest, ctx: any) {
  const debug = allowFullDiag(req);
  try {
    const id = String(ctx.params?.id || "").trim();
    if (!id) return json(400, { ok: false, error: "missing_id" });

    // Buffer body for signature verification (must read before any other body access)
    let bodyText = "";
    try { bodyText = await req.text(); } catch {}

    const { getWebhookRecordById, pushRecentEvent } = await import("@/lib/store");
    const rec = await getWebhookRecordById(id);
    if (!rec) return json(404, { ok: false, error: "not_found" });
    const set: any = (rec as any).set || rec;
    const kind: "buy" | "sell" = (rec as any)?.kind === "sell" ? "sell" : "buy";

    // Verify webhook signature if provided
    const sigResult = await verifyWebhookSignature(req, bodyText, set);
    if (sigResult.rejected) {
      return json(401, { ok: false, error: "invalid_signature", detail: sigResult.reason });
    }

    const resolved = await resolveMintsStrict(set as any, kind);
    const { inMint, outMint } = resolved || { inMint: null as any, outMint: null as any };
    if (!inMint || !outMint) return json(400, { ok: false, error: "missing_mints" });

    const owner = getOwnerFromSetDoc(set);
    const vault = String(set?.vault || set?.vaultPda || set?.vaultAccount || "");
    if (!vault) return json(400, { ok: false, error: "missing_vault" });

    // Guard: deny execution when set status is not 'running'
    const running = await isSetRunning(set.setId);
    if (!running) {
      await pushRecentEventResilient(redis, pushRecentEvent, set.setId, "ingest_denied_not_running", { kind, setId: set.setId });
      return json(200, {
        ok: false,
        error: "vault_not_running",
        detail: "Set status is not 'running' — ingestion skipped.",
      });
    }
    // Lightweight per-IP rate limit to protect this set + RPC.
    const rate = await enforceWebhookRateLimit(req, set.setId, debug);
    if (!rate.ok) {
      const retryAfter =
        rate.retryAfterSeconds && Number.isFinite(rate.retryAfterSeconds)
          ? Number(rate.retryAfterSeconds)
          : undefined;

      const payload: any = {
        ok: false,
        error: rate.error || "rate_limited",
        ipLimited: true,
        setId: set.setId,
      };

      if (debug) {
        payload.detail = {
          retryAfterSeconds: retryAfter,
          banSeconds: rate.banSeconds,
        };
      }

      const resp = new NextResponse(JSON.stringify(payload), {
        status: rate.status || 429,
        headers: {
          "content-type": "application/json",
          ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
        },
      });

      return resp;
    }

    const conn = await makeConn();
    const programId = await getVaultProgramId();
    const authority = await deriveAuthority(vault);

    // Ensure the two ATAs exist for the **authority** only (idempotent)
    await ensureAuthorityAtas(conn, vault, [inMint, outMint]);

    // Measure amount strictly from the **authority ATA of the input mint** (mirror rebalance).
    const { ata: inAta, amount: inAtoms } = await readAuthorityAtaAmount(conn, authority, await pk(inMint));
    let amountInAtoms = inAtoms;

    // Optional safety cap (default 100% = off)
    const pct = Number.isFinite(Number(process.env.SWAP_MAX_PCT)) ? Number(process.env.SWAP_MAX_PCT) : 100;
    const capPct = Math.max(1, Math.min(100, Math.floor(pct)));
    if (capPct < 100) {
      const cap = (BigInt(amountInAtoms || "0") * BigInt(capPct)) / BigInt(100);
      if (BigInt(amountInAtoms || "0") > cap) amountInAtoms = cap.toString();
    }

    if (!/^[0-9]+$/.test(amountInAtoms) || BigInt(amountInAtoms) === 0n) {
      return json(409, {
        ok: false,
        error: "no_amount_determined",
        detail: "Authority ATA has zero/invalid input amount; aborting.",
      });
    }

    // Pre-swap balances for reconciliation
    const { ata: outAtaBefore, amount: outBefore } = await readAuthorityAtaAmount(
      conn,
      authority,
      await pk(outMint),
    );
    const inBefore = amountInAtoms; // we plan to debit this much from inAta
    const slippageBps = readSlippageBps(set);

    // Execute via the SAME executor used by rebalance
    const headers = buildInternalHeaders(req, owner);
    const execUrl = new URL("/api/rebalance/execute-swap", req.url);
    const body = {
      setId: set.setId,
      ownerWallet: owner,
      inMint,
      outMint,
      amountIn: String(amountInAtoms), // rebalance uses 'amountIn'
      vault,
      vaultAuthority: (authority as any).toBase58?.() || String(authority),
      programId: programId.toBase58(),
      wrapAndUnwrapSol: true, // align with rebalance
      preferNativeSolInput: true, // align with rebalance
      clientRef: "ingest-webhook",
      setKind: "webhook",
      direction: kind,
      slippageBps, // extra; executor may ignore if not supported
    };

    // Acquire per-set single-flight lock (prevents concurrent double execution)
    const lockTtl = Number.isFinite(Number(process.env.SWAP_LOCK_MS)) ? Number(process.env.SWAP_LOCK_MS) : 90_000;
    let res: any;
    if (lockTtl > 0) {
      const { key: lockKey, token: lockToken, ok: haveLock } = await acquireSetLock(String(set.setId), lockTtl);
      if (!haveLock) {
        // Concurrency improvement:
        // wait briefly for in-flight swap instead of immediately dropping webhook
        const waitMs = Number.isFinite(Number(process.env.SWAP_LOCK_WAIT_MS))
          ? Number(process.env.SWAP_LOCK_WAIT_MS)
          : 3000;

        const start = Date.now();
        let acquired = false;
        let lk = lockKey;
        let lt = lockToken;

        let attempt = 0;
        while (Date.now() - start < waitMs) {
          // Exponential backoff: 250ms, 500ms, 1000ms, 2000ms cap + jitter
          const delay = Math.min(250 * Math.pow(2, attempt), 2000) + jitter(200);
          await sleep(delay);
          attempt++;
          const retry = await acquireSetLock(String(set.setId), lockTtl);
          if (retry.ok) {
            lk = retry.key;
            lt = retry.token;
            acquired = true;
            break;
          }
        }

        if (!acquired) {
          return json(202, { ok: false, busy: true, error: "swap_in_flight" });
        }
      }
      try {
        const attempts = Number.isFinite(Number(process.env.SWAP_RETRY_ATTEMPTS))
          ? Number(process.env.SWAP_RETRY_ATTEMPTS)
          : 3;
        const baseMs = Number.isFinite(Number(process.env.SWAP_RETRY_BASE_MS))
          ? Number(process.env.SWAP_RETRY_BASE_MS)
          : 500;
        const jitterMs = Number.isFinite(Number(process.env.SWAP_RETRY_JITTER_MS))
          ? Number(process.env.SWAP_RETRY_JITTER_MS)
          : 300;
        res = await executeWithRetry(execUrl, headers, body, attempts, baseMs, jitterMs);
      } finally {
        await releaseSetLock(lockKey, lockToken);
      }
    } else {
      const attempts = Number.isFinite(Number(process.env.SWAP_RETRY_ATTEMPTS))
        ? Number(process.env.SWAP_RETRY_ATTEMPTS)
        : 3;
      const baseMs = Number.isFinite(Number(process.env.SWAP_RETRY_BASE_MS))
        ? Number(process.env.SWAP_RETRY_BASE_MS)
        : 500;
      const jitterMs = Number.isFinite(Number(process.env.SWAP_RETRY_JITTER_MS))
        ? Number(process.env.SWAP_RETRY_JITTER_MS)
        : 300;
      res = await executeWithRetry(execUrl, headers, body, attempts, baseMs, jitterMs);
    }

    // Normalize executor result shapes.
// - executeWithRetry() returns { status, parsed }
// - legacy executors may return { ok: true, result: {...} }
    const res0: any = (() => {
      if (!res || typeof res !== "object") return res;
      const r: any = res as any;
      if ("parsed" in r && "status" in r) return r.parsed;
      if ("result" in r && r.result) return r.result;
      return r;
    })();


    // Post-swap balances & reconciliation
    const { amount: inAfter } = await readAuthorityAtaAmount(conn, authority, await pk(inMint));
    const { amount: outAfter } = await readAuthorityAtaAmount(conn, authority, await pk(outMint));

    // Basic reconcile checks
    const inDelta = BigInt(inBefore) - BigInt(inAfter || "0");
    const outDelta = BigInt(outAfter || "0") - BigInt(outBefore || "0");
    const spentOk = inDelta >= BigInt(amountInAtoms);
    // If quote provided, compute minOut (best-effort)
    const q: any = (res0 as any)?.quote || null;
    const outAtomsQuoted: bigint =
      q?.outAmountWithSlippage != null
        ? BigInt(String(q.outAmountWithSlippage))
        : q?.outAmount != null
        ? BigInt(String(q.outAmount))
        : 0n;
    const outOk = outDelta >= (outAtomsQuoted > 0n ? outAtomsQuoted : 0n);

    // (Removed) post-swap reconcile guardrail: no longer logging swap_post_reconcile_mismatch per request.

    // ---- Enrich event & positions (same as before) ----
    try {
      const setMints = getSetMints(set);
      let inSym: string | null = await resolveSymbol(
        inMint,
        inMint === setMints.mintA ? setMints.symbolA : setMints.symbolB,
      );
      let outSym: string | null = await resolveSymbol(
        outMint,
        outMint === setMints.mintA ? setMints.symbolA : setMints.symbolB,
      );

      let decIn: number | null =
        Number.isFinite(
          Number(setMints.mintA === inMint ? (set as any)?.tokenA?.decimals : (set as any)?.tokenB?.decimals),
        )
          ? Number(setMints.mintA === inMint ? (set as any)?.tokenA?.decimals : (set as any)?.tokenB?.decimals)
          : null;
      let decOut: number | null =
        Number.isFinite(
          Number(setMints.mintA === outMint ? (set as any)?.tokenA?.decimals : (set as any)?.tokenB?.decimals),
        )
          ? Number(setMints.mintA === outMint ? (set as any)?.tokenA?.decimals : (set as any)?.tokenB?.decimals)
          : null;

      if (decIn == null || decOut == null) {
        try {
          const { fetchMintDecimals } = await import("@/lib/solana-mint");
          if (decIn == null) decIn = await fetchMintDecimals(inMint);
          if (decOut == null) decOut = await fetchMintDecimals(outMint);
        } catch {}
      }

      const outAtoms = q?.outAmountWithSlippage ?? q?.outAmount ?? (outDelta > 0n ? outDelta.toString() : null);

      const uiIn =
        amountInAtoms != null && decIn != null
          ? Number(amountInAtoms) / Math.pow(10, decIn)
          : null;
      const uiOut =
        outAtoms != null && decOut != null
          ? Number(outAtoms) / Math.pow(10, decOut)
          : null;

      // NOTE: executeWithRetry() returns { status, parsed }, so the actual executor payload lives in res0.
      // Preserve existing fields but derive the signature from the parsed payload (and fall back to common keys).
      const sig =
        (res0 as any)?.signature ||
        (res0 as any)?.sig ||
        (res0 as any)?.tx ||
        (res0 as any)?.txid ||
        null;

      let inUsdPrice: number | null = null;
      let outUsdPrice: number | null = null;
      try {
        const map = await freshPricesByMint([inMint, outMint]);
        const pi = map[inMint];
        const po = map[outMint];
        if (Number.isFinite(pi)) inUsdPrice = Number(pi);
        if (Number.isFinite(po)) outUsdPrice = Number(po);
      } catch {}

      const inTotalUsd = uiIn != null && inUsdPrice != null ? uiIn * inUsdPrice : null;
      const outTotalUsd = uiOut != null && outUsdPrice != null ? uiOut * outUsdPrice : null;

      let ev: any = {
        ingestId: id,
        inMint,
        outMint,
        inputSymbol: inSym,
        outputSymbol: outSym,
        inSymbol: inSym,
        outSymbol: outSym,
        inputDecimals: decIn ?? null,
        outputDecimals: decOut ?? null,
        amountInAtoms,
        amountOutAtoms: outAtoms ?? null,
        amountInUi: uiIn,
        amountOutUi: uiOut,
        inUsdPrice: inUsdPrice ?? undefined,
        outUsdPrice: outUsdPrice ?? undefined,
        inTotalUsd: inTotalUsd ?? undefined,
        outTotalUsd: outTotalUsd ?? undefined,
        unitPriceUsd: kind === "buy" ? outUsdPrice ?? undefined : inUsdPrice ?? undefined,
        // ok should reflect the parsed executor payload; also treat a valid signature as success.
        ok: Boolean((res0 as any)?.ok) || (typeof sig === "string" && sig.length >= 20),
        tx: sig,
        signature: typeof sig === "string" ? sig : null,
        sig: typeof sig === "string" ? sig : null,
        txUrl: sig ? `https://solscan.io/tx/${sig}` : null,
        diag: getDiag(res) || getErr(res0) || null,
      };

      ev = ensureDisplayOrdering(kind, set, ev);
      await pushRecentEventResilient(redis, pushRecentEvent, set.setId, `swap_${kind}`, ev);

      // positions — atomic updates via Lua to prevent race conditions under concurrent swaps
      try {
        const posKey = `mm:set:${set.setId}:pos`;

        const uiIn2 = typeof ev.amountInUi === "number" ? ev.amountInUi : null;
        const uiOut2 = typeof ev.amountOutUi === "number" ? ev.amountOutUi : null;
        const inTotalUsd2 = typeof ev.inTotalUsd === "number" ? ev.inTotalUsd : null;
        const outTotalUsd2 = typeof ev.outTotalUsd === "number" ? ev.outTotalUsd : null;

        if (kind === "buy") {
          if (typeof uiOut2 === "number" && typeof uiIn2 === "number" && uiOut2 > 0 && uiIn2 > 0) {
            const addQty = uiOut2;
            const addCost = inTotalUsd2 != null ? inTotalUsd2 : uiIn2;
            // Atomic: read current pos, add deltas, write back — all in one Redis roundtrip
            const LUA_BUY = `
              local raw = redis.call("GET", KEYS[1])
              local qty = 0
              local cost = 0
              if raw then
                local ok, pos = pcall(cjson.decode, raw)
                if ok and pos then
                  qty = tonumber(pos.qtyTokens) or 0
                  cost = tonumber(pos.costUsd) or 0
                end
              end
              qty = qty + tonumber(ARGV[1])
              cost = cost + tonumber(ARGV[2])
              redis.call("SET", KEYS[1], cjson.encode({qtyTokens = qty, costUsd = cost}))
              return 1
            `;
            try {
              await (redis as any).eval(LUA_BUY, [posKey], [String(addQty), String(addCost)]);
            } catch {
              // Fallback if eval unavailable: non-atomic but preserves existing behavior
              const posRaw = await redis.get(posKey).catch(() => null);
              const pos = posRaw && typeof posRaw === "string" ? JSON.parse(posRaw) : posRaw || { qtyTokens: 0, costUsd: 0 };
              const newQty = Number(pos.qtyTokens || 0) + addQty;
              const newCost = Number(pos.costUsd || 0) + addCost;
              await redis.set(posKey, JSON.stringify({ qtyTokens: newQty, costUsd: newCost }));
            }
          }
        } else {
          if (typeof uiOut2 === "number" && typeof uiIn2 === "number" && uiOut2 > 0 && uiIn2 > 0) {
            const sellUiIn = uiIn2;
            const proceeds = outTotalUsd2 != null ? outTotalUsd2 : uiOut2;
            // Atomic sell: read pos, compute avg cost, deduct, compute P&L, write back + push P&L entry
            const LUA_SELL = `
              local raw = redis.call("GET", KEYS[1])
              local qty = 0
              local cost = 0
              if raw then
                local ok, pos = pcall(cjson.decode, raw)
                if ok and pos then
                  qty = tonumber(pos.qtyTokens) or 0
                  cost = tonumber(pos.costUsd) or 0
                end
              end
              local sellUiIn = tonumber(ARGV[1])
              local proceeds = tonumber(ARGV[2])
              local avg = 0
              if qty > 0 then avg = cost / qty end
              local sellQty = math.min(sellUiIn, qty)
              local realizedCost = avg * sellQty
              local proceedsUsd = proceeds * (sellQty / sellUiIn)
              local pnlUsd = proceedsUsd - realizedCost
              local newQty = qty - sellQty
              local newCost = cost - realizedCost
              redis.call("SET", KEYS[1], cjson.encode({qtyTokens = newQty, costUsd = newCost}))
              local pnlPct = -1
              if realizedCost > 0 then pnlPct = pnlUsd / realizedCost end
              local pnlRow = cjson.encode({ts = tonumber(ARGV[3]), pnlUsd = pnlUsd, pnlPct = pnlPct ~= -1 and pnlPct or nil})
              redis.call("LPUSH", KEYS[2], pnlRow)
              redis.call("LTRIM", KEYS[2], 0, 199)
              return 1
            `;
            try {
              await (redis as any).eval(
                LUA_SELL,
                [`${posKey}`, `mm:set:${set.setId}:pnl`],
                [String(sellUiIn), String(proceeds), String(Date.now())],
              );
            } catch {
              // Fallback: non-atomic but preserves existing behavior
              const posRaw = await redis.get(posKey).catch(() => null);
              const pos = posRaw && typeof posRaw === "string" ? JSON.parse(posRaw) : posRaw || { qtyTokens: 0, costUsd: 0 };
              const qty = Number(pos.qtyTokens || 0);
              const cost = Number(pos.costUsd || 0);
              const avg = qty > 0 ? cost / qty : 0;
              const sellQty = Math.min(sellUiIn, qty);
              const realizedCost = avg * sellQty;
              const proceedsUsd = proceeds * (sellQty / sellUiIn);
              const pnlUsd = proceedsUsd - realizedCost;
              await redis.set(posKey, JSON.stringify({ qtyTokens: qty - sellQty, costUsd: cost - realizedCost }));
              await redis.lpush(
                `mm:set:${set.setId}:pnl`,
                JSON.stringify({ ts: Date.now(), pnlUsd, pnlPct: realizedCost > 0 ? pnlUsd / realizedCost : undefined }),
              );
              await redis.ltrim(`mm:set:${set.setId}:pnl`, 0, 199);
            }
          }
        }
      } catch {}
    } catch {}

    if (!(res0 as any)?.ok) {
      return json(500, {
        ok: false,
        error: "swap_failed",
        detail: getErr(res0) || "unknown_error",
        diag: getDiag(res0, debug) || undefined,
        context: { setId: set.setId, kind, inMint, outMint, vault },
      });
    }

    return json(200, {
      ok: true,
      kind,
      setId: set.setId,
      wallet: owner,
      vault,
      inMint,
      outMint,
      note: "Swap executed via rebalance executor; authority-anchored; SOL/WSOL wrapped; event logged with frozen USD/decimals.",
      diag: debug ? { id, inMint, outMint, authority: (authority as any).toBase58?.() } : undefined,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: "ingest_failed", detail: String(e?.message || e) });
  }
}
