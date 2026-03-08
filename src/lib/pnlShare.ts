// filepath: src/lib/pnlShare.ts
// Robust URL builder for the Satori P&L share card.
// THE GOLDEN RULE: This is additive/defensive only — it does not alter UI/UX.
// It only controls which query parameters are sent to the existing /api/pnl-card route.

export type BotType = 'webhooks' | 'rebalance' | 'other';

export type PnlShareParams = {
  setTitle: string;
  botType: BotType;

  // common stats
  totalUsd?: number | string | null;
  pnlUsd?: number | string | null;
  pnlPct?: number | string | null;
  runtimeSec?: number | string | null;

  // webhooks metrics
  bestTradeUsd?: number | string | null;
  totalTrades?: number | string | null;
  wins?: number | string | null;
  losses?: number | string | null;
  winRatePct?: number | string | null;

  // rebalance metrics
  cadenceHours?: number | string | null;
  totalRebalances?: number | string | null;

  // misc
  startedAt?: number | string | null;

  // debug toggles (optional)
  ultra?: boolean;
  debug?: boolean;
  trace?: boolean;
  format?: 'png' | 'svg';
  dl?: boolean;
  cb?: number | string;
};

function isNil(v: any): v is null | undefined {
  return v === null || v === undefined;
}

function toNum(v: any): number | undefined {
  if (isNil(v)) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function addIfFinite(target: URLSearchParams, key: string, v: any) {
  const n = toNum(v);
  if (typeof n === 'number') target.set(key, String(n));
}

export function buildPnlCardUrl(params: PnlShareParams): string {
  const q = new URLSearchParams();

  q.set('setTitle', (params.setTitle || 'mojomaxi bot').toString());
  q.set('botType', (params.botType || 'webhooks').toString());

  addIfFinite(q, 'totalUsd', params.totalUsd);
  addIfFinite(q, 'pnlUsd', params.pnlUsd);
  addIfFinite(q, 'pnlPct', params.pnlPct);
  addIfFinite(q, 'runtimeSec', params.runtimeSec);

  addIfFinite(q, 'bestTradeUsd', params.bestTradeUsd);
  addIfFinite(q, 'totalTrades', params.totalTrades);
  addIfFinite(q, 'wins', params.wins);
  addIfFinite(q, 'losses', params.losses);
  addIfFinite(q, 'winRatePct', params.winRatePct);

  addIfFinite(q, 'cadenceHours', params.cadenceHours);
  addIfFinite(q, 'totalRebalances', params.totalRebalances);

  addIfFinite(q, 'startedAt', params.startedAt);

  if (params.ultra) q.set('ultra', '1');
  if (params.debug) q.set('debug', '1');
  if (params.trace) q.set('trace', '1');
  if (params.format === 'svg') q.set('format', 'svg');
  if (params.dl) q.set('dl', '1');
  if (!isNil(params.cb)) q.set('cb', String(params.cb));

  // Return a relative URL to keep it universal on client/server
  return `/api/pnl-card?${q.toString()}`;
}
