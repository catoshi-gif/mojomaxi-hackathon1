// src/app/rebalance/[setId]/page.tsx
'use client';
/* Rebalance Set detail. Keeps UI minimal and non-invasive, reusing existing patterns:
 * - Shows the set details
 * - Provide "Rebalance now" button
 * - Surface vault address if present, else prompt to create via your existing button
 */

import React, { useEffect, useState } from 'react';

type SetRec = {
  setId: string;
  wallet: string;
  tokens: string[];
  freqHours: 2 | 6 | 12 | 24;
  status: 'active' | 'paused';
  createdAt: number;
  vault?: string;
  nextRunAt: number;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as any;
}

export default function RebalanceSetPage({ params }: any) {
  const [rec, setRec] = useState<SetRec | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ ok: true; set: SetRec }>(`/api/rebalance/set/${params.setId}`);
        setRec(res.set);
      } catch (e: any) {
        setError(e?.message || 'failed');
      }
    })();
  }, [params.setId]);

  const rebalanceNow = async () => {
    setRunning(true); setError(null); setResult(null);
    try {
      const res = await api(`/api/rebalance/run/${params.setId}`, { method: 'POST' });
      setResult(res);
      // refresh set meta to show new nextRunAt
      const up = await api<{ ok: true; set: SetRec }>(`/api/rebalance/set/${params.setId}`);
      setRec(up.set);
    } catch (e: any) {
      setError(e?.message || 'failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <a href="/rebalance" className="text-sm text-neutral-400">← Back</a>
      {!rec && !error && <div className="text-sm opacity-70">Loading…</div>}
      {error && <div className="text-red-400 text-sm">{error}</div>}
      {rec && (
        <div className="space-y-6">
          <div className="rounded-lg border border-neutral-800 p-4">
            <div className="text-sm opacity-70">Rebalance Set</div>
            <div className="mt-2 text-sm">id: <span className="font-mono">{rec.setId}</span></div>
            <div className="text-sm">wallet: <span className="font-mono">{rec.wallet}</span></div>
            <div className="text-sm">tokens: {rec.tokens.join(', ')}</div>
            <div className="text-sm">cadence: every {rec.freqHours}h</div>
            <div className="text-sm">status: {rec.status}</div>
            <div className="text-sm">next run: {rec.nextRunAt ? new Date(rec.nextRunAt).toLocaleString() : '—'}</div>
          </div>
          <div className="rounded-lg border border-neutral-800 p-4 space-y-3">
            {!rec.vault && (
              <div className="text-sm">
                <div className="opacity-70 mb-2">Vault not created yet.</div>
                <div>Please create the vault from your Webhooks vault UI (we reuse the exact vault type). If you already created it, refresh this page.</div>
              </div>
            )}
            {rec.vault && (
              <div className="text-sm">
                <div className="opacity-70">Vault</div>
                <div className="font-mono break-all mt-1">{rec.vault}</div>
              </div>
            )}
            <div className="flex gap-3">
              <button disabled={running} onClick={rebalanceNow} className="rounded-md border border-emerald-600 px-4 py-2 text-sm hover:bg-emerald-900/20 disabled:opacity-60">
                {running ? 'Rebalancing…' : 'Rebalance now'}
              </button>
            </div>
            {result && (
              <pre className="whitespace-pre-wrap text-xs bg-black/30 border border-neutral-800 rounded-md p-3 overflow-auto">{JSON.stringify(result, null, 2)}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
