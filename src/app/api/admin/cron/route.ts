// filepath: src/app/api/admin/cron/route.ts
// Admin cron endpoint (Node runtime) — auth matches the rebalancing cron model.
// == DO NOT CHANGE UI/UX ==
// Behavior preserved; security tightened:
//  - Require CRON_SECRET in production.
//  - Authorize via Authorization: Bearer <CRON_SECRET>
//  - Optionally allow Vercel automation bypass when configured (same pattern as other internal routes).
//  - No user-agent based auth.

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { redis } from "@/lib/redis";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



async function acquireCronLock(): Promise<boolean> {
  try {
    const ok = await (redis as any).set("mm:cron:admin:lock", String(Date.now()), { nx: true, px: 110000 });
    return !!ok;
  } catch {
    return false;
  }
}

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

function getBearer(req: NextRequest): string {
  const auth = String(req.headers.get('authorization') || '').trim();
  if (!auth) return '';
  const lower = auth.toLowerCase();
  if (!lower.startsWith('bearer ')) return '';
  return auth.slice('bearer '.length).trim();
}

/**
 * Internal auth:
 * - Primary: Authorization Bearer CRON_SECRET (preferred).
 * - Secondary: Vercel automation bypass header if configured.
 *
 * NOTE: We intentionally do NOT rely on User-Agent checks in production.
 */
function isAuthorized(req: NextRequest): boolean {
  const isProd = process.env.NODE_ENV === 'production';

  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const bearer = getBearer(req);

  // Optional: allow Vercel automation bypass (same concept you already use elsewhere).
  const bypassSecret = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
  const bypassHeader = String(req.headers.get('x-vercel-protection-bypass') || '').trim();

  if (isProd && !cronSecret) return false;

  if (cronSecret && bearer === cronSecret) return true;
  if (bypassSecret && bypassHeader && bypassHeader === bypassSecret) return true;

  return false;
}

export async function GET(req: NextRequest) {
  const isProd = process.env.NODE_ENV === 'production';
  const cronSecret = String(process.env.CRON_SECRET || '').trim();

  // Mirror the “cron must be configured” posture (like your production cron routes).
  if (isProd && !cronSecret) {
    return json(500, {
      error: 'Misconfigured',
      message: 'CRON_SECRET must be set in production for /api/admin/cron.',
    });
  }

  if (!isAuthorized(req)) {
    return json(401, { error: 'Unauthorized' });
  }

  const gotLock = await acquireCronLock();
  if (!gotLock) {
    return json(200, { ok: true, skipped: true });
  }

  try {
    // TODO: Implement the actual admin cron job.
    // Keep this endpoint lightweight: read state, enqueue work, etc.
    //
    // Example (later):
    // await runAdminCronJob();

    return json(200, {
      ok: true,
      ranAt: new Date().toISOString(),
      note: 'Authorized call to /api/admin/cron (job not yet implemented).',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error';
    return json(500, { error: 'Internal Server Error', message });
  }
}
