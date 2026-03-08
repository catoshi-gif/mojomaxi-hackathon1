// src/lib/http/mmInternal.server.ts
export function mmInternalHeaders(base?: HeadersInit): Headers {
  const h = new Headers(base || {});
  if (!h.has('accept')) h.set('accept', 'application/json');
  if (!h.has('x-mm-internal')) h.set('x-mm-internal', '1');
  const token = process.env.X_MM_INTERNAL_TOKEN || process.env.MM_INTERNAL_TOKEN || process.env.INTERNAL_GATEWAY_SECRET || '';
  if (token && !h.has('x-mm-internal-token')) h.set('x-mm-internal-token', token);
  return h;
}

export function mmInternalFetch(input: RequestInfo | URL, init?: RequestInit) {
  const headers = mmInternalHeaders(init?.headers);
  return fetch(input as any, { ...(init || {}), headers });
}
