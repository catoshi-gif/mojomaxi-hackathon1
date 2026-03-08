// Hardened replacement for src/app/api/rebalance/run/[setId]/route.ts
// - Delegates to /api/rebalance/rebalance-now to keep core logic centralized.
// - Enforces wallet-session ownership for public calls: only the owner (via mm_wallet_session)
//   can trigger a one-off rebalance run for a given setId from the web UI.
// - Internal callers (cron / backend) may bypass the session check via CRON_SECRET /
//   VERCEL_AUTOMATION_BYPASS_SECRET, preserving existing automation behavior.

import "server-only";
import { redis } from "@/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { getSessionWalletFromRequest } from "@/lib/auth/session.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const KEY = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_LEGACY = (setId: string) => `REBAL_SET:${setId}`;

type AnyObj = Record<string, any>;

async function loadDoc(setId: string): Promise<AnyObj | null> {
  const keys = [KEY(setId), KEY_LEGACY(setId)];
  for (const key of keys) {
    // JSON (preferred)
    try {
      const j = await (redis as any).json?.get?.(key);
      if (j && typeof j === "object") return j as AnyObj;
    } catch {}

    // String (legacy JSON via SET)
    try {
      const raw = await redis.get(key);
      if (raw) {
        try {
          const parsed = JSON.parse(String(raw));
          if (parsed && typeof parsed === "object") return parsed as AnyObj;
        } catch {}
      }
    } catch {}
  }
  return null;
}

function isInternal(req: NextRequest): boolean {
  const auth = String(req.headers.get("authorization") || "").trim();
  const cron = (process.env.CRON_SECRET || "").trim();
  if (cron && auth === `Bearer ${cron}`) return true;

  const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass && String(req.headers.get("x-vercel-protection-bypass") || "").trim() === bypass) {
    return true;
  }

  return false;
}

function buildHeaders(req: NextRequest, wallet: string): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "x-wallet": wallet,
  };

  const auth = String(
    req.headers.get("authorization") ||
    (process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "") ||
    ""
  ).trim();
  if (auth) h["authorization"] = auth;

  const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass) h["x-vercel-protection-bypass"] = bypass;

  const ua = req.headers.get("user-agent");
  if (ua) h["user-agent"] = ua;
  const al = req.headers.get("accept-language");
  if (al) h["accept-language"] = al;
  const cookie = req.headers.get("cookie");
  if (cookie) h["cookie"] = cookie;

  return h;
}

export async function POST(req: NextRequest, ctx: any) {
  try {
    const { setId: rawSetId } = ctx.params || { setId: "" };
    const setId = String(rawSetId || "").trim();
    if (!setId) {
      return NextResponse.json({ ok: false, error: "missing_setId" }, { status: 400 });
    }

    const internal = isInternal(req);
    let sessionWallet: string | null = null;
    if (!internal) {
      sessionWallet = await getSessionWalletFromRequest(req);
      if (!sessionWallet) {
        return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
    }

    const set = await loadDoc(setId);
    if (!set) {
      return NextResponse.json({ ok: false, error: "set_not_found" }, { status: 404 });
    }

    const owner = String(set?.wallet || set?.ownerWallet || set?.owner || "").trim();
    if (!owner) {
      return NextResponse.json({ ok: false, error: "missing_owner" }, { status: 400 });
    }

    if (!internal && sessionWallet && owner !== sessionWallet) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
    }

    const res = await fetch(new URL("/api/rebalance/rebalance-now", req.url), {
      method: "POST",
      headers: buildHeaders(req, owner),
      body: JSON.stringify({ setId }),
      cache: "no-store",
    });

    const j = await res.json().catch(() => ({} as any));
    const status = res.ok && (j as any)?.ok ? 200 : 500;
    return NextResponse.json(j, { status });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) || "unknown" },
      { status: 500 }
    );
  }
}
