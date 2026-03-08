// filepath: src/app/_components/CrashBeacon.tsx
// FULL FILE REPLACEMENT for: src/app/_components/CrashBeacon.tsx
'use client';

import * as React from 'react';

type TraceItem = { t: number; type: string; msg?: string; stack?: string; extra?: any };
const MAX_TRACE = 50;

/**
 * CrashBeacon — diagnostic only (no UI).
 * - Records last client error in window.__mmLastClientError
 * - Maintains a ring buffer window.__mmTrace of the last 50 events/errors
 * - Logs concise "[mm:crash]" lines when localStorage.mm_debug === "1"
 */
export default function CrashBeacon() {
  React.useEffect(() => {
    const verbose = () => {
      try { return localStorage.getItem('mm_debug') === '1'; } catch { return false; }
    };
    const log = (...args: any[]) => { if (verbose()) console.warn('[mm:crash]', ...args); };

    function pushTrace(ev: TraceItem) {
      try {
        const w: any = window as any;
        const arr: TraceItem[] = Array.isArray(w.__mmTrace) ? w.__mmTrace : [];
        arr.push(ev);
        while (arr.length > MAX_TRACE) arr.shift();
        w.__mmTrace = arr;
      } catch {}
    }

    function store(kind: string, reason: any) {
      try {
        const detail = typeof reason === 'string' ? reason : (reason && (reason.message || String(reason))) || '';
        const stack = reason && (reason.stack || '');
        (window as any).__mmLastClientError = { when: Date.now(), kind, detail, stack };
        pushTrace({ t: Date.now(), type: kind, msg: detail, stack });
        log(kind, detail, stack);
      } catch {}
    }

    const onRej = (e: PromiseRejectionEvent) => {
      store('unhandledrejection', (e as any).reason);
    };
    const onErr = (e: ErrorEvent) => {
      store('error', e?.error ?? e?.message);
    };
    const onVis = () => {
      const hidden = typeof document !== 'undefined' ? document.hidden : undefined;
      pushTrace({ t: Date.now(), type: 'visibility', extra: { hidden } });
      log('visibility', { hidden, at: Date.now() });
    };
    const onFocus = () => { pushTrace({ t: Date.now(), type: 'focus' }); log('focus', Date.now()); };
    const onShow = () => { pushTrace({ t: Date.now(), type: 'pageshow' }); log('pageshow', Date.now()); };

    window.addEventListener('unhandledrejection', onRej);
    window.addEventListener('error', onErr);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onShow as any);

    return () => {
      window.removeEventListener('unhandledrejection', onRej);
      window.removeEventListener('error', onErr);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onShow as any);
    };
  }, []);

  return null;
}
