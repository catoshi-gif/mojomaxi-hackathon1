// File: src/app/api/admin/overview/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { zrevrangeWithScores, get, pipeline } from "@/lib/admin-redis";

export const runtime = "nodejs";

const ADMIN_COOKIE = "mm_admin_jwt";
const INTERNAL_ENV_KEYS = ['X_MM_INTERNAL_TOKEN','MM_INTERNAL_TOKEN','INTERNAL_SHARED_SECRET'] as const;

function b64urlToBuffer(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function safeJsonParse<T = any>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}
function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function timingSafeEq(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return a === b;
  }
}
function hasInternalBearer(req: NextRequest): boolean {
  const auth = (req.headers.get('authorization') || '').trim();
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const headerToken = (req.headers.get('x-mm-internal-token') || '').trim();
  const provided = bearer || headerToken;
  if (!provided) return false;
  for (const k of INTERNAL_ENV_KEYS) {
    const v = (process.env as any)[k];
    if (typeof v === 'string' && v.trim() && timingSafeEq(provided, v.trim())) return true;
  }
  return false;
}
async function verifyAdminJWTFromRequest(req: NextRequest): Promise<{ ok: boolean; sub?: string; payload?: any }> {
  const cookie = req.cookies.get(ADMIN_COOKIE)?.value || '';
  if (!cookie) return { ok: false };
  const [h, p, s] = cookie.split('.');
  if (!h || !p || !s) return { ok: false };
  const data = `${h}.${p}`;
  const jwtSecret = process.env.ADMIN_JWT_SECRET || '';
  if (!jwtSecret) return { ok: false };
  const sig = crypto.createHmac('sha256', jwtSecret).update(data).digest();
  const expected = base64UrlEncode(sig);
  if (!timingSafeEq(expected, s)) return { ok: false };
  const payload = safeJsonParse<any>(Buffer.from(b64urlToBuffer(p)).toString('utf-8')) || {};
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now > payload.exp) return { ok: false };
  if (payload.role !== 'admin' || payload.mfa !== true) return { ok: false };
  const epoch = String(process.env.ADMIN_SESSION_EPOCH || '0');
  if (String(payload.epoch || '') !== epoch) return { ok: false };
  return { ok: true, sub: String(payload.sub || ''), payload };
}

type LeaderboardRow = { wallet: string; points: number };
type EquityRow = { setId: string; equityUsd: number; wallet?: string; label?: string };
type PnlRow = { setId: string; realizedUsd: number; wallet?: string; label?: string };

function toWalletRows(pairs: Array<{ member: string; score: number }>): LeaderboardRow[] {
  return pairs.map(({ member, score }) => ({ wallet: member, points: score }));
}

export async function GET(req: NextRequest) {

  // Admin guard: allow either internal bearer token or a valid admin JWT cookie
  if (!hasInternalBearer(req)) {
    const v = await verifyAdminJWTFromRequest(req);
    if (!v.ok) {
      // Hide existence from unauthenticated callers in production
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
  }

  try {
    // Fire all independent Redis queries in parallel (was: 3 sequential + 1 parallel + 2 sequential).
    const [lifetime, seasonId, equityPairs, pnlPairs, statusCounts, rpcHealth, dexHealth, volume24h, tokens24h] =
      await Promise.all([
        zrevrangeWithScores("mm:mojopoints:leaderboard", 0, 99),
        get("mm:mojopoints:season:current"),
        zrevrangeWithScores("mm:admin:equityTop", 0, 9),
        zrevrangeWithScores("mm:admin:pnlTop", 0, 9),
        get("mm:admin:statusCounts"),
        get("mm:admin:rpcHealth"),
        get("mm:admin:dexHealth"),
        get("mm:admin:volume24h"),
        get("mm:admin:tokens24h"),
      ]);

    // Season leaderboard depends on seasonId, so it stays sequential.
    const season = (typeof seasonId === "string" && seasonId)
      ? await zrevrangeWithScores(`mm:mojopoints:s:${seasonId}:lb`, 0, 99)
      : [];

    // hydrate meta for top sets
    const equityTop: EquityRow[] = [];
    const pnlTop: PnlRow[] = [];
    const metaKeys: string[] = [];
    for (const e of equityPairs) metaKeys.push(`mm:admin:meta:${e.member}`);
    for (const p of pnlPairs) metaKeys.push(`mm:admin:meta:${p.member}`);

    const metaMap: Record<string, any> = {};
    if (metaKeys.length > 0) {
      const cmds = metaKeys.map(k => ["GET", k] as (string | number)[]);
      const results = await pipeline(cmds);
      results.forEach((val, idx) => {
        const key = metaKeys[idx];
        try { metaMap[key] = typeof val === "string" ? JSON.parse(val) : val; }
        catch { metaMap[key] = val; }
      });
    }

    const equityTopRows: EquityRow[] = equityPairs.map(({ member, score }) => {
      const meta = metaMap[`mm:admin:meta:${member}`] || {};
      return { setId: member, equityUsd: Number(score || 0), wallet: meta.wallet, label: meta.label };
    });
    const pnlTopRows: PnlRow[] = pnlPairs.map(({ member, score }) => {
      const meta = metaMap[`mm:admin:meta:${member}`] || {};
      return { setId: member, realizedUsd: Number(score || 0), wallet: meta.wallet, label: meta.label };
    });

    return NextResponse.json({
      ok: true,
      topLifetime: toWalletRows(lifetime),
      topSeason: toWalletRows(season),
      equityTop: equityTopRows,
      pnlTop: pnlTopRows,
      statusCounts: statusCounts || { running: 0, paused: 0, stopped: 0, unknown: 0 },
      volume24h,
      tokens24h,
      health: { upstash: { ok: true }, rpc: rpcHealth || { ok: true }, dex: dexHealth || { ok: true } },
    });
  } catch (e: any) {
    console.error("admin/overview error:", e);
    return NextResponse.json({ ok: false, error: "Failed to load admin data" }, { status: 500 });
  }
}
