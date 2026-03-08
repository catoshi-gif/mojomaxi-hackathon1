// filepath: src/app/_components/AbortGuard.tsx
// FULL FILE REPLACEMENT for: src/app/_components/AbortGuard.tsx
'use client';

import * as React from 'react';

declare global {
  interface Window {
    __mmAbortGuardInstalled?: boolean;
    __mmFetchPatchInstalled?: boolean;
    __mmResumeGraceUntil?: number;
    __mmLastClientError?: { when: number; kind: string; detail: string; stack?: string };
  }
}

const RESUME_GRACE_MS = 9000; // extend grace to absorb wallet resume + BFCache quirks

export function isAbortLike(reason: any): boolean {
  try {
    if (!reason) return false;
    if (typeof DOMException !== 'undefined' && reason instanceof DOMException && reason.name === 'AbortError') return true;
    const name = (reason && (reason.name || reason.code)) || '';
    const msg = typeof reason === 'string' ? reason : String((reason && (reason.message || reason.toString && reason.toString())) || '');
    if (String(name).toLowerCase().includes('abort')) return true;
    return (
      /AbortError/i.test(msg) ||
      /aborted/i.test(msg) ||
      /The (user|operation) was aborted/i.test(msg) ||
      /The fetching process was aborted/i.test(msg) ||
      /signal was aborted/i.test(msg) ||
      /request was aborted/i.test(msg) ||
      /Failed to fetch/i.test(msg) ||
      /Network request failed/i.test(msg) ||
      /NetworkError when attempting to fetch resource/i.test(msg) ||
      /ERR_NETWORK|ERR_ABORT|ERR_HTTP_ABORTED/i.test(msg) ||
      /body stream already (used|read)/i.test(msg) ||
      /Failed to execute 'json' on 'Response'/i.test(msg) ||
      /already (read|used)/i.test(msg)
    );
  } catch { return false; }
}

function isTransientNonAbort(reason: any): boolean {
  const s = String((reason && (reason.message || reason)) || '');
  return (
    /ResizeObserver loop limit exceeded/i.test(s) ||
    /Cannot read properties of (null|undefined)/i.test(s) ||
    /undefined is not an object/i.test(s) ||
    /Failed to execute 'postMessage'/i.test(s) ||
    /turnstile|verify-http-|verify-failed/i.test(s)
  );
}

function inResumeGrace(): boolean {
  if (typeof window === 'undefined') return false;
  const until = window.__mmResumeGraceUntil || 0;
  return Date.now() < until;
}
function markResumeGrace() {
  if (typeof window === 'undefined') return;
  window.__mmResumeGraceUntil = Date.now() + RESUME_GRACE_MS;
}

/** swallow global errors:
 *  - always swallow Abort-like errors
 *  - swallow *all* errors while document is hidden
 *  - swallow during resume-grace window
 *  - swallow known transient non-abort races
 */
function installGlobalErrorSwallow() {
  if (typeof window === 'undefined' || window.__mmAbortGuardInstalled) return;
  window.__mmAbortGuardInstalled = true;

  const isHidden = () => typeof document !== 'undefined' && (document.hidden === true || document.visibilityState !== 'visible');

  const record = (kind: 'unhandledrejection' | 'error', reason: any) => {
    try {
      const detail = typeof reason === 'string' ? reason : (reason && (reason.message || String(reason))) || '';
      const stack = reason && (reason.stack || '');
      window.__mmLastClientError = { when: Date.now(), kind, detail, stack };
    } catch {}
  };

  const shouldSwallow = (reason: any) => {
    return isHidden() || inResumeGrace() || isAbortLike(reason) || isTransientNonAbort(reason);
  };

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason: any = (e && (e as any).reason) ?? null;
    record('unhandledrejection', reason);
    if (shouldSwallow(reason)) e.preventDefault();
  });

  window.addEventListener('error', (e: ErrorEvent) => {
    const reason: any = e?.error ?? e?.message;
    record('error', reason);
    if (shouldSwallow(reason)) e.preventDefault();
  });

  const onVisible = () => { if (!document.hidden) markResumeGrace(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('pageshow', onVisible as any);
}

/** queue same-origin /api/** GET/HEAD while hidden; coalesce and clone responses */
function installFetchPausePatch() {
  if (typeof window === 'undefined' || window.__mmFetchPatchInstalled) return;
  window.__mmFetchPatchInstalled = true;
  const originalFetch = window.fetch.bind(window);

  type QItem = { input: RequestInfo | URL; init?: RequestInit; resolve: (r: Response) => void; reject: (e: any) => void; signal?: AbortSignal };
  const queued = new Map<string, QItem[]>();
  const inflight = new Map<string, Promise<{ body: string; status: number; headers: [string, string][] }>>();

  const sameOrigin = (u: URL) => u.origin === window.location.origin;

  function normalizeKey(input: RequestInfo | URL, init?: RequestInit): string | null {
    try {
      const url =
        typeof input === 'string' ? new URL(input, window.location.origin)
        : input instanceof URL ? input
        : input instanceof Request ? new URL(input.url, window.location.origin)
        : null;
      if (!url) return null;
      if (!sameOrigin(url)) return null;
      const method = (init?.method || (input as any)?.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return null;
      if (!url.pathname.startsWith('/api/')) return null;
      const sp = new URLSearchParams(url.search);
      const sorted = new URLSearchParams();
      Array.from(sp.keys()).sort().forEach(k => { const v = sp.get(k); if (v !== null) sorted.set(k, v); });
      const qs = sorted.toString();
      return `${method} ${url.pathname}${qs ? `?${qs}` : ''}`;
    } catch { return null; }
  }

  function flushAll() {
    const keys = Array.from(queued.keys());
    for (const key of keys) {
      const arr = queued.get(key) || [];
      queued.delete(key);
      if (!arr.length) continue;

      let p = inflight.get(key);
      if (!p) {
        const { input, init } = arr[0];
        p = originalFetch(input as any, init)
          .then(async (r) => {
            const body = await r.text();
            const headers: [string, string][] = [];
            r.headers.forEach((v, k) => headers.push([k, v]));
            return { body, status: r.status, headers };
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, p);
      }

      p.then(({ body, status, headers }) => {
        for (const item of arr) {
          if (item.signal?.aborted) item.reject(new DOMException('Aborted', 'AbortError'));
          else item.resolve(new Response(body, { status, headers: new Headers(headers) }));
        }
      }).catch((err) => {
        for (const item of arr) item.reject(err);
      });
    }
  }

  const onVisible = () => { if (!document.hidden) { markResumeGrace(); flushAll(); } };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('pageshow', onVisible as any);

  window.fetch = (input: any, init?: RequestInit): Promise<Response> => {
    const key = normalizeKey(input, init);
    if (!key) return originalFetch(input, init);
    if (!document.hidden) return originalFetch(input, init);

    return new Promise<Response>((resolve, reject) => {
      const signal: AbortSignal | undefined = (init && init.signal) || ((typeof input === 'object' && (input as any).signal) as any);
      const item: QItem = { input, init, resolve, reject, signal };
      const list = queued.get(key);
      if (list) list.push(item); else queued.set(key, [item]);

      if (signal) {
        const onAbort = () => {
          const arr = queued.get(key);
          if (arr) {
            const idx = arr.indexOf(item);
            if (idx >= 0) arr.splice(idx, 1);
            if (!arr.length) queued.delete(key);
          }
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };
}

export default function AbortGuard() {
  React.useEffect(() => {
    installFetchPausePatch();
    installGlobalErrorSwallow();
  }, []);
  return null;
}
