// File: src/app/api/admin/auth/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";

const ADMIN_COOKIE = "mm_admin_jwt";

// ====== Base64URL helpers ======
function b64urlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return Buffer.from(str, "binary").toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlEncodeString(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ====== Tiny TOTP (Google Authenticator) ======
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/g, "");
  let bits = "";
  for (const c of clean) {
    const val = B32_ALPHABET.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0, j = 0; i + 8 <= bits.length; i += 8, j++) out[j] = parseInt(bits.slice(i, i + 8), 2);
  return out;
}
function toArrayBufferCopy(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}
async function hmacSHA1(keyBytes: ArrayBuffer, msgBytes: ArrayBuffer): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgBytes);
  return new Uint8Array(sig);
}
function counterToArrayBuffer(counter: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  view.setUint32(0, hi, false);
  view.setUint32(4, lo, false);
  return buf;
}
async function totp(secretBase32: string, timeMs: number, period = 30, digits = 6): Promise<string> {
  const keyU8 = base32Decode(secretBase32);
  const keyBuf = toArrayBufferCopy(keyU8);
  const counter = Math.floor(timeMs / 1000 / period);
  const msgBuf = counterToArrayBuffer(counter);
  const hmac = await hmacSHA1(keyBuf, msgBuf);
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}
async function verifyTotp(secretBase32: string, token: string, window = 1): Promise<boolean> {
  const now = Date.now();
  token = token.trim().replace(/\s+/g, "");
  for (let w = -window; w <= window; w++) {
    const t = now + w * 30000;
    const gen = await totp(secretBase32, t);
    if (timingSafeEqual(gen, token)) return true;
  }
  return false;
}

// ====== Password verify (bcrypt optional; never statically imported) ======
async function verifyPassword(password: string): Promise<boolean> {
  const bcryptHash = process.env.ADMIN_PASSWORD_BCRYPT;
  const plain = process.env.ADMIN_PASSWORD_PLAIN; // dev fallback

  if (bcryptHash) {
    try {
      const bcrypt: any = await import("bcryptjs");
      const compare = bcrypt.compare || bcrypt.default?.compare;
      if (typeof compare !== "function") return false;
      return await compare(password, bcryptHash);
    } catch {
      return false;
    }
  }

  // Plain-text fallback: development only (never in production).
  if (plain && process.env.NODE_ENV !== "production") return timingSafeEqual(plain, password);
  return false;
}

// ====== HS256 JWT using WebCrypto (TS-safe) ======
async function signHS256JWT(payload: Record<string, any>, secret: string, opts: { sub?: string; exp?: number; iat?: number } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const body = { ...payload, iat, ...(opts.exp ? { exp: opts.exp } : {}), ...(opts.sub ? { sub: opts.sub } : {}) };
  const headerB64 = b64urlEncodeString(JSON.stringify(header));
  const payloadB64 = b64urlEncodeString(JSON.stringify(body));
  const data = `${headerB64}.${payloadB64}`;

  const keyU8 = new TextEncoder().encode(secret);
  const keyBuf = toArrayBufferCopy(keyU8);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msgU8 = new TextEncoder().encode(data);
  const msgBuf = toArrayBufferCopy(msgU8);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgBuf);
  const sigB64 = b64urlEncode(sig);

  return `${data}.${sigB64}`;
}

// ====== Admin login rate limiting ======
const ADMIN_RL_WINDOW_SEC = 900; // 15 minutes
const ADMIN_RL_MAX_ATTEMPTS = 5;

async function checkAdminRateLimit(ip: string): Promise<{ ok: boolean }> {
  const key = `mm:admin:rl:login:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      try { await redis.expire(key, ADMIN_RL_WINDOW_SEC); } catch { /* ignore */ }
    }
    return { ok: count <= ADMIN_RL_MAX_ATTEMPTS };
  } catch {
    // Fail closed: if Redis is unavailable, block admin login attempts.
    return { ok: false };
  }
}

export async function POST(req: NextRequest) {
  try {
    // Rate limit by IP before any credential checks.
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const rl = await checkAdminRateLimit(ip);
    if (!rl.ok) {
      return NextResponse.json({ ok: false, error: "Too many attempts" }, { status: 429 });
    }

    const payload = await req.json();
    const emailInput = String(payload?.email ?? "").trim();
    const passwordInput = String(payload?.password ?? "");
    const totpInput = String(payload?.totp ?? "").trim();

    const adminEmail = String(process.env.ADMIN_EMAIL || "").trim();
    if (!adminEmail) {
      return NextResponse.json({ ok: false, error: "Server not configured: ADMIN_EMAIL" }, { status: 500 });
    }
    if (!emailInput || !passwordInput || !totpInput) {
      return NextResponse.json({ ok: false, error: "Missing credentials" }, { status: 400 });
    }
    if (emailInput.toLowerCase() !== adminEmail.toLowerCase()) {
      return NextResponse.json({ ok: false, error: "Invalid email or password" }, { status: 401 });
    }

    const passOk = await verifyPassword(passwordInput);
    if (!passOk) {
      return NextResponse.json({ ok: false, error: "Invalid email or password" }, { status: 401 });
    }

    const secret = process.env.ADMIN_TOTP_SECRET_BASE32;
    if (!secret) {
      return NextResponse.json({ ok: false, error: "Server not configured: ADMIN_TOTP_SECRET_BASE32" }, { status: 500 });
    }
    const window = Number(process.env.ADMIN_TOTP_WINDOW || "1");
    const totpOk = await verifyTotp(secret, totpInput, Number.isFinite(window) ? window : 1);
    if (!totpOk) {
      return NextResponse.json({ ok: false, error: "Invalid 2FA code" }, { status: 401 });
    }

    const jwtSecret = process.env.ADMIN_JWT_SECRET;
    if (!jwtSecret) {
      return NextResponse.json({ ok: false, error: "Server not configured: ADMIN_JWT_SECRET" }, { status: 500 });
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 60 * 60 * 8;
    const epoch = process.env.ADMIN_SESSION_EPOCH || "0";

    const token = await signHS256JWT({ role: "admin", mfa: true, epoch }, jwtSecret, {
      sub: adminEmail,
      iat,
      exp,
    });

    const res = NextResponse.json({ ok: true });
    res.cookies.set({
      name: ADMIN_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 8,
    });
    return res;
  } catch (e: any) {
    console.error("[admin-auth] Login error:", e);
    return NextResponse.json({ ok: false, error: "Login failed" }, { status: 500 });
  }
}
