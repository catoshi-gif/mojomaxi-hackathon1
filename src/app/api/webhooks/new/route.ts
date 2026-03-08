import type { NextRequest } from "next/server";
import { redis } from "@/lib/redis";
import { NextResponse } from "next/server";
import { requireOwnerSession } from "@/lib/auth/guards";
import { createSet, ensureSetHasIds, kvConfigured, getSetById } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- Idempotency helpers (Upstash Redis) ----

/** ---- Daily create rate limiting ----
 * Tracks per-wallet create events in a ZSET: mm:wallet:<wallet_lower>:creates
 * We prune entries older than 24h, then reserve a slot by ZADD(now, member).
 * If the post-insert count exceeds the limit, we rollback (ZREM) and throw.
 */
const WINDOW_SEC = Number.parseInt(process.env.MM_CREATES_WINDOW_SEC || "", 10) || 86400;
const DEFAULT_LIMIT = Number.parseInt(process.env.MM_MAX_CREATES_PER_24H || process.env.NEXT_PUBLIC_MM_MAX_CREATES_PER_24H || "", 10) || 12;
const keyCreates = (w: string) => `mm:wallet:${(w || "").toLowerCase()}:creates`;

async function reserveDailyCreateSlot(wallet: string, limit = DEFAULT_LIMIT) {
  const key = keyCreates(wallet);
  const now = Date.now();
  const windowMs = WINDOW_SEC * 1000;
  try {
    // prune old
    await redis.zremrangebyscore(key as any, 0, now - windowMs);
  } catch {}
  try { await redis.expire(key as any, Math.max(WINDOW_SEC * 2, 2 * 86400)); } catch {}

  const member = `${now}.${Math.random().toString(36).slice(2, 10)}`;
  try { await redis.zadd(key as any, { score: now, member }); } catch {}

  let count = 0;
  try { count = Number(await redis.zcard(key as any) as any) || 0; } catch {}

  if (count > limit) {
    try { await redis.zrem(key as any, member); } catch {}
    const remaining = 0;
    const resetAt = (() => {
      try { 
        const arr = (redis as any).zrange ? null : null;
      } catch {}
      return undefined as number | undefined;
    })();
    const err: any = new Error("daily_create_limit_exceeded");
    err.status = 429;
    err.limit = limit;
    err.remaining = remaining;
    throw err;
  }

  return {
    release: async (ok: boolean) => {
      if (!ok) { try { await redis.zrem(key as any, member); } catch {} }
    },
    limit,
    remaining: Math.max(0, limit - count),
  };
}

const keyIdemp = (idem: string) => `mm:webhooks:idemp:${idem}`;

async function readIdempotentSet(idem: string): Promise<string | null> {
  try {
    const v = await redis.get<string>(keyIdemp(idem) as any);
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

async function recordIdempotentSet(idem: string, setId: string, ttlSeconds = 300): Promise<void> {
  try {
    await redis.set(keyIdemp(idem), setId, { nx: true, ex: ttlSeconds });
  } catch {
    // non-fatal
  }
}

type AnyObj = Record<string, any>;

function baseUrlFromReq(req: NextRequest): string {
  const envUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    "";
  if (envUrl) return envUrl.replace(/\/+$/, "");
  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

export async function POST(req: NextRequest) {
  try {
    const kv = kvConfigured();
    if (!kv.url || !kv.token) {
      return NextResponse.json({ ok: false, error: "kv_not_configured" }, { status: 500 });
    }

    const idemHeader = (req.headers.get("x-idempotency-key") || "").trim();
    const idem = idemHeader.length ? idemHeader : null;

    let body: AnyObj = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const wallet = String(body?.wallet || "").trim();
    const label: string | undefined = typeof body?.label === "string" ? body.label : undefined;
    const prefs: AnyObj | undefined =
      body && typeof body.prefs === "object" && body.prefs ? (body.prefs as AnyObj) : undefined;

    // Basic wallet sanity check (Solana base58 ~32..44 chars)
    if (!wallet || wallet.length < 32) {
      return NextResponse.json({ ok: false, error: "invalid_wallet" }, { status: 400 });
    }

    // Security: only the wallet owner (httpOnly session) may create sets for this wallet.
    // Client must send: header x-wallet == wallet and body.wallet == wallet.
    const owner = await requireOwnerSession(req, wallet);
    if (!owner.ok) {
      const deny = (owner as any).res ?? (owner as any).response;
      if (deny) return deny;
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    // If an idempotency key is provided and maps to an existing set, reuse it
    if (idem) {
      const priorSetId = await readIdempotentSet(idem);
      if (priorSetId) {
        const prior = await getSetById(priorSetId);
        if (prior) {
          const ensured = await ensureSetHasIds(prior);
          const base = baseUrlFromReq(req) || "";
          const urls = {
            buy: base ? `${base}/buy/${ensured.buyId}` : `/buy/${ensured.buyId}`,
            sell: base ? `${base}/sell/${ensured.sellId}` : `/sell/${ensured.sellId}`,
            legacy: {
              buy: base
                ? `${base}/api/webhooks/ingest/${ensured.buyId}`
                : `/api/webhooks/ingest/${ensured.buyId}`,
              sell: base
                ? `${base}/api/webhooks/ingest/${ensured.sellId}`
                : `/api/webhooks/ingest/${ensured.sellId}`,
            },
          };
          return NextResponse.json(
            { ok: true, setId: ensured.setId, set: { ...ensured, urls }, urls },
            { status: 200 },
          );
        }
      }
    }


    // Daily rate limit (per wallet)
    const _rl = await reserveDailyCreateSlot(wallet).catch((e: any) => e);
    if (_rl instanceof Error) {
      const limit = Number((_rl as any)?.limit ?? process.env.MM_MAX_CREATES_PER_24H ?? 12);
      const remaining = Number((_rl as any)?.remaining ?? 0);
      return NextResponse.json({ ok: false, error: "daily_create_limit_exceeded", limit, remaining }, { status: 429 });
    }
    const reservation = _rl as { release: (ok:boolean)=>Promise<void>, limit:number, remaining:number };
    // Create a new set — release reservation on failure so the rate-limit slot isn't leaked
    let ensured;
    try {
      const created = await createSet(wallet, prefs, label);
      ensured = await ensureSetHasIds(created);
    } catch (createErr) {
      try { await reservation.release(false); } catch {}
      throw createErr;
    }

    // Commit reservation (success path)
    try { await reservation.release(true); } catch {}

    // Record idempotency mapping (best-effort)
    if (idem) {
      try {
        await recordIdempotentSet(idem, ensured.setId);
      } catch {
        // ignore
      }
    }

    // Pretty + legacy URLs (backward compatibility preserved)
    const base = baseUrlFromReq(req) || "";
    const urls = {
      buy: base ? `${base}/buy/${ensured.buyId}` : `/buy/${ensured.buyId}`,
      sell: base ? `${base}/sell/${ensured.sellId}` : `/sell/${ensured.sellId}`,
      legacy: {
        buy: base
          ? `${base}/api/webhooks/ingest/${ensured.buyId}`
          : `/api/webhooks/ingest/${ensured.buyId}`,
        sell: base
          ? `${base}/api/webhooks/ingest/${ensured.sellId}`
          : `/api/webhooks/ingest/${ensured.sellId}`,
      },
    };

    return NextResponse.json(
      { ok: true, setId: ensured.setId, set: { ...ensured, urls }, urls },
      { status: 200 },
    );
  } catch (e: any) {
    const msg = (e && (e.message || e.toString())) || "unknown_error";
    return NextResponse.json({ ok: false, error: "create_failed", detail: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const base = baseUrlFromReq(req);
  return NextResponse.json({
    ok: true,
    info: "POST JSON { wallet, label?, prefs? } to create a webhook set.",
    example: {
      method: "POST",
      url: `${base}/api/webhooks/new`,
      body: { wallet: "YourWalletAddress", label: "My set", prefs: {} },
    },
  });
}
