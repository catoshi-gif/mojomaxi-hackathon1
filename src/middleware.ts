/* src/middleware.ts
 * Bridge trusted internal proof -> existing internal allow header.
 * Rate-limits public API endpoints via Redis (Upstash REST) to prevent abuse at scale.
 * Adds request IDs + structured logs for launch observability.
 *
 * PATCH:
 * - Make profiling method-aware so safe GET/HEAD dashboard traffic is not forced into write buckets.
 * - Give read-heavy dashboard/API paths their own scopes (/api/rpc, /api/prices, /api/vaults/status, wallet set loads).
 * - Preserve fail-open only for selected read/revenue-critical paths when Redis is degraded.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { hasTrustedInternalProof, sanitizeInternalHeaders } from '@/lib/auth/internal';
import { getOrCreateRequestId, logApiEvent } from '@/lib/observability';

const WINDOW_SEC = 60;
const DEFAULT_LIMIT = 120;

type RateLimitProfile = {
  scope: string;
  limit: number;
  failOpenOnDegraded: boolean;
  writePath: boolean;
};

function isSafeMethod(method: string): boolean {
  const m = String(method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

function isWriteNamespace(pathname: string): boolean {
  return (
    pathname.startsWith('/api/vaults') ||
    pathname.startsWith('/api/vault/') ||
    pathname.startsWith('/api/rebalance') ||
    pathname.startsWith('/api/webhooks') ||
    pathname.startsWith('/api/ingest') ||
    pathname.startsWith('/api/subs') ||
    pathname.startsWith('/api/turnstile') ||
    pathname.startsWith('/api/help/contact') ||
    pathname.startsWith('/api/closebins') ||
    pathname.startsWith('/buy/') ||
    pathname.startsWith('/sell/')
  );
}

function getRateLimitProfile(req: NextRequest): RateLimitProfile {
  const pathname = new URL(req.url).pathname;
  const method = String(req.method || 'GET').toUpperCase();
  const safeMethod = isSafeMethod(method);

  // CORS preflight / HEAD should never consume scarce write budget.
  if (method === 'OPTIONS') {
    return {
      scope: 'preflight',
      limit: Number(process.env.MM_RL_PREFLIGHT_PER_MIN) || 2400,
      failOpenOnDegraded: true,
      writePath: false,
    };
  }

  if (pathname === '/api/prices' || pathname.startsWith('/api/prices/')) {
    return {
      scope: 'prices',
      limit: Number(process.env.MM_RL_PRICES_PER_MIN) || 1200,
      failOpenOnDegraded: true,
      writePath: false,
    };
  }

  if (pathname === '/api/rpc' || pathname.startsWith('/api/rpc/')) {
    return {
      scope: 'rpc',
      limit: Number(process.env.MM_RL_RPC_PER_MIN) || 1200,
      failOpenOnDegraded: true,
      writePath: false,
    };
  }

  if (
    pathname === '/api/tokens' ||
    pathname.startsWith('/api/tokens/') ||
    pathname.startsWith('/api/token-logos')
  ) {
    return {
      scope: 'token_meta',
      limit: Number(process.env.MM_RL_TOKEN_META_PER_MIN) || 720,
      failOpenOnDegraded: true,
      writePath: false,
    };
  }

  if (pathname.startsWith('/api/vaults/status/')) {
    return {
      scope: 'vault_status',
      limit: Number(process.env.MM_RL_VAULT_STATUS_PER_MIN) || 720,
      failOpenOnDegraded: true,
      writePath: !safeMethod,
    };
  }

  if (pathname.startsWith('/api/webhooks/for/')) {
    return {
      scope: 'webhook_sets',
      limit: Number(process.env.MM_RL_WEBHOOKS_FOR_PER_MIN) || 240,
      failOpenOnDegraded: true,
      writePath: !safeMethod,
    };
  }

  if (pathname.startsWith('/api/rebalance/for/')) {
    return {
      scope: 'rebalance_sets',
      limit: Number(process.env.MM_RL_REBALANCE_FOR_PER_MIN) || 240,
      failOpenOnDegraded: true,
      writePath: !safeMethod,
    };
  }

  if (
    pathname.startsWith('/api/sets/') ||
    pathname.startsWith('/api/events/recent') ||
    pathname.startsWith('/api/vaults/stats') ||
    pathname.startsWith('/api/vaults/running-total') ||
    pathname.startsWith('/api/share') ||
    pathname.startsWith('/api/limits')
  ) {
    return {
      scope: 'dashboard_read',
      limit: Number(process.env.MM_RL_DASHBOARD_READ_PER_MIN) || 360,
      failOpenOnDegraded: true,
      writePath: !safeMethod,
    };
  }

  if (
    pathname.startsWith('/api/ingest/')
  ) {
    return {
      scope: 'ingest',
      limit: Number(process.env.MM_RL_INGEST_PER_MIN) || 600,
      failOpenOnDegraded: true,
      writePath: true,
    };
  }

  if (
    pathname === '/api/rebalance/execute-swap' ||
    pathname === '/api/vaults/execute-swap'
  ) {
    return {
      scope: 'execute_swap',
      limit: Number(process.env.MM_RL_EXECUTE_SWAP_PER_MIN) || 600,
      failOpenOnDegraded: true,
      writePath: true,
    };
  }

  if (pathname === '/api/vaults/manual-swap') {
    return {
      scope: 'manual_swap',
      limit: Number(process.env.MM_RL_MANUAL_SWAP_PER_MIN) || 240,
      failOpenOnDegraded: true,
      writePath: true,
    };
  }

  if (pathname.startsWith('/api/rebalance/finalize')) {
    return {
      scope: 'rebalance_finalize',
      limit: Number(process.env.MM_RL_REBALANCE_FINALIZE_PER_MIN) || 240,
      failOpenOnDegraded: true,
      writePath: true,
    };
  }

  if (
    pathname.startsWith('/api/health') ||
    pathname.startsWith('/api/dex') ||
    pathname.startsWith('/api/events') ||
    pathname.startsWith('/api/bootstrap') ||
    pathname.startsWith('/api/mojopoints') ||
    pathname.startsWith('/api/mojo/points') ||
    pathname.startsWith('/api/metrics') ||
    pathname.startsWith('/api/auth')
  ) {
    return {
      scope: 'read',
      limit: Number(process.env.MM_RL_READ_PER_MIN) || 240,
      failOpenOnDegraded: true,
      writePath: !safeMethod,
    };
  }

  if (safeMethod && isWriteNamespace(pathname)) {
    return {
      scope: 'safe_read',
      limit: Number(process.env.MM_RL_SAFE_READ_PER_MIN) || 300,
      failOpenOnDegraded: true,
      writePath: false,
    };
  }

  if (isWriteNamespace(pathname)) {
    return {
      scope: 'write',
      limit: Number(process.env.MM_RL_WRITE_PER_MIN) || 90,
      failOpenOnDegraded: false,
      writePath: true,
    };
  }

  return {
    scope: 'default',
    limit: DEFAULT_LIMIT,
    failOpenOnDegraded: true,
    writePath: false,
  };
}

function getClientIp(req: NextRequest): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();

  return 'unknown';
}

async function checkRateRedis(
  req: NextRequest,
): Promise<{
  allowed: boolean;
  remaining: number;
  resetMs: number;
  degraded?: boolean;
  scope: string;
  limit: number;
  writePath: boolean;
}> {
  const pathname = new URL(req.url).pathname;
  const method = String(req.method || 'GET').toUpperCase();
  const profile = getRateLimitProfile(req);
  const { limit, scope, failOpenOnDegraded, writePath } = profile;
  const bucket = Math.floor(Date.now() / 1000 / WINDOW_SEC) * WINDOW_SEC;
  const ip = getClientIp(req);
  const key = `mm:rl:${ip}:${method}:${scope}:${bucket}`;

  const redisUrl = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const redisToken = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

  if (!redisUrl || !redisToken) {
    return {
      allowed: failOpenOnDegraded,
      remaining: Math.max(0, limit - 1),
      resetMs: WINDOW_SEC * 1000,
      degraded: true,
      scope,
      limit,
      writePath,
    };
  }

  try {
    const pipelineBody = [
      ['INCR', key],
      ['EXPIRE', key, String(WINDOW_SEC + 5)],
    ];

    const res = await fetch(`${redisUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipelineBody),
    });

    if (!res.ok) {
      return {
        allowed: failOpenOnDegraded,
        remaining: failOpenOnDegraded ? Math.max(0, limit - 1) : 0,
        resetMs: WINDOW_SEC * 1000,
        degraded: true,
        scope,
        limit,
        writePath,
      };
    }

    const results: Array<{ result: number }> = await res.json();
    const count = Number(results?.[0]?.result ?? 1);
    const remaining = Math.max(0, limit - count);
    const resetMs = (bucket + WINDOW_SEC) * 1000 - Date.now();

    if (count > limit) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: Math.max(resetMs, 0),
        scope,
        limit,
        writePath,
      };
    }
    return {
      allowed: true,
      remaining,
      resetMs: Math.max(resetMs, 0),
      scope,
      limit,
      writePath,
    };
  } catch {
    return {
      allowed: failOpenOnDegraded,
      remaining: failOpenOnDegraded ? Math.max(0, limit - 1) : 0,
      resetMs: WINDOW_SEC * 1000,
      degraded: true,
      scope,
      limit,
      writePath,
    };
  }
}

export async function middleware(req: NextRequest) {
  const pathname = new URL(req.url).pathname;
  const requestId = getOrCreateRequestId(req.headers);
  const startedAt = Date.now();

  const trustedInternal = hasTrustedInternalProof(req.headers);
  const reqHeaders = sanitizeInternalHeaders(req.headers, trustedInternal);
  reqHeaders.set('x-request-id', requestId);

  if (trustedInternal || req.method === 'OPTIONS') {
    const response = NextResponse.next({ request: { headers: reqHeaders } });
    response.headers.set('X-Request-Id', requestId);
    return response;
  }

  const ip = getClientIp(req);
  const { allowed, remaining, resetMs, degraded, scope, limit, writePath } = await checkRateRedis(req);

  if (degraded) {
    logApiEvent('warn', 'middleware.rate_limit_degraded', {
      requestId,
      pathname,
      scope,
      writePath,
      ip,
    });
  }

  if (!allowed) {
    const retryAfter = Math.ceil(resetMs / 1000);
    logApiEvent('warn', 'middleware.rate_limited', {
      requestId,
      pathname,
      ip,
      scope,
      writePath,
      durationMs: Date.now() - startedAt,
    });
    return new NextResponse(
      JSON.stringify({ ok: false, error: 'rate_limited', retryAfter, requestId }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil((Date.now() + resetMs) / 1000)),
          'X-Request-Id': requestId,
        },
      },
    );
  }

  const response = NextResponse.next({ request: { headers: reqHeaders } });
  response.headers.set('X-RateLimit-Limit', String(limit));
  response.headers.set('X-RateLimit-Remaining', String(remaining));
  response.headers.set('X-Request-Id', requestId);
  return response;
}

export const config = {
  matcher: ['/api/:path*', '/buy/:path*', '/sell/:path*'],
};
