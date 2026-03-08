import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

type Any = Record<string, any>;
type BotType = 'webhooks' | 'rebalance' | 'other';

type ShareSummary = {
  ok: boolean;
  botType: BotType;
  setTitle: string;
  totalUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  runtimeSec: number | null;
  bestTradeUsd: number | null;
  totalTrades: number | null;
  winRatePct: number | null;
  cadenceHours: number | null;
  totalRebalances: number | null;
  startedAt: number | null;
  sources?: string[];
};

type Fwd = { headers: HeadersInit };

function upper(s: any): string {
  return typeof s === 'string' ? s.toUpperCase() : '';
}
function isNum(x: any): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
function firstNumber(obj: Any, keys: string[]): number | null {
  for (const k of keys) {
    const parts = k.split('.');
    let v: any = obj;
    for (const p of parts) v = v == null ? undefined : v[p];
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function firstString(obj: Any, keys: string[]): string | null {
  for (const k of keys) {
    const parts = k.split('.');
    let v: any = obj;
    for (const p of parts) v = v == null ? undefined : v[p];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function buildFwd(req: NextRequest, steps?: string[]): Fwd {
  const h: Record<string,string> = { 'x-mm-internal': '1', 'accept': 'application/json' };
  const cookie = req.headers.get('cookie'); if (cookie) h['cookie'] = cookie;
  const ua = req.headers.get('user-agent'); if (ua) h['user-agent'] = ua;
  const al = req.headers.get('accept-language'); if (al) h['accept-language'] = al;

  // Optional: shared secret header for CF WAF "skip" rule
  const shared = process.env.X_MM_INTERNAL_TOKEN || process.env.INTERNAL_FETCH_TOKEN;
  if (shared) { h['x-mm-internal-token'] = shared; steps?.push('cfwaf:token'); } else { steps?.push('cfwaf:none'); }

  // Optional: CF Access service auth (kept available but not required)
  const cid = process.env.CF_ACCESS_CLIENT_ID;
  const csec = process.env.CF_ACCESS_CLIENT_SECRET;
  const svc = process.env.CF_ACCESS_SERVICE_TOKEN;
  if (cid && csec) { h['CF-Access-Client-Id'] = cid; h['CF-Access-Client-Secret'] = csec; steps?.push('cfaccess:client'); }
  else if (svc) { h['Authorization'] = `Bearer ${svc}`; steps?.push('cfaccess:svc'); }

  return { headers: h };
}

async function safeJson(url: string, init?: RequestInit): Promise<{ ok: boolean; url: string; json: Any | null; status?: number }> {
  try {
    const r = await fetch(url, { cache: 'no-store', ...(init || {}) });
    const ok = r.ok;
    let json: Any | null = null;
    const ct = String(r.headers.get('content-type') || '');
    if (ct.includes('application/json')) {
      json = await r.json();
    }
    return { ok, url, json, status: r.status };
  } catch {
    return { ok: false, url, json: null };
  }
}

function originFrom(req: NextRequest): string {
  const { origin } = new URL(req.url);
  return origin;
}

function detectBotType(whSet: Any, rbSet: Any): BotType {
  if (whSet && Object.keys(whSet).length) return 'webhooks';
  if (rbSet && Object.keys(rbSet).length) return 'rebalance';
  return 'other';
}

async function resolveSymbols(origin: string, mints: string[]): Promise<Record<string,string>> {
  const out: Record<string,string> = {};
  const list = (mints || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (list.length === 0) return out;
  try {
    const r = await fetch(`${origin}/api/tokens/meta?mints=${encodeURIComponent(list.join(','))}`, { cache: 'no-store' });
    if (r.ok) {
      const j: Any = await r.json();
      const items: Any[] = Array.isArray(j?.items) ? j.items : [];
      for (const tm of items) {
        const m = String(tm?.mint || tm?.address || '').trim();
        const sym = String(tm?.symbol || tm?.name || '').trim();
        if (m && sym) out[m] = sym.toUpperCase();
      }
    }
  } catch {}
  return out;
}

function extractMintsFromEventsForServer(events: Any[]): string[] {
  const bag = new Set<string>();
  const push = (v: any) => { const s = String(v || '').trim(); if (s) bag.add(s); };
  for (const e of events || []) {
    if (Array.isArray((e as any).mints)) for (const m of (e as any).mints) push(m);
    if (Array.isArray((e as any).tokens)) for (const t of (e as any).tokens) push((t && (t.mint || t.address || t.id)));
    push((e as any).inputMint); push((e as any).outputMint);
    push((e as any).mintIn); push((e as any).mintOut);
    push((e as any).mintA); push((e as any).mintB);
    try { push((e as any).tokenA?.mint); push((e as any).tokenB?.mint); } catch {}
  }
  return Array.from(bag);
}

function buildWebhookTitleFromSet(whSet: Any, symMap: Record<string,string>, aggTitle?: string | null): string | null {
  if (!whSet) return null;
  const mintIn = String(whSet?.prefs?.mintIn || whSet?.mintIn || whSet?.buyMint || '').trim();
  const mintOut = String(whSet?.prefs?.mintOut || whSet?.mintOut || whSet?.sellMint || '').trim();
  if (!mintIn && !mintOut) {
    const label = String(whSet?.label || '').trim();
    return label || null;
  }
  let base = symMap[mintIn] || '';
  let quote = symMap[mintOut] || '';
  if ((!base || base === 'BASE') && aggTitle) {
    const m = String(aggTitle).match(/buy\s+([A-Z0-9]+)\s+sell\s+for\s+([A-Z0-9]+)/i);
    if (m) {
      base = base || String(m[1] || '').toUpperCase();
      quote = quote || String(m[2] || '').toUpperCase();
    }
  }
  base = base || 'BASE';
  quote = quote || 'QUOTE';
  return `webhooks: buy ${base} sell for ${quote}`;
}

function buildRebalanceTitleFromSymbols(symbols: string[]): string {
  const parts = (symbols || []).map((s) => String(s || '').trim()).filter(Boolean);
  return parts.length ? `rebalance: ${parts.join(', ')}` : 'rebalance: —';
}

function pickTitle(whSet: Any, rbSet: Any): string {
  const s = firstString(whSet, ['title', 'name']) || firstString(rbSet, ['title', 'name']) || 'mojomaxi bot';
  return s;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get('setId') || '').trim();
  const walletIn = (searchParams.get('wallet') || '').trim();
  const vaultIn = (searchParams.get('vault') || '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'missing setId' }, { status: 400 });

  const origin = originFrom(req);
  const sources: string[] = [];
  const steps: string[] = [];
  const fwd = buildFwd(req, steps);

  // 1) Try to get equity FIRST if caller provided wallet/vault (avoids protected reads)
  let equityBySetR: { ok: boolean; url: string; json: Any | null; status?: number } = { ok: false, url: '', json: null };
  if (walletIn || vaultIn) {
    const equityUrl = new URL(`${origin}/api/vault/equity`);
    equityUrl.searchParams.set('setId', id);
    if (walletIn) equityUrl.searchParams.set('wallet', walletIn);
    if (vaultIn) equityUrl.searchParams.set('vault', vaultIn);
    const er = await fetch(equityUrl.toString(), { cache: 'no-store', ...fwd });
    equityBySetR = { ok: er.ok, url: equityUrl.toString(), json: null, status: er.status };
    try { if (er.headers.get('content-type')?.includes('application/json')) equityBySetR.json = await er.json(); } catch {}
    if (equityBySetR.ok) sources.push(equityBySetR.url);
  }

  // 2) Pull candidate sources (may 403 without CF rule; we attach token header)
  const whR = await safeJson(`${origin}/api/webhooks/set/${encodeURIComponent(id)}`, fwd);
  if (whR.ok) sources.push(whR.url);
  const rbR = await safeJson(`${origin}/api/rebalance/set/${encodeURIComponent(id)}`, fwd);
  if (rbR.ok) sources.push(rbR.url);
  const eventsR = await safeJson(`${origin}/api/events/recent?setId=${encodeURIComponent(id)}&limit=500`, fwd);
  if (eventsR.ok) sources.push(eventsR.url);

  // 3) Declare sets/events
  const whSet: Any = whR.ok ? (whR.json?.set ?? whR.json ?? {}) : {};
  const rbSet: Any = rbR.ok ? (rbR.json?.set ?? rbR.json ?? {}) : {};
  const events: Any[] = Array.isArray(eventsR.json?.events)
    ? (eventsR.json!.events as Any[])
    : Array.isArray(eventsR.json)
      ? (eventsR.json as Any[])
      : [];

  const botType = detectBotType(whSet, rbSet);
  let setTitle = pickTitle(whSet, rbSet);

  // Enhance title (best-effort)
  try {
    if (botType === 'webhooks' && whSet) {
      const mintIn = String(
        whSet?.prefs?.mintIn ||
          whSet?.mintIn ||
          whSet?.mintA ||
          whSet?.tokenA ||
          whSet?.buyMint ||
          ''
      ).trim();
      const mintOut = String(
        whSet?.prefs?.mintOut ||
          whSet?.mintOut ||
          whSet?.mintB ||
          whSet?.tokenB ||
          whSet?.sellMint ||
          ''
      ).trim();

      let symMap: Record<string, string> = {};
      const toResolve: string[] = [];
      if (mintIn) toResolve.push(mintIn);
      if (mintOut && mintOut !== mintIn) toResolve.push(mintOut);

      // If the set doc doesn't have mints (older docs), fall back to mints seen in events.
      if (toResolve.length < 2) {
        const mintsFromEvents = extractMintsFromEventsForServer(events);
        for (const m of mintsFromEvents) {
          if (!m) continue;
          if (toResolve.length >= 2) break;
          if (!toResolve.includes(m)) toResolve.push(m);
        }
      }

      if (toResolve.length) {
        symMap = await resolveSymbols(origin, toResolve);
      }

      // Primary: build from set fields (mintIn/mintOut or equivalents)
      const whTitle = buildWebhookTitleFromSet(whSet, symMap, setTitle);
      if (whTitle) {
        setTitle = whTitle;
      } else {
        // Secondary: if we still have no title, build from first two resolved symbols.
        const syms = toResolve.map((m) => String(symMap[m] || '').trim()).filter(Boolean);
        if (syms.length >= 2) {
          setTitle = `webhooks: buy ${syms[0].toUpperCase()} sell for ${syms[1].toUpperCase()}`;
        }
      }
    } else if (botType === 'rebalance' && rbSet) {
      let mints: string[] = [];
      if (Array.isArray(rbSet.mints) && rbSet.mints.length) {
        mints = rbSet.mints.map((x:any)=>String((x && (x.mint || x.address || x)) || '').trim()).filter(Boolean);
      }
      if (mints.length < 2 && Array.isArray(events) && events.length) {
        mints = extractMintsFromEventsForServer(events);
      }
      if (mints.length >= 2) {
        const symMap = await resolveSymbols(origin, mints);
        const syms = mints.map(m => (symMap[m] || '').trim()).filter(Boolean);
        if (syms.length >= 2) setTitle = buildRebalanceTitleFromSymbols(syms);
      }
    }
  } catch {}

  // 4) totalUsd — prefer equity FIRST (already computed), else try sets
  let totalUsd: number | null =
    firstNumber(equityBySetR.json ?? {}, ['equityUsd', 'equity', 'totalUsd']) ??
    firstNumber(whSet, ['equityUsd', 'equity', 'totalUsd', 'balanceUsd']) ??
    firstNumber(rbSet, ['equityUsd', 'equity', 'totalUsd', 'balanceUsd']) ??
    null;

  // PnL — rebalance uses equity - startingTotalUsd; webhooks keep legacy baseline logic; else SELL aggregation fallback
  // Determine equityUsd (from equity endpoint if available, else from sets)
  const equityUsd =
    firstNumber(equityBySetR.json ?? {}, ['equityUsd', 'equity', 'totalUsd']) ??
    firstNumber(whSet, ['equityUsd', 'equity', 'totalUsd', 'balanceUsd']) ??
    firstNumber(rbSet, ['equityUsd', 'equity', 'totalUsd', 'balanceUsd']) ??
    null;

  let pnlUsd: number | null = null;
  let pnlPct: number | null = null;

  if (botType === 'rebalance') {
    // Strict: P&L baseline is 'startingTotalUsd' (or totalUsdSnapshot from FIRST_REBALANCE_EQUITY)
    // Try sources in order: equity payload -> rebalance set doc -> events -> webhooks set doc
    let startUsd: number | null =
      firstNumber(equityBySetR.json ?? {}, ['startingTotalUsd', 'totalUsdSnapshot']) ??
      firstNumber(rbSet, ['startingTotalUsd', 'totalUsdSnapshot']) ??
      null;

    if (startUsd == null) {
      // Scan events for the LATEST start-like snapshot
      let bestVal: number | null = null;
      let bestTs: number = -Infinity;
      for (const e of events) {
        const ts = Number(e?.ts ?? e?.timeMs ?? e?.time ?? e?.timestamp ?? e?.createdAt ?? 0);
        const cand = firstNumber(e as any, ['startingTotalUsd', 'startTotalUsd', 'totalUsdSnapshot']);
        if (Number.isFinite(ts) && isNum(cand) && ts >= bestTs) { bestTs = ts; bestVal = cand as number; }
        // Explicit FIRST_REBALANCE_EQUITY support
        const kind = upper((e as any)?.kind || (e as any)?.type || (e as any)?.event);
        if (kind === 'FIRST_REBALANCE_EQUITY') {
          const k = firstNumber(e as any, ['totalUsdSnapshot', 'baselineUsd', 'startingTotalUsd']);
          if (Number.isFinite(ts) && isNum(k) && ts >= bestTs) { bestTs = ts; bestVal = k as number; }
        }
      }
      startUsd = isNum(bestVal) ? bestVal : null;
    }

    if (startUsd == null) {
      // Last resort only: allow webhooks set doc to contribute a 'startingTotalUsd' if present
      startUsd =
        firstNumber(whSet, ['startingTotalUsd', 'totalUsdSnapshot']) ??
        null;
    }

    if (isNum(equityUsd) && isNum(startUsd)) {
      pnlUsd = equityUsd - startUsd;
      pnlPct = startUsd > 0 ? (pnlUsd / startUsd) * 100 : 0;
    } else {
      // SELL aggregation fallback
      let agg = 0;
      let sells = 0;
      for (const e of events) {
        const dir = upper(e?.direction);
        const pnl = Number(e?.pnlUsd ?? e?.pnl);
        if (dir === 'SELL' && Number.isFinite(pnl)) { agg += pnl; sells++; }
      }
      pnlUsd = sells ? agg : null;
    }
  } else {
    // Legacy: for webhooks/other, keep baseline semantics as before
    const baselineUsd =
      firstNumber(equityBySetR.json ?? {}, ['baselineUsd', 'baseline']) ??
      firstNumber(whSet, ['baselineUsd', 'baseline']) ??
      firstNumber(rbSet, ['baselineUsd', 'baseline']) ??
      null;
    if (isNum(equityUsd) && isNum(baselineUsd)) {
      pnlUsd = equityUsd - baselineUsd;
      pnlPct = baselineUsd > 0 ? (pnlUsd / baselineUsd) * 100 : 0;
    } else {
      let agg = 0;
      let sells = 0;
      for (const e of events) {
        const dir = upper(e?.direction);
        const pnl = Number(e?.pnlUsd ?? e?.pnl);
        if (dir === 'SELL' && Number.isFinite(pnl)) { agg += pnl; sells++; }
      }
      pnlUsd = sells ? agg : null;
    }
  }

  // Webhooks-only derived stats

  let bestTradeUsd: number | null = null;
  let totalTrades: number | null = null;
  let winRatePct: number | null = null;
  {
    let sells = 0, wins = 0, best = -Infinity;
    for (const e of events) {
      const dir = upper(e?.direction);
      const pnl = Number(e?.pnlUsd ?? e?.pnl);
      if (dir === 'SELL' && Number.isFinite(pnl)) {
        sells++;
        if (pnl > 0) wins++;
        if (pnl > best) best = pnl;
      }
    }
    totalTrades = sells || null;
    winRatePct = sells > 0 ? (wins / sells) * 100 : null;
    bestTradeUsd = Number.isFinite(best) ? best : null;
  }

  // Runtime
  let runtimeSec: number | null = null;
  let startedAt: number | null = null;
  const nowMs = Date.now();
  startedAt =
    firstNumber(rbSet, ['startedAt', 'startAt', 'createdAt']) ??
    firstNumber(whSet, ['startedAt', 'startAt', 'createdAt']) ??
    null;
  if (!isNum(startedAt) && events.length) {
    const firstTs = Number(
      [...events]
        .map((e) => Number(e?.ts ?? e?.timeMs ?? e?.time ?? 0))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)[0] ?? 0
    );
    startedAt = Number.isFinite(firstTs) && firstTs > 0 ? firstTs : null;
  }
  if (isNum(startedAt)) {
    runtimeSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  }

  const cadenceHours = firstNumber(rbSet, ['cadenceHours', 'cadenceH', 'cadence']) ?? null;
  const totalRebalances = firstNumber(rbSet, ['totalRebalances', 'rebalanceCount']) ?? null;

  const out: ShareSummary = {
    ok: true,
    botType: detectBotType(whSet, rbSet),
    setTitle,
    totalUsd: isNum(totalUsd) ? Number(totalUsd.toFixed(2)) : null,
    pnlUsd: isNum(pnlUsd) ? Number(pnlUsd.toFixed(2)) : null,
    pnlPct: isNum(pnlPct) ? Number(pnlPct.toFixed(2)) : null,
    runtimeSec: isNum(runtimeSec) ? runtimeSec : null,
    bestTradeUsd: isNum(bestTradeUsd) ? Number(bestTradeUsd.toFixed(2)) : null,
    totalTrades: isNum(totalTrades) ? totalTrades : null,
    winRatePct: isNum(winRatePct) ? Number(winRatePct.toFixed(2)) : null,
    cadenceHours: isNum(cadenceHours) ? cadenceHours : null,
    totalRebalances: isNum(totalRebalances) ? totalRebalances : null,
    startedAt: isNum(startedAt) ? startedAt : null,
    sources: [...sources, `diag:${steps.join('|')}`],
  };

  return NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
}
