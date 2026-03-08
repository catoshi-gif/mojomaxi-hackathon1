// Path: src/lib/auth/session.server.ts
// Purpose: Wallet ownership sessions for webhook access.
//          - Nonces are stored in Upstash Redis (5 minute TTL) to prevent replay.
//          - The long-lived session itself is an httpOnly cookie whose value is the wallet address.
//            (Wallet addresses are public on-chain; security comes from the one-time signature + httpOnly.)
//          - All server routes use getSessionWalletFromRequest(req) as the single source of truth.

import "server-only";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { NextResponse } from "next/server";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { redis } from "@/lib/redis";
import { cookies as nextCookies } from "next/headers";

const COOKIE_NAME = "mm_wallet_session";
const SIG_COOKIE_NAME = "mm_wallet_session_sig";
const NONCE_TTL_SEC = 5 * 60; // 5 minutes
const NONCE_MAX_OUTSTANDING = Number(process.env.MM_NONCE_MAX_OUTSTANDING || 5); // allow up to N concurrent device nonces per wallet
const NONCE_RL_WINDOW_SEC = Number(process.env.MM_NONCE_RL_WINDOW_SEC || 60);
const NONCE_RL_MAX_PER_WALLET = Number(process.env.MM_NONCE_RL_MAX_PER_WALLET || 10); // per wallet per window
const NONCE_RL_MAX_PER_IP = Number(process.env.MM_NONCE_RL_MAX_PER_IP || 30); // per ip per window
export const SESSION_TTL_SEC = Number(
  process.env.MM_WALLET_SESSION_TTL_SEC || 60 * 60 * 24 * 365
);
const COOKIE_DOMAIN = (process.env.MM_COOKIE_DOMAIN || "").trim(); // e.g. "mojomaxi.com"

const SIGN_APP_NAME = (process.env.MM_SIGN_APP_NAME || "Mojomaxi").trim();
const SIGN_DOMAIN = (process.env.MM_SIGN_DOMAIN || "mojomaxi.com")
  .replace(/^https?:\/\//, "")
  .trim();

function bytesToHex(u: Uint8Array): string {
  return Array.from(u)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isValidBase58Pubkey(s: string): boolean {
  try {
    const b = bs58.decode(s);
    return b.length === 32;
  } catch {
    return false;
  }
}

function newNonce(): string {
  // Simple hex nonce, opaque to callers.
  return bytesToHex(randomBytes(16));
}

// --- Session HMAC helpers (optional hardening) ---

function getSessionSigSecret(): string | null {
  const v = (process.env.WALLET_SESSION_HMAC_SECRET || "").trim();
  if (v.length < 16) return null;
  return v;
}

function signWallet(wallet: string, secret: string): string {
  const h = createHmac("sha256", secret);
  h.update(wallet);
  return h.digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function rateLimitIssueNonce(opts: { wallet: string; ip?: string | null }): Promise<{ ok: true } | { ok: false; error: "rate_limited" }> {
  const wallet = opts.wallet;
  const ip = (opts.ip || "").trim();
  const wKey = `mm:auth:rl:nonce:wallet:${wallet}`;
  try {
    const wCount = await redis.incr(wKey);
    if (wCount === 1) {
      try { await redis.expire(wKey, NONCE_RL_WINDOW_SEC); } catch { /* ignore */ }
    }
    if (wCount > NONCE_RL_MAX_PER_WALLET) return { ok: false, error: "rate_limited" };

    if (ip) {
      const ipKey = `mm:auth:rl:nonce:ip:${ip}`;
      const ipCount = await redis.incr(ipKey);
      if (ipCount === 1) {
        try { await redis.expire(ipKey, NONCE_RL_WINDOW_SEC); } catch { /* ignore */ }
      }
      if (ipCount > NONCE_RL_MAX_PER_IP) return { ok: false, error: "rate_limited" };
    }

    return { ok: true };
  } catch {
    // Fail CLOSED: if Redis is unavailable, nonces cannot be stored or verified,
    // so issuing them is meaningless. Treat as rate-limited to block issuance.
    return { ok: false, error: "rate_limited" };
  }
}

// Build the sign message shown in the wallet. This MUST match on both:
// - /api/auth/nonce (where we return message to the client for signing)
// - /api/auth/session (where we recreate the message before verifying)
export function buildSignMessage(
  wallet: string,
  nonce: string,
  ts: number
): string {
  const days = Math.max(1, Math.round(SESSION_TTL_SEC / (60 * 60 * 24)));
  const lines = [
    `${SIGN_APP_NAME} - Verify Wallet Ownership (read-only)`,
    `Domain: https://${SIGN_DOMAIN}`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued-At: ${new Date(ts).toISOString()}`,
    `Session: ${days} days (httpOnly; clears on sign out or cookie deletion)`,
  ];
  return lines.join("\n");
}


// Verify a base58-encoded Ed25519 signature over the UTF-8 bytes of `message`.
// This is used for the signMessage-based auth flow.
export function verifySolanaSignature(
  message: string,
  signatureBase58: string,
  wallet: string
): boolean {
  try {
    if (!message || !signatureBase58 || !wallet) return false;
    if (!isValidBase58Pubkey(wallet)) return false;
    const sig = bs58.decode(signatureBase58);
    if (!(sig instanceof Uint8Array) || sig.length !== 64) return false;
    const pubkey = bs58.decode(wallet);
    if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32) return false;
    const msgBytes = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(msgBytes, sig, pubkey);
  } catch {
    return false;
  }
}


// Issue a one-time nonce for a wallet and store it in Redis.
export async function issueNonce(
  wallet: string,
  opts?: { ip?: string | null }
): Promise<{
  ok: boolean;
  message?: string;
  nonce?: string;
  ts?: number;
  error?: string;
}> {
  if (!wallet || !isValidBase58Pubkey(wallet)) {
    return { ok: false, error: "invalid_wallet" };
  }

  // Rate limiting to prevent nonce spam. Multi-device is supported.
  const rl = await rateLimitIssueNonce({ wallet, ip: opts?.ip });
  if (!rl.ok) return { ok: false, error: "rate_limited" };

  const nonce = newNonce();
  const ts = Date.now();

  // Store nonce per-wallet per-nonce so multiple devices can sign concurrently.
  // Maintain a small per-wallet index to cap outstanding nonces (default: 5 devices).
  const nonceKey = `mm:auth:nonce:${wallet}:${nonce}`;
  const idxKey = `mm:auth:nonce_idx:${wallet}`;

  try {
    await redis.set(nonceKey, String(ts), { ex: NONCE_TTL_SEC });

    // Index + cap enforcement (best-effort; nonce validity is still secure without index)
    try {
      await redis.zadd(idxKey, { score: ts, member: nonce });
      try {
        await redis.expire(idxKey, NONCE_TTL_SEC + 60);
      } catch {
        // ignore
      }

      const card = await redis.zcard(idxKey);
      const max = Math.max(1, NONCE_MAX_OUTSTANDING || 5);
      if (card > max) {
        const excess = card - max;
        const old = await redis.zrange<string[]>(idxKey, 0, excess - 1);
        if (old && old.length) {
          try {
            await redis.zrem(idxKey, ...old);
          } catch {
            // ignore
          }
          for (const n of old) {
            try {
              await redis.del(`mm:auth:nonce:${wallet}:${n}`);
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
  } catch {
    return { ok: false, error: "redis_error" };
  }

  const message = buildSignMessage(wallet, nonce, ts);
  return { ok: true, message, nonce, ts };
}

export async function consumeNonce(wallet: string, nonce: string): Promise<boolean> {
  if (!wallet || !nonce) return false;
  const nonceKey = `mm:auth:nonce:${wallet}:${nonce}`;
  const idxKey = `mm:auth:nonce_idx:${wallet}`;
  try {
    const stored = await redis.get<string | null>(nonceKey);
    if (!stored) return false;

    // Consume nonce (one-time use)
    try {
      await redis.del(nonceKey);
    } catch {
      // ignore
    }
    // Best-effort remove from index
    try {
      await redis.zrem(idxKey, nonce);
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
}


// Create / refresh the wallet session cookie.
// The cookie value is the wallet address; TTL is enforced via maxAge + expires.
// If WALLET_SESSION_HMAC_SECRET is configured, an additional signature cookie
// (mm_wallet_session_sig) is set and required when reading the session.
export async function setWalletSessionCookie(
  res: NextResponse,
  wallet: string,
  opts?: { ttlSec?: number; reqHost?: string }
) {
  const ttl = Math.max(60, opts?.ttlSec ?? SESSION_TTL_SEC);
  const expires = new Date(Date.now() + ttl * 1000);

  const host = (opts?.reqHost || "").toLowerCase();
  const isLocalhost =
    !host ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.endsWith(".local");

  const cookieInit: any = {
    name: COOKIE_NAME,
    value: wallet, // wallet is public on-chain; cookie is httpOnly
    httpOnly: true,
    secure: !isLocalhost && process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: ttl,
    expires,
    path: "/",
  };

  if (
    process.env.NODE_ENV === "production" &&
    COOKIE_DOMAIN &&
    host &&
    host.endsWith(COOKIE_DOMAIN)
  ) {
    cookieInit.domain = COOKIE_DOMAIN;
  }

  res.cookies.set(cookieInit);

  // Optional HMAC signature cookie for additional integrity.
  const secret = getSessionSigSecret();
  if (secret) {
    const sig = signWallet(wallet, secret);
    const sigCookieInit: any = {
      name: SIG_COOKIE_NAME,
      value: sig,
      httpOnly: true,
      secure: !isLocalhost && process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      maxAge: ttl,
      expires,
      path: "/",
    };
    if (cookieInit.domain) {
      sigCookieInit.domain = cookieInit.domain;
    }
    res.cookies.set(sigCookieInit);
  }
}

// --- Cookie parsing helpers ---

function parseCookieValues(raw: string, name: string): string[] {
  if (!raw) return [];
  const parts = raw.split(";");
  const out: string[] = [];
  for (const p of parts) {
    const [k, ...v] = p.trim().split("=");
    if (!k || k.trim() !== name) continue;
    out.push(decodeURIComponent(v.join("=") || ""));
  }
  return out;
}

function parseCookie(raw: string, name: string): string | null {
  const vals = parseCookieValues(raw, name);
  if (!vals.length) return null;
  return vals[vals.length - 1];
}

// Core helper used by all server routes to determine wallet ownership from the cookie.
export async function getSessionWallet(req: Request): Promise<string | null> {
  try {
    const secret = getSessionSigSecret();

    // Prefer the request cookie (works in Next API routes). There may be multiple
    // mm_wallet_session cookies in play (different domains / historical formats),
    // so we gather all candidates and pick the most recent one that *looks* like
    // a valid Solana pubkey. If a signature secret is configured, we also require
    // a matching mm_wallet_session_sig cookie.
    const rawFromReq = req.headers.get("cookie") || "";
    const headerWalletVals = parseCookieValues(rawFromReq, COOKIE_NAME);
    const headerSigVals = parseCookieValues(rawFromReq, SIG_COOKIE_NAME);

    const walletCandidates: string[] = [];
    const sigCandidates: string[] = [];

    for (const v of headerWalletVals) {
      const trimmed = String(v || "").trim();
      if (trimmed) walletCandidates.push(trimmed);
    }
    for (const v of headerSigVals) {
      const trimmed = String(v || "").trim();
      if (trimmed) sigCandidates.push(trimmed);
    }

    // Also consider the Next.js cookie jar (covers middleware / RSC contexts)
    try {
      const c = await nextCookies();
      const w = c.get(COOKIE_NAME)?.value;
      const wTrimmed = typeof w === "string" ? w.trim() : "";
      if (wTrimmed) walletCandidates.push(wTrimmed);

      const s = c.get(SIG_COOKIE_NAME)?.value;
      const sTrimmed = typeof s === "string" ? s.trim() : "";
      if (sTrimmed) sigCandidates.push(sTrimmed);
    } catch {
      // ignore
    }

    if (!walletCandidates.length) return null;

    // Helper to pick the most recent non-empty signature value (if any).
    const pickLatest = (arr: string[]): string | null => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const v = arr[i];
        if (v) return v;
      }
      return null;
    };

    const sigValue = pickLatest(sigCandidates);

    // Pick the last candidate that looks like a valid Solana pubkey.
    for (let i = walletCandidates.length - 1; i >= 0; i--) {
      const w = walletCandidates[i];
      if (!w) continue;
      if (!isValidBase58Pubkey(w)) continue;

      // If no secret is configured, accept any valid pubkey (legacy behaviour).
      if (!secret) {
        return w;
      }

      // If a secret is configured, require a matching signature cookie.
      if (!sigValue) {
        // No signature present -> force re-auth
        return null;
      }
      const expected = signWallet(w, secret);
      if (safeEqual(sigValue, expected)) {
        return w;
      }

      // Signature mismatch; continue checking older candidates in case of
      // multiple cookies, but in practice user should just re-auth.
    }

    return null;
  } catch {
    return null;
  }
}

// Compatibility shim for older imports
export async function getSessionWalletFromRequest(
  req: Request
): Promise<string | null> {
  return getSessionWallet(req);
}

// Clear the wallet session cookie (sign out).
export async function clearWalletSession(res: NextResponse, req: Request) {
  // Defensive: clear cookie even if we previously used a sid-based scheme.
  try {
    const raw = req.headers.get("cookie") || "";
    const current = parseCookie(raw, COOKIE_NAME);
    if (!current) {
      // Also try clearing via the Next.js cookie jar in case the header path misses.
      try {
        const c = await nextCookies();
        const v = c.get(COOKIE_NAME)?.value;
        if (!v) {
          // nothing to clear; still send a clearing cookie to be safe
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // Clear main wallet cookie
  res.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  // Clear signature cookie (if present)
  res.cookies.set({
    name: SIG_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
}
