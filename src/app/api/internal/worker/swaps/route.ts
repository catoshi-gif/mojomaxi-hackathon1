// filepath: src/app/api/internal/worker/swaps/route.ts
// Internal swap worker (drains mm:swapjobs:due) for reliability under burst concurrency.
// Invoke via Vercel Cron or best-effort internal kicks.
// Auth: Authorization: Bearer CRON_SECRET OR x-vercel-protection-bypass: VERCEL_AUTOMATION_BYPASS_SECRET

import "server-only";
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { processSwapJobs } from "@/lib/swap-queue.server";
import { redis } from "@/lib/redis";

function safeStr(x: any) {
  return typeof x === "string" ? x : String(x ?? "");
}

function isInternal(req: NextRequest): boolean {
  const auth = safeStr(req.headers.get("authorization") || "").trim();
  const cron = safeStr(process.env.CRON_SECRET || "").trim();
  if (cron && auth === `Bearer ${cron}`) return true;

  const bypass = safeStr(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  const got = safeStr(req.headers.get("x-vercel-protection-bypass") || "").trim();
  if (bypass && got === bypass) return true;

  return false;
}


async function acquireWorkerLock(): Promise<boolean> {
  try {
    const ttlMs = Number(process.env.MM_SWAP_WORKER_LOCK_MS || 120_000);
    const ok = await (redis as any).set("mm:swapworker:lock", String(Date.now()), { nx: true, px: ttlMs });
    return !!ok;
  } catch {
    return false;
  }
}

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

async function handle(req: NextRequest) {
  if (!isInternal(req)) return json(404, { ok: false, error: "not_found" });

  const gotLock = await acquireWorkerLock();
  if (!gotLock) return json(200, { ok: true, skipped: true });

  const url = new URL(req.url);
  const maxJobs = Number(url.searchParams.get("max") || 10);
  const res = await processSwapJobs({ maxJobs });
  return json(200, res);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
