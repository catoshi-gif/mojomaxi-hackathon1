// filepath: src/app/app/error.tsx
// FULL FILE REPLACEMENT for: src/app/app/error.tsx
'use client';

import * as React from 'react';
import { isAbortLike } from '@/app/_components/AbortGuard';

declare global {
  interface Window {
    __mmErrorAutoResets?: Record<string, { count: number; start: number }>;
    __mmResumeGraceUntil?: number;
    __mmLastClientError?: { when: number; kind: string; detail: string; stack?: string };
    __mmTrace?: Array<{ t: number; type: string; msg?: string; stack?: string; extra?: any }>;
  }
}

const ROUTE_KEY = 'app/app';
const WINDOW_MS = 8000;
const MAX_RESETS = 6;

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [diag, setDiag] = React.useState<any | null>(null);
  const [trace, setTrace] = React.useState<any[]>([]);
  const [env, setEnv] = React.useState<{ ua?: string; vis?: string; graceLeft?: number } | null>(null);
  const [stack, setStack] = React.useState<string>('');

  // Record this error as the last client error so diagnostics always have data.
  React.useEffect(() => {
    try {
      (window as any).__mmLastClientError = {
        when: Date.now(),
        kind: 'route-error',
        detail: String(error?.message || ''),
        stack: String((error as any)?.stack || ''),
      };
    } catch {}
  }, [error]);

  React.useEffect(() => {
    try {
      const last = (window as any).__mmLastClientError || null;
      const tr = Array.isArray((window as any).__mmTrace) ? (window as any).__mmTrace : [];
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const vis = typeof document !== 'undefined' ? document.visibilityState : '';
      const now = Date.now();
      const graceUntil = (window as any).__mmResumeGraceUntil || 0;
      const graceLeft = Math.max(0, graceUntil - now);
      setDiag(last);
      setTrace(tr.slice(-25));
      setEnv({ ua, vis, graceLeft });
      setStack(String((error as any)?.stack || ''));
    } catch {}
  }, [error]);

  // Auto-reset on transient errors or during grace window.
  React.useEffect(() => {
    const now = Date.now();
    const withinGrace = typeof window !== 'undefined' && typeof (window as any).__mmResumeGraceUntil === 'number' && now < (((window as any).__mmResumeGraceUntil as number) || 0);
    const msg = String(error?.message || '');
    const isTurnstile = /turnstile|verify-http-|verify-failed/i.test(msg);
    const isTransient = /ResizeObserver loop limit exceeded|Cannot read properties|is not a function/i.test(msg);

    if (withinGrace || isAbortLike(error) || isTurnstile || isTransient) {
      const bag = ((window as any).__mmErrorAutoResets ||= {});
      const rec = (bag[ROUTE_KEY] ||= { count: 0, start: now });
      if (now - rec.start > WINDOW_MS) { rec.count = 0; rec.start = now; }
      if (rec.count < MAX_RESETS) { rec.count++; try { reset(); } catch {} }
    }
  }, [error, reset]);

  const copy = React.useCallback(() => {
    try {
      const payload = {
        now: new Date().toISOString(),
        route: ROUTE_KEY,
        error: { message: String(error?.message || ''), stack: String((error as any)?.stack || ''), digest: (error as any)?.digest || null },
        lastClientError: (window as any).__mmLastClientError || null,
        trace: Array.isArray((window as any).__mmTrace) ? (window as any).__mmTrace : [],
        env: {
          ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          vis: typeof document !== 'undefined' ? document.visibilityState : '',
          resumeGraceUntil: (window as any).__mmResumeGraceUntil || 0,
        },
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const item = new ClipboardItem({ 'application/json': blob });
      navigator.clipboard.write([item]).catch(() => {
        navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
      });
    } catch {}
  }, [error]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 space-y-4">
      <h2 className="text-xl font-semibold">Something went wrong on this page</h2>
      <p className="text-sm text-gray-400">This looks transient. You can try again.</p>
      <div className="mt-4 flex gap-3">
        <button
          onClick={() => reset()}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:opacity-90"
        >
          Try again
        </button>
        <button
          onClick={() => (typeof window !== 'undefined' ? window.location.reload() : null)}
          className="rounded-md border border-white/20 px-4 py-2 text-sm font-medium text-white hover:bg-white/10"
        >
          Reload
        </button>
        <button
          onClick={copy}
          className="rounded-md border border-white/20 px-4 py-2 text-sm font-medium text-white hover:bg-white/10"
        >
          Copy diagnostics
        </button>
      </div>

      <section className="mt-6 rounded-md border border-white/15 bg-white/5 p-4">
        <h3 className="mb-2 font-mono text-sm">Diagnostics</h3>
        <div className="grid grid-cols-1 gap-2 text-xs">
          <div><span className="opacity-60">Error message:</span> <code>{String(error?.message || '')}</code></div>
          <div><span className="opacity-60">Visibility:</span> <code>{env?.vis || 'n/a'}</code></div>
          <div><span className="opacity-60">Resume grace left (ms):</span> <code>{String(env?.graceLeft ?? '0')}</code></div>
          <div><span className="opacity-60">User-Agent:</span> <code className="break-all">{env?.ua || 'n/a'}</code></div>
        </div>

        <div className="mt-4">
          <div className="opacity-60 text-xs mb-1">Stack</div>
          <pre className="text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded">{stack || '—'}</pre>
        </div>

        <div className="mt-4">
          <div className="opacity-60 text-xs mb-1">Last client error</div>
          <pre className="text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded">
{JSON.stringify(diag || null, null, 2)}
          </pre>
        </div>

        <div className="mt-4">
          <div className="opacity-60 text-xs mb-1">Recent timeline (last {trace.length})</div>
          <pre className="text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded">
{JSON.stringify(trace, null, 2)}
          </pre>
        </div>
      </section>
    </main>
  );
}
