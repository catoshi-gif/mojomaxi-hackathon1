/**
 * src/lib/net/mminternalFetch.ts
 * Server-side helper to call our own endpoints with internal headers.
 * - Always sends:  x-mm-internal: '1'
 * - Also sends:    x-mm-internal-token: <secret>  (to satisfy CF Transform & any token checks)
 * - Optionally forwards Cookie/UA/Accept-Language if you pass a Request/NextRequest/Headers.
 *
 * Usage:
 *   import { mminternalFetch, buildInternalHeaders } from '@/lib/net/mminternalFetch';
 *   const res = await mminternalFetch('https://mojomaxi.com/api/webhooks/ingest/123', { method:'POST', body: JSON.stringify(payload) });
 *   // or inside a route with access to req:
 *   const res = await mminternalFetch(url, { method:'POST', headers: buildInternalHeaders(req.headers), body });
 */

type MaybeHeaders = Headers | Record<string, string> | null | undefined;

const ENV_KEYS = ['X_MM_INTERNAL_TOKEN','MM_INTERNAL_TOKEN','MOJOMAXI_INTERNAL_TOKEN','INTERNAL_SHARED_SECRET','INTERNAL_GATEWAY_SECRET'] as const;

function getSecret(): string | null {
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function buildInternalHeaders(source?: MaybeHeaders, extra?: MaybeHeaders): Headers {
  const h = new Headers(
    source instanceof Headers ? source : (source ? (source as Record<string, string>) : undefined)
  );
  const secret = getSecret();
  // Ensure internal auth headers are present
  h.set('x-mm-internal', '1');
  if (secret) h.set('x-mm-internal-token', secret);

  // Respect explicit extras last
  if (extra) {
    const e = extra instanceof Headers ? extra : (extra as Record<string, string>);
    Object.entries(e).forEach(([k, v]) => {
      if (typeof v === 'string') h.set(k, v);
    });
  }
  // Sensible defaults for JSON APIs when body is present
  if (!h.has('accept')) h.set('accept', 'application/json');
  return h;
}

export async function mminternalFetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
  const i = init || {};
  const headers = buildInternalHeaders(i.headers as any);
  return fetch(input, { ...i, headers, cache: i.cache || 'no-store' });
}
