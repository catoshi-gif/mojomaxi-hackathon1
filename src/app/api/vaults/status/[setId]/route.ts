// Hardened replacement for src/app/api/vaults/status/[setId]/route.ts
// - GET remains read-only and unauthenticated (used by UI/status widgets).
// - POST now enforces wallet-session ownership:
//   only the owner of the webhook set (via mm_wallet_session) may change status.
// - Preserves legacy key migration and response shape.
//
// Surgical addition:
// - Maintain a cheap global index for running webhook bots:
//   mm:webhooks:running:index (Redis SET of canonical setIds)
//   This lets /api/vaults/stats count running webhook bots without expensive SCAN/HGETALL.

import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getSessionWalletFromRequest } from "@/lib/auth/session.server";
import { getSetById } from "@/lib/store";

type State = "running" | "paused" | "stopped";
const VALID = new Set<State>(["running", "paused", "stopped"]);

function noStoreJsonHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store, private, must-revalidate",
    Pragma: "no-cache",
    Vary: "Cookie",
  };
}

// Normalize accepted URL forms like `set_<uuid>` or `set-<uuid>` to bare UUID
function canonicalSetId(raw: string): string {
  const s = String(raw || "").trim();
  const m = s.match(/^set[_-](.+)$/i);
  return m ? m[1] : s;
}

// If a legacy prefixed key exists, migrate its fields to the canonical key once.
async function migrateIfNeeded(canonId: string): Promise<void> {
  const legacyKey1 = `mm:set:set_${canonId}:status`;
  const legacyKey2 = `mm:set:set-${canonId}:status`;
  const canonKey = `mm:set:${canonId}:status`;

  try {
    // Prefer canonical if it already exists
    const existing = await redis
      .hgetall<Record<string, string>>(canonKey)
      .catch(() => null);
    if (existing && Object.keys(existing).length) return;

    // Try legacy 1
    const legacy1 = await redis
      .hgetall<Record<string, string>>(legacyKey1)
      .catch(() => null);
    if (legacy1 && Object.keys(legacy1).length) {
      await redis.hset(canonKey, legacy1);
      try {
        await (redis as any).del(legacyKey1);
      } catch {}
      return;
    }
    // Try legacy 2
    const legacy2 = await redis
      .hgetall<Record<string, string>>(legacyKey2)
      .catch(() => null);
    if (legacy2 && Object.keys(legacy2).length) {
      await redis.hset(canonKey, legacy2);
      try {
        await (redis as any).del(legacyKey2);
      } catch {}
      return;
    }
  } catch {
    /* best-effort */
  }
}

export async function GET(_req: NextRequest, { params }: any) {
  const canon = canonicalSetId(params.setId);
  await migrateIfNeeded(canon);

  const key = `mm:set:${canon}:status`;
  const row =
    (await redis.hgetall<Record<string, string>>(key).catch(() => null)) || {};
  const state =
    row?.state && VALID.has(row.state as State)
      ? (row.state as State)
      : "stopped";
  const updatedAt = row?.updatedAt ? Number(row.updatedAt) || null : null;

  return NextResponse.json(
    { ok: true, status: state, updatedAt },
    { headers: noStoreJsonHeaders() }
  );
}

export async function POST(req: NextRequest, { params }: any) {
  const canon = canonicalSetId(params.setId);
  await migrateIfNeeded(canon);

  const key = `mm:set:${canon}:status`;
  const body = await req.json().catch(() => ({} as any));
  const state = String(body?.status ?? body?.state ?? "")
    .trim()
    .toLowerCase() as State;
  if (!VALID.has(state)) {
    return NextResponse.json(
      { ok: false, error: "bad status" },
      { status: 400, headers: noStoreJsonHeaders() }
    );
  }

  // Enforce wallet-session ownership: only the set owner may change status.
  const sessionWallet = await getSessionWalletFromRequest(req);
  if (!sessionWallet) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: noStoreJsonHeaders() }
    );
  }

  const setDoc = await getSetById(canon);
  if (!setDoc) {
    return NextResponse.json(
      { ok: false, error: "set_not_found" },
      { status: 404, headers: noStoreJsonHeaders() }
    );
  }

  const owner = String((setDoc as any).wallet || "").trim();
  if (!owner || owner !== sessionWallet.trim()) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 403, headers: noStoreJsonHeaders() }
    );
  }

  try {
    const now = Date.now();
    const patch: Record<string, any> = { state, updatedAt: now };
    if (state === "running") patch.startedAt = now;
    if (state === "stopped") patch.stoppedAt = now;
    patch.status = state;

    await redis.hset(key, patch);

    // ---- Surgical addition: maintain running index ----
    // This is intentionally best-effort and non-blocking for correctness of status itself.
    // We only update the index after ownership/auth passes and after the status write succeeds.
    const runningIndexKey = "mm:webhooks:running:index";
    try {
      if (state === "running") {
        await (redis as any).sadd(runningIndexKey, canon);
      } else {
        await (redis as any).srem(runningIndexKey, canon);
      }
    } catch {
      // best-effort; do not fail the request if SET ops are unavailable in the client type
    }
    // -----------------------------------------------

    return NextResponse.json(
      { ok: true, status: state },
      { headers: noStoreJsonHeaders() }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "persist_error" },
      { status: 500, headers: noStoreJsonHeaders() }
    );
  }
}
