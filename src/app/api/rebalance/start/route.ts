// Hardened replacement for src/app/api/rebalance/start/route.ts
// - Preserves response shape and cron index behavior.
// - Adds wallet-session enforcement: only the vault owner (via mm_wallet_session) can Start from the public web.
// - Still accepts x-wallet/x-owner headers from the browser, but they must agree with the session + set doc.

import "server-only";
import { redis } from "@/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { getSessionWalletFromRequest } from "@/lib/auth/session.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


type Cadence = "1h" | "2h" | "6h" | "12h" | "24h";

const INDEX_KEY = "mm:rebal:index";
const WALLET_IDX = (wallet: string) => `mm:rebal:wallet:${wallet}:sets`;
const KEY = (setId: string) => `mm:rebal:set:${setId}`;
const KEY_LEGACY = (setId: string) => `REBAL_SET:${setId}`;

type AnyObj = Record<string, any>;

function cadenceToMs(c?: Cadence | string | null): number {
  const s = String(c || "").toLowerCase();
  if (s === "1h") return 1 * 60 * 60 * 1000;
  if (s === "2h") return 2 * 60 * 60 * 1000;
  if (s === "6h") return 6 * 60 * 60 * 1000;
  if (s === "12h") return 12 * 60 * 60 * 1000;
  if (s === "24h") return 24 * 60 * 60 * 1000;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n * 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000;
}

async function getSetDoc(setId: string): Promise<AnyObj | null> {
  const keys = [KEY(setId), KEY_LEGACY(setId)];
  for (const k of keys) {
    try {
      const j = await (redis as any).json?.get?.(k);
      if (j && typeof j === "object") return j as AnyObj;
    } catch {}
    try {
      const raw = await redis.get(k);
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
    const existing = await getSetDoc(setId);
    const next = { ...(existing || {}), ...patch, id: setId };
    await (redis as any).json?.set?.(key, "$", next);
  } catch {
    try {
      const existing = await getSetDoc(setId);
      const next = { ...(existing || {}), ...patch, id: setId };
      await redis.set(key, JSON.stringify(next));
    } catch {}
  }
}

async function appendFirstEquityEvent(args: {
  setId: string;
  wallet: string;
  baselineUsd: number | null;
  totalUsdSnapshot: number | null;
}) {
  const { setId, wallet, baselineUsd, totalUsdSnapshot } = args;
  const row: AnyObj = {
    type: "FIRST_REBALANCE_EQUITY",
    setId,
    wallet,
    baselineUsd,
    totalUsdSnapshot,
    createdAt: Date.now(),
  };
  const keys = [
    `mm:set:${setId}:events`,
    `mm:set:set_${setId}:events`,
    `mm:set:set-${setId}:events`,
    "mm:events:recent",
  ];
  for (const k of keys) {
    try {
      await (redis as any).lpush(k as any, JSON.stringify(row));
      await (redis as any).ltrim(
        k as any,
        0,
        k === "mm:events:recent" ? 499 : 199
      );
    } catch {}
  }
}

async function discoverVault(origin: string, setId: string, set: AnyObj): Promise<string | null> {
  const hinted = String(set?.vaultId || set?.vault || set?.vaultAddress || '').trim();
  if (hinted) return hinted;
  try {
    const res = await fetch(
      `${origin}/api/rebalance/set/${encodeURIComponent(setId)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({} as any));
    return String(j?.set?.vaultId || j?.set?.vault || j?.set?.vaultAddress || '').trim() || null;
  } catch {
    return null;
  }
}

async function fetchEquityUsd(
  origin: string,
  setId: string,
  wallet: string,
  vault: string | null
): Promise<number | null> {
  if (!wallet || !vault) return null;
  try {
    const url = `${origin}/api/rebalance/equity?s=${encodeURIComponent(
      setId
    )}&w=${encodeURIComponent(wallet)}&v=${encodeURIComponent(vault)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({} as any));
    const v =
      Number(j?.equityUsd ?? j?.equity_usd ?? j?.totalUsd ?? j?.total_usd);
    return Number.isFinite(v) ? (v as number) : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const origin = new URL(req.url).origin;
    const j = await req.json().catch(() => ({} as any));
    const setId = String(j?.setId || "").trim();
    if (!setId) {
      return NextResponse.json(
        { ok: false, error: "missing setId" },
        { status: 400 }
      );
    }

    // Wallet-session enforcement: only the owner (via mm_wallet_session) may Start.
    const sessionWallet = await getSessionWalletFromRequest(req);
    if (!sessionWallet) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 }
      );
    }

    const headerOwner =
      String(
        req.headers.get("x-wallet") ||
          req.headers.get("x-mojomaxi-wallet") ||
          req.headers.get("x-owner") ||
          ""
      )
        .trim() || null;

    const set = await getSetDoc(setId);
    if (!set) {
      return NextResponse.json(
        { ok: false, error: "set_not_found" },
        { status: 404 }
      );
    }

    const owner = String(set?.wallet || set?.owner || "").trim();
    if (!owner) {
      return NextResponse.json(
        { ok: false, error: "missing_owner" },
        { status: 400 }
      );
    }

    // Header (if present) must agree with both the set doc and the session wallet.
    if (headerOwner && headerOwner !== owner) {
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

    const cadence = (set?.cadence ||
      set?.frequency ||
      set?.freq ||
      set?.freqHours ||
      "6h") as Cadence | string;
    const nextAt = Date.now() + cadenceToMs(cadence);

    // 1) Capture baseline equity (frozen) and persist it to the set doc
    let baselineUsd: number | null = null;
    try {
      const vault = await discoverVault(origin, setId, set);
      baselineUsd = await fetchEquityUsd(origin, setId, owner, vault);
    } catch {}
    if (!Number.isFinite(baselineUsd as number)) baselineUsd = null;

    const patch: AnyObj = {
      id: setId,
      wallet: owner,
      status: "running",
      nextRebalanceAt: nextAt,
      updatedAt: new Date().toISOString(),
    };
    if (baselineUsd != null) {
      patch.startingTotalUsd = baselineUsd;
    }
    await savePatch(setId, patch);

    // 2) Append FIRST_REBALANCE_EQUITY (hidden from normal ActivityPanel)
    if (baselineUsd != null) {
      await appendFirstEquityEvent({
        setId,
        wallet: owner,
        baselineUsd,
        totalUsdSnapshot: baselineUsd,
      });
    }

    // 3) Ensure the set is discoverable by cron and wallet-scoped Activity
    try {
      await redis.sadd(INDEX_KEY, setId);
    } catch {}
    try {
      if (owner) await redis.sadd(WALLET_IDX(owner), setId);
    } catch {}

    return NextResponse.json({ ok: true, nextRebalanceAt: nextAt });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
