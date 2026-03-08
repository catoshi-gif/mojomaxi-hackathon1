// filepath: src/components/debug/DebugConsole.tsx
'use client';

import * as React from 'react';

type Entry = { ts: number; where: string; msg: string; data?: any };

function safeStringify(value: any) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function DebugConsole() {
  const [entries, setEntries] = React.useState<Entry[]>([]);

  React.useEffect(() => {
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setEntries((prev) => [...prev, { ts: Date.now(), where: detail.where || 'unknown', msg: detail.msg || 'event', data: detail.data }]);
    };
    const onError = (ev: ErrorEvent) => {
      setEntries((prev) => [...prev, { ts: Date.now(), where: 'window', msg: 'error', data: { message: ev.message, stack: ev.error?.stack } }]);
    };
    const onUnhandled = (ev: PromiseRejectionEvent) => {
      setEntries((prev) => [...prev, { ts: Date.now(), where: 'window', msg: 'unhandledrejection', data: { reason: String(ev.reason) } }]);
    };
    window.addEventListener('mojoDebug', onEvt as EventListener);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => {
      window.removeEventListener('mojoDebug', onEvt as EventListener);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, []);

  return (
    <div className="fixed bottom-3 right-3 z-[1100] w-[380px] max-w-[90vw] rounded-lg border border-white/10 bg-black/80 p-3 text-xs text-white/80 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-white">Share Modal Debug</div>
        <button
          type="button"
          onClick={() => setEntries([])}
          className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10"
        >
          Clear
        </button>
      </div>
      <div className="max-h-[40vh] overflow-auto">
        {entries.length === 0 ? <div className="italic opacity-60">No events yet.</div> : null}
        {entries.map((e, i) => (
          <div key={i} className="mb-2 border-b border-white/5 pb-2 last:border-none last:pb-0">
            <div className="font-medium text-white/90">
              {new Date(e.ts).toLocaleTimeString()} • {e.where} • {e.msg}
            </div>
            {typeof e.data !== 'undefined' ? (
              <pre className="whitespace-pre-wrap break-words">{safeStringify(e.data)}</pre>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
