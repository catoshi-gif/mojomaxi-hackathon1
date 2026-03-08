// Hardened replacement for src/app/api/rebalance/stop/route.ts
// - Preserves response shape and index cleanup.
// - Adds wallet-session enforcement: only the vault owner (via mm_wallet_session) can Stop from the public web.

import "server-only";
import { redis } from "@/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { getSessionWalletFromRequest } from "@/lib/auth/session.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const INDEX_KEY = "mm:rebal:index";
const KEY = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_LEGACY = (setId: string) => `REBAL_SET:${setId}`;

type AnyObj = Record<string, any>;

async function loadDoc(setId: string): Promise<AnyObj | null> {
  const keys = [KEY(setId), KEY_LEGACY(setId)];

  for (const key of keys) {
    // JSON document (preferred)
    try {
      const j = await (redis as any).json?.get?.(key);
      if (j && typeof j === "object") return j as AnyObj;
    } catch {}

    // Plain string (older fallback that stored JSON via SET)
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

async function savePatch(setId: string, patch: AnyObj): Promise<void> {
  const key = KEY(setId);
  try {
    const existing = await loadDoc(setId);
    const next = { ...(existing || {}), ...patch, id: setId };
    await (redis as any).json?.set?.(key, "$", next);
  } catch {
    try {
      const existing = await loadDoc(setId);
      const next = { ...(existing || {}), ...patch, id: setId };
      await redis.set(key, JSON.stringify(next));
    } catch {}
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const setId = String(body?.setId || "").trim();
    if (!setId) {
      return NextResponse.json(
        { ok: false, error: "missing setId" },
        { status: 400 }
      );
    }

    const sessionWallet = await getSessionWalletFromRequest(req);
    if (!sessionWallet) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 }
      );
    }

    const walletHeader =
      String(
        req.headers.get("x-wallet") ||
          req.headers.get("x-mojomaxi-wallet") ||
          req.headers.get("x-owner") ||
          ""
      )
        .trim() || null;

    const set = await loadDoc(setId);
    if (!set) {
      return NextResponse.json(
        { ok: false, error: "set_not_found" },
        { status: 404 }
      );
    }

    const owner = String(
      set?.wallet || set?.ownerWallet || set?.owner || ""
    ).trim();
    if (!owner) {
      return NextResponse.json(
        { ok: false, error: "missing_owner" },
        { status: 400 }
      );
    }

    // Both session wallet and header (if present) must agree with the set doc.
    if (walletHeader && walletHeader !== owner) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 403 }
      );
    }
    if (owner !== sessionWallet) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 403 }
      );
    }

    await savePatch(setId, {
      id: setId,
      wallet: owner,
      status: "stopped",
      updatedAt: new Date().toISOString(),
    });

    // remove from cron index
    try {
      await redis.srem(INDEX_KEY, setId);
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
