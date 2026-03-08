import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Minimal wrapper so either /api/cron or /api/rebalance/cron can be used.
// This file is plain JS (no TypeScript annotations) to avoid build errors.

function constantTimeEq(a, b) {
  const aBuf = Buffer.from(String(a || ""));
  const bBuf = Buffer.from(String(b || ""));
  if (aBuf.length !== bBuf.length) return false;
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function getInternalSecret() {
  const keys = [
    "X_MM_INTERNAL_TOKEN",
    "MM_INTERNAL_TOKEN",
    "MOJOMAXI_INTERNAL_TOKEN",
    "INTERNAL_SHARED_SECRET",
    "INTERNAL_GATEWAY_SECRET",
    "INTERNAL_FETCH_TOKEN",
  ];
  for (const k of keys) {
    const v = (process.env[k] || "").trim();
    if (v) return v;
  }
  return "";
}

function hasInternalBypass(req) {
  const expected = getInternalSecret();
  if (!expected) return false;

  const auth = (req.headers.get("authorization") || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";

  const headerToken = (req.headers.get("x-mm-internal-token") || "").trim();
  const internalFlag = (req.headers.get("x-mm-internal") || "").trim();

  if (internalFlag === "1" && headerToken && constantTimeEq(headerToken, expected)) return true;
  if (bearer && constantTimeEq(bearer, expected)) return true;
  if (headerToken && constantTimeEq(headerToken, expected)) return true;

  return false;
}

function isAuthorized(req) {
  // In production, CRON_SECRET should be required (avoid accidental open endpoint).
  const required = (process.env.CRON_SECRET || "").trim();
  const isProd = process.env.NODE_ENV === "production";

  if (hasInternalBypass(req)) return true;

  if (isProd && !required) return false;
  if (!required) return true; // dev convenience

  const auth = (req.headers.get("authorization") || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";

  return bearer && constantTimeEq(bearer, required);
}

function buildHeaders(req) {
  const h = {};

  const auth = req.headers.get("authorization") || "";
  if (auth) h["authorization"] = auth;

  const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass) h["x-vercel-protection-bypass"] = bypass;

  // Forward internal bypass headers when present (keeps behavior aligned with /api/rebalance/*).
  const internal = req.headers.get("x-mm-internal") || "";
  const token = req.headers.get("x-mm-internal-token") || "";
  if (internal) h["x-mm-internal"] = internal;
  if (token) h["x-mm-internal-token"] = token;

  return h;
}

export async function GET(req) {
  if (!isAuthorized(req)) {
    const isProd = process.env.NODE_ENV === "production";
    const configured = !!(process.env.CRON_SECRET || "").trim();
    const status = isProd && !configured ? 500 : 401;
    return NextResponse.json(
      { ok: false, error: isProd && !configured ? "misconfigured" : "unauthorized" },
      { status }
    );
  }

  try {
    const url = new URL("/api/rebalance/cron", req.url);
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildHeaders(req),
      cache: "no-store",
    });
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(req) {
  // convenience: forward POSTs too
  return GET(req);
}
