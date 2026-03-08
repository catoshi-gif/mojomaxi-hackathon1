// filepath: src/app/api/rpc/route.ts
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { clientIpFromHeaders, getOrCreateRequestId, logApiEvent, redactUrl, summarizeError } from "@/lib/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonRpcPayload = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

const PUBLIC_METHOD_ALLOWLIST = new Set<string>([
  "getAccountInfo",
  "getBalance",
  "getBlock",
  "getBlockCommitment",
  "getBlockHeight",
  "getBlockProduction",
  "getBlockTime",
  "getBlocks",
  "getBlocksWithLimit",
  "getClusterNodes",
  "getEpochInfo",
  "getEpochSchedule",
  "getFeeForMessage",
  "getFirstAvailableBlock",
  "getGenesisHash",
  "getHealth",
  "getIdentity",
  "getInflationGovernor",
  "getInflationRate",
  "getLargestAccounts",
  "getLatestBlockhash",
  "getLeaderSchedule",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPerformanceSamples",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getSlot",
  "getSlotLeader",
  "getSlotLeaders",
  "getSupply",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransaction",
  "getTransactionCount",
  "getVersion",
  "getVoteAccounts",
  "isBlockhashValid",
  "simulateTransaction",
]);

const INTERNAL_EXTRA_METHODS = new Set<string>([
  "sendTransaction",
  "sendRawTransaction",
  "requestAirdrop",
]);

function hasInternalBypass(req: Request): boolean {
  const expected = (process.env.X_MM_INTERNAL_TOKEN || process.env.MM_INTERNAL_TOKEN || "").trim();
  if (!expected) return false;

  const auth = (req.headers.get("authorization") || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerToken = (req.headers.get("x-mm-internal-token") || "").trim();

  return (bearer && bearer === expected) || (headerToken && headerToken === expected);
}

function parsePayload(raw: string): JsonRpcPayload[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed as JsonRpcPayload];
    return null;
  } catch {
    return null;
  }
}

function isAllowedMethod(method: string, internal: boolean): boolean {
  if (PUBLIC_METHOD_ALLOWLIST.has(method)) return true;
  if (internal && INTERNAL_EXTRA_METHODS.has(method)) return true;
  const extra = String(process.env.MM_RPC_ALLOWED_METHODS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(method)) return true;
  return false;
}

function methodCost(method: string, internal: boolean): number {
  if (internal && (method === "sendTransaction" || method === "sendRawTransaction")) return 20;
  if (method === "simulateTransaction") return 12;
  if (method === "getProgramAccounts") return 8;
  if (method === "getBlock" || method === "getBlocks" || method === "getBlocksWithLimit") return 6;
  if (method === "getTransaction" || method === "getSignaturesForAddress") return 4;
  if (method === "getMultipleAccounts") return 2;
  return 1;
}

export async function POST(req: Request) {
  const requestId = getOrCreateRequestId(req.headers);
  const startedAt = Date.now();
  const endpoint = process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "";
  const internal = hasInternalBypass(req);
  const ip = clientIpFromHeaders(req.headers);

  if (!endpoint) {
    return NextResponse.json(
      { ok: false, error: "missing HELIUS_RPC_URL / NEXT_PUBLIC_RPC_URL", requestId },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }

  const raw = await req.text();
  const maxKb = Number(process.env.MM_RPC_MAX_BODY_KB || 64);
  if ((raw?.length || 0) > maxKb * 1024) {
    return new NextResponse(JSON.stringify({ ok: false, error: "payload_too_large", requestId }), {
      status: 413,
      headers: { "content-type": "application/json", "X-Request-Id": requestId },
    });
  }

  const payloads = parsePayload(raw);
  if (!payloads || payloads.length === 0) {
    return new NextResponse(JSON.stringify({ ok: false, error: "invalid_json_rpc_payload", requestId }), {
      status: 400,
      headers: { "content-type": "application/json", "X-Request-Id": requestId },
    });
  }

  const maxBatch = Math.max(1, Math.min(20, Number(process.env.MM_RPC_MAX_BATCH || 10)));
  if (payloads.length > maxBatch) {
    return new NextResponse(JSON.stringify({ ok: false, error: "batch_too_large", maxBatch, requestId }), {
      status: 413,
      headers: { "content-type": "application/json", "X-Request-Id": requestId },
    });
  }

  const methods = payloads.map((p) => String(p?.method || "").trim()).filter(Boolean);
  if (!methods.length || methods.some((m) => !isAllowedMethod(m, internal))) {
    const denied = methods.filter((m) => !isAllowedMethod(m, internal));
    logApiEvent("warn", "rpc.method_denied", { requestId, ip, internal, methods, denied });
    return new NextResponse(JSON.stringify({ ok: false, error: "rpc_method_not_allowed", denied, requestId }), {
      status: 403,
      headers: { "content-type": "application/json", "X-Request-Id": requestId },
    });
  }

  if (!internal) {
    const windowSec = 60;
    const limit = Number(process.env.MM_RPC_LIMIT_PER_MIN || 1200);
    const slot = Math.floor(Date.now() / 1000 / windowSec);
    const key = `mm:ratelimit:rpc:${ip}:${slot}`;
    const cost = Math.max(1, methods.reduce((sum, method) => sum + methodCost(method, internal), 0));
    try {
      const count = Number(typeof (redis as any).incrby === "function"
        ? await (redis as any).incrby(key, cost)
        : await redis.incr(key));
      if (count === cost) await redis.expire(key, windowSec);
      if (count > limit) {
        logApiEvent("warn", "rpc.rate_limited", { requestId, ip, methods, limit, cost, batchSize: payloads.length });
        return new NextResponse(JSON.stringify({ ok: false, error: "rate_limited", requestId }), {
          status: 429,
          headers: { "content-type": "application/json", "X-Request-Id": requestId },
        });
      }
    } catch (err) {
      logApiEvent("warn", "rpc.rate_limit_degraded", { requestId, ip, methods, error: summarizeError(err) });
    }
  }

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      cache: "no-store",
    });

    const txt = await upstream.text();
    const durationMs = Date.now() - startedAt;
    logApiEvent(upstream.ok ? "info" : "warn", "rpc.proxy", {
      requestId,
      ip,
      internal,
      methods,
      batchSize: payloads.length,
      status: upstream.status,
      durationMs,
      endpoint: redactUrl(endpoint),
    });

    return new NextResponse(txt, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "X-Request-Id": requestId,
        "X-RPC-Methods": methods.join(","),
      },
    });
  } catch (err) {
    logApiEvent("error", "rpc.proxy_error", {
      requestId,
      ip,
      internal,
      methods,
      durationMs: Date.now() - startedAt,
      error: summarizeError(err),
      endpoint: redactUrl(endpoint),
    });
    return NextResponse.json(
      { ok: false, error: "rpc_upstream_failed", detail: summarizeError(err), requestId },
      { status: 502, headers: { "X-Request-Id": requestId } }
    );
  }
}
