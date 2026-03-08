// filename: src-components-share-SharePLCardPreviewModal-hires-7f2a1c.txt
// FULL FILE REPLACEMENT: src/components/share/SharePLCardPreviewModal.tsx
'use client';

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { buildPnlCardUrl, type PnlShareParams } from '@/lib/pnlShare';

type BotType = 'webhooks' | 'rebalance' | 'other';

type Summary = {
  ok: boolean;
  botType: BotType;
  setTitle: string;
  setId?: string | null;
  totalUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  runtimeSec: number | null;
  bestTradeUsd?: number | null;
  totalTrades?: number | null;
  wins?: number | null;
  losses?: number | null;
  winRatePct?: number | null;
  cadenceHours?: number | null;
  totalRebalances?: number | null;
  startedAt?: number | null;
  sources?: string[];
};

type WebhookSetDoc = {
  setId: string;
  wallet?: string | null;
  label?: string | null;
  prefs?: { mintIn?: string | null; mintOut?: string | null; mintA?: string | null; mintB?: string | null } | null;
  buyMint?: string | null; // legacy
  sellMint?: string | null; // legacy
  vault?: string | null;
  [k: string]: any;
};

type RebalanceSetDoc = {
  id?: string;
  setId?: string;
  wallet?: string | null;
  mints?: string[];
  cadence?: string | null;
  vaultId?: string | null;
  type?: string;
  kind?: string;
  // baseline-esque fields can appear here in some deployments
  startingTotalUsd?: number;
  startTotalUsd?: number;
  totalUsdSnapshot?: number;
  baselineUsd?: number;
  [k: string]: any;
};


type EquityResponse = {
  ok?: boolean;
  setId?: string | null;
  wallet?: string | null;
  vault?: string | null;
  totalUsd?: number | null;
  startingTotalUsd?: number | null; // used for rebalance P&L fallback
  pnlUsd?: number | null;
  pnlPct?: number | null;
};
type TokenMeta = {
  address: string;
  mint: string;
  symbol: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  verified?: boolean;
};

type AnyEvent = Record<string, any>;

/* ------------------------------- tiny utils ------------------------------- */

const isNum = (n: any): n is number => typeof n === 'number' && Number.isFinite(n);
const toNum = (x: any) => {
  if (x == null) return null as any;
  const n = Number(x);
  return Number.isFinite(n) ? n : (null as any);
};
const trim = (s: any) => (typeof s === 'string' ? s.trim() : '');
const upper = (s: string) => s.toUpperCase();

/** parse cadence strings like "6h", "12", "24h", "2 hrs" into hours (integer). */
const parseCadenceHours = (s: any): number | null => {
  const raw = String(s || '').trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  // assume hours by default; ignore minutes for now to match debug/share simplicity
  return Math.round(n);
};


/* ----------------------------- data fetchers ------------------------------ */

// explicit signature (for TS tooling) + implementation below
async function safeJson(url: string, signal?: AbortSignal): Promise<{ ok: boolean; json: any | null; status?: number; ct?: string }> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal });
    const ok = res.ok;
    const ct = String(res.headers.get('content-type') || '');
    let json: any = null;
    if (ct.includes('application/json')) {
      json = await res.json();
    } else if (ct.includes('text/json') || ct.includes('application/vnd.api+json')) {
      json = await res.json();
    } else if (ct.includes('text/plain')) {
      try { json = JSON.parse(await res.text()); } catch { json = null; }
    }
    return { ok, json, status: res.status, ct };
  } catch (e) {
    return { ok: false, json: null, status: 0, ct: undefined };
  }
}

async function fetchResolveSet(setId: string, signal?: AbortSignal): Promise<Summary | null> {
  const { ok, json } = await safeJson(`/api/share/resolve-set?setId=${encodeURIComponent(setId)}`, signal);
  if (!ok || !json) return null;
  const j: any = json;
  const out: Summary = {
    ok: !!j?.ok,
    botType: (j?.botType || 'webhooks') as BotType,
    setTitle: trim(j?.setTitle) || 'mojomaxi bot',
    setId,
    totalUsd: toNum(j?.totalUsd),
    pnlUsd: toNum(j?.pnlUsd),
    pnlPct: toNum(j?.pnlPct),
    runtimeSec: toNum(j?.runtimeSec),
    bestTradeUsd: toNum(j?.bestTradeUsd),
    totalTrades: toNum(j?.totalTrades),
    wins: toNum(j?.wins),
    losses: toNum(j?.losses),
    winRatePct: toNum(j?.winRatePct),
    cadenceHours: toNum(j?.cadenceHours),
    totalRebalances: toNum(j?.totalRebalances),
    startedAt: toNum(j?.startedAt),
    sources: Array.isArray(j?.sources) ? j.sources.map((x: any) => String(x)) : undefined,
  };
  return out;
}

async function fetchWebhookSetDoc(setId: string, signal?: AbortSignal): Promise<WebhookSetDoc | null> {
  const { ok, json } = await safeJson(`/api/webhooks/set/${encodeURIComponent(setId)}`, signal);
  if (!ok || !json) return null;
  const set = (json as any)?.set || json || null;
  if (set && typeof set === 'object') return set as WebhookSetDoc;
  return null;
}

async function fetchRebalanceSetDoc(setId: string, signal?: AbortSignal): Promise<RebalanceSetDoc | null> {
  try {
    const { ok, json } = await safeJson(`/api/rebalance/set/${encodeURIComponent(setId)}`, signal);
    if (!ok || !json) return null;
    const doc = (json as any)?.set || (json as any) || null;
    if (doc && typeof doc === 'object') return doc as RebalanceSetDoc;
    return null;
  } catch {
    return null;
  }
}

async function fetchVaultId(setId: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { ok, json } = await safeJson(`/api/sets/${encodeURIComponent(setId)}/vaultid`, signal);
    if (!ok || !json) return null;
    const v = (json as any)?.vault || null;
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

async function fetchEquity(opts: { setId: string; wallet?: string | null; vault?: string | null }, signal?: AbortSignal): Promise<EquityResponse | null> {
  try {
    const params = new URLSearchParams();
    params.set('setId', String(opts.setId));
    if (opts.wallet) params.set('wallet', String(opts.wallet));
    if (opts.vault) params.set('vault', String(opts.vault));
    const { ok, json } = await safeJson(`/api/vault/equity?${params.toString()}`, signal);
    if (!ok || !json) return null;
    return json as EquityResponse;
  } catch {
    return null;
  }
}


async function fetchTokenMetaMulti(mints: string[], signal?: AbortSignal): Promise<Record<string, TokenMeta>> {
  const list = (mints || []).map((s) => trim(s)).filter(Boolean);
  if (list.length === 0) return {};
  const candidates = [
    `/api/tokens?mints=${encodeURIComponent(list.join(','))}`,
    `/api/token-meta?mints=${encodeURIComponent(list.join(','))}`,
    `/api/price/token-meta?mints=${encodeURIComponent(list.join(','))}`,
    `/api/jupiter/tokens?mints=${encodeURIComponent(list.join(','))}`,
    `/api/tokens/meta?mints=${encodeURIComponent(list.join(','))}`,
  ];
  for (const url of candidates) {
    try {
      const { ok, json } = await safeJson(url, signal);
      if (!ok || !json) continue;
      const maybe = (json as any);
      const map: any =
        maybe?.map ||
        maybe?.tokens ||
        maybe?.data ||
        maybe?.items ||
        maybe?.byMint ||
        maybe;
      const out: Record<string, TokenMeta> = {};
      if (Array.isArray(map)) {
        for (const tm of map as any[]) {
          const mint = String(tm?.mint || tm?.address || '').trim();
          if (mint) out[mint] = {
            address: String(tm?.address || mint),
            mint,
            symbol: String(tm?.symbol || tm?.name || '').toUpperCase(),
            name: tm?.name, decimals: tm?.decimals, logoURI: tm?.logoURI, verified: tm?.verified,
          };
        }
      } else if (map && typeof map === 'object') {
        for (const [k, v] of Object.entries(map)) {
          const tm: any = v;
          const mint = String(tm?.mint || tm?.address || k).trim();
          if (!mint) continue;
          out[mint] = {
            address: String(tm?.address || mint),
            mint,
            symbol: String(tm?.symbol || tm?.name || '').toUpperCase(),
            name: tm?.name, decimals: tm?.decimals, logoURI: tm?.logoURI, verified: tm?.verified,
          };
        }
      }
      if (Object.keys(out).length) return out;
    } catch {}
  }
  return {};
}

async function fetchDexSymbol(mint: string, signal?: AbortSignal): Promise<string | null> {
  const q = encodeURIComponent(String(mint || '').trim());
  const urls = [
    `/api/dexscreener/symbol?mint=${q}`,
    `/api/dex/symbol?mint=${q}`,
    `/api/tokens/symbol?mint=${q}`,
  ];
  for (const u of urls) {
    try {
      const { ok, json } = await safeJson(u, signal);
      if (!ok || !json) continue;
      const sym =
        (typeof (json as any)?.symbol === 'string' && (json as any).symbol) ||
        (typeof (json as any)?.data?.symbol === 'string' && (json as any).data.symbol) ||
        (typeof (json as any)?.token?.symbol === 'string' && (json as any).token.symbol) ||
        '';
      if (sym && typeof sym === 'string' && sym.trim()) return sym.trim().toUpperCase();
    } catch {}
  }
  try {
    const { ok, json } = await safeJson(`/api/tokens/search?q=${q}`, signal);
    if (ok && json) {
      const arr: any[] = Array.isArray((json as any).tokens) ? (json as any).tokens : (Array.isArray((json as any).items) ? (json as any).items : []);
      const hit = arr.find((t: any) => String((t?.address || t?.mint || '')).trim().toLowerCase() === decodeURIComponent(q).toLowerCase());
      const sym = hit && (hit.symbol || hit.name);
      if (sym && typeof sym === 'string' && sym.trim()) return sym.trim().toUpperCase();
    }
  } catch {}
  return null;
}

function extractMintsFromEvents(events: AnyEvent[]): string[] {
  const bag = new Set<string>();
  const push = (v: any) => {
    const s = String(v || '').trim();
    if (!s) return;
    bag.add(s);
  };
  for (const e of events || []) {
    if (Array.isArray((e as any).mints)) for (const m of (e as any).mints) push(m);
    if (Array.isArray((e as any).tokens)) for (const t of (e as any).tokens) push((t && (t.mint || t.address || t.id)));
    push((e as any).inputMint); push((e as any).outputMint);
    push((e as any).mintIn); push((e as any).mintOut);
    push((e as any).mintA); push((e as any).mintB);
    try { push((e as any).tokenA?.mint); push((e as any).tokenB?.mint); } catch {}
    try {
      if (Array.isArray((e as any).pairs)) for (const p of (e as any).pairs) { push(p?.a?.mint || p?.mintA); push(p?.b?.mint || p?.mintB); }
      if (Array.isArray((e as any).legs)) for (const leg of (e as any).legs) { push(leg?.inputMint); push(leg?.outputMint); }
    } catch {}
  }
  return Array.from(bag);
}

async function resolveSymbolsForMints(mints: string[], signal?: AbortSignal): Promise<Record<string,string>> {
  const out: Record<string,string> = {};
  const meta = await fetchTokenMetaMulti(mints, signal);
  for (const m of mints) {
    const tm: any = (meta as any)[m];
    const hit = tm && (tm.symbol || tm.name);
    if (hit && String(hit).trim()) {
      out[m] = String(hit).trim().toUpperCase();
      continue;
    }
    try {
      const sym = await fetchDexSymbol(m, signal);
      if (sym) out[m] = sym;
    } catch {}
  }
  return out;
}

function tokenSymbolFromMap(mint: string | null | undefined, fallback: string, map?: Record<string, TokenMeta>): string {
  const m = trim(String(mint || ''));
  if (!m) return fallback;
  const sym = map && (map as any)[m] && (map as any)[m].symbol ? String((map as any)[m].symbol) : '';
  return sym ? upper(sym) : fallback;
}

function computeWebhookTitle(set: WebhookSetDoc | null, tokenMap: Record<string, TokenMeta> | null, agg?: Summary | null): string | null {
  if (!set) return null;

  // Prefer modern A/B schema; fall back to legacy mintIn/mintOut (and older buy/sell fields).
  const mintA = trim(String(set?.prefs?.mintA || (set as any)?.mintA || ''));
  const mintB = trim(String(set?.prefs?.mintB || (set as any)?.mintB || ''));

  if (mintA || mintB) {
    let base = tokenSymbolFromMap(mintA, '', tokenMap || undefined);
    let quote = tokenSymbolFromMap(mintB, '', tokenMap || undefined);

    // Fallback: attempt to extract from aggregated title if our symbol map is missing
    if ((!base || base === 'BASE') && agg) {
      const aggTitle = String(agg.setTitle || '');
      const m = aggTitle.match(/buy\s+([A-Z0-9]+)\s+sell\s+for\s+([A-Z0-9]+)/i);
      if (m) {
        base = base || upper(m[1]);
        quote = quote || upper(m[2]);
      }
    }

    base = base || 'BASE';
    quote = quote || 'QUOTE';
    return `🪝 buy ${base} sell for ${quote}`;
  }

  const mintIn = trim(String(set?.prefs?.mintIn || (set as any)?.mintIn || set?.buyMint || ''));
  const mintOut = trim(String(set?.prefs?.mintOut || (set as any)?.mintOut || set?.sellMint || ''));

  if (mintIn || mintOut) {
    let base = tokenSymbolFromMap(mintIn, '', tokenMap || undefined);
    let quote = tokenSymbolFromMap(mintOut, '', tokenMap || undefined);

    if ((!base || base === 'BASE') && agg) {
      const aggTitle = String(agg.setTitle || '');
      const m = aggTitle.match(/buy\s+([A-Z0-9]+)\s+sell\s+for\s+([A-Z0-9]+)/i);
      if (m) {
        base = base || upper(m[1]);
        quote = quote || upper(m[2]);
      }
    }

    base = base || 'BASE';
    quote = quote || 'QUOTE';
    return `🪝 buy ${base} sell for ${quote}`;
  }

  const label = trim(String(set?.label || ''));
  if (label) return label;
  return null;
}

function computeRebalanceTitleFromSymbols(symbols: string[]): string {
  const parts = (symbols || []).filter(Boolean);
  return parts.length ? `⚖️ : ${parts.join(', ')}` : '⚖️ : —';
}

function humanRuntime(seconds: number | null): string {
  if (!isNum(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || '0m';
}

/* ---------------------------- SVG post-process ---------------------------- */
/* ----------------------- NEW: single-line, auto-resize helpers -------------- */

let __measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidth(text: string, font: string): number {
  try {
    if (!__measureCanvas) __measureCanvas = document.createElement('canvas');
    const ctx = __measureCanvas.getContext('2d');
    if (!ctx) return text.length * 10;
    ctx.font = font;
    return ctx.measureText(text).width;
  } catch { return text.length * 10; }
}

function decreaseFontSize(attrs: string, dec: number): string {
  let out = attrs;
  const reAttr = /\bfont-size\s*=\s*['"](\d+(?:\.\d+)?)([a-z%]*)['"]/i;
  if (reAttr.test(out)) {
    out = out.replace(reAttr, (_m, num, unit) => {
      const next = Math.max(8, Number(num) - dec);
      const u = unit || 'px';
      return `font-size="${next}${u}"`;
    });
    return out;
  }
  const reStyle = /(style\s*=\s*['"][^'"]*?font-size\s*:\s*)(\d+(?:\.\d+)?)([a-z%]*)([^'"]*['"])/i;
  if (reStyle.test(out)) {
    out = out.replace(reStyle, (_m, p1, num, unit, p4) => {
      const next = Math.max(8, Number(num) - dec);
      const u = unit || 'px';
      return `${p1}${next}${u}${p4}`;
    });
    return out;
  }
  return out;
}


function undimSvg(svg: string): string {
  try {
    let out = svg;
    // brighten background image opacity (if Satori emitted it dimmed)
    const reImgOpacityAttr = new RegExp('(<image\\b[^>]*?)\\s+opacity\\s*=\\s*["\\\']0?\\.\\d+["\\\']([^>]*>)', 'gi');
    out = out.replace(reImgOpacityAttr, '$1 opacity="1"$2');
    const reImgOpacityStyle = new RegExp('(<image\\b[^>]*style=[\'"][^\'"]*?)opacity\\s*:\\s*0?\\.\\d+([^\'"]*[\'"][^>]*>)', 'gi');
    out = out.replace(reImgOpacityStyle, '$1opacity:1$2');
    // remove final dark rect overlay (ultra vs default)
    const reRectDim = new RegExp('<rect\\b([^>]*?)fill\\s*=\\s*["\\\']#?0{3,6}["\\\']([^>]*?)opacity\\s*=\\s*["\\\']0?\\.(0?[1-9]|[1-3]\\d)["\\\']([^>]*?)\\/?>(?![\\s\\S]*<\\/svg>)', 'gi');
    out = out.replace(reRectDim, '');
    // strip "Webhooks bot" or "Rebalancing bot" header text
    const hdr = '(?:webhooks?\\s*bot|rebalanc(?:e|ing)\\s*bot)';
    const reTspanHeader = new RegExp(`<tspan\\b[^>]*>[\\s\\S]*?${hdr}[\\s\\S]*?<\\/tspan>`, 'gi');
    out = out.replace(reTspanHeader, '');
    const reTextHeader = new RegExp(`<text\\b[^>]*>[\\s\\S]*?${hdr}[\\s\\S]*?<\\/text>`, 'gi');
    out = out.replace(reTextHeader, '');
    return out;
  } catch { return svg; }
}

function parseSvgSize(svg: string): { width: number; height: number } {
  try {
    const m = /<svg\b([^>]+)>/i.exec(svg);
    const attrs = m ? m[1] : '';
    const w = getAttr(attrs, 'width');
    const h = getAttr(attrs, 'height');
    if (w && h) {
      const wn = Number(String(w).replace(/px|pt|rem|em/g, ''));
      const hn = Number(String(h).replace(/px|pt|rem|em/g, ''));
      if (Number.isFinite(wn) && Number.isFinite(hn)) return { width: wn, height: hn };
    }
    const vb = getAttr(attrs, 'viewBox') || getAttr(attrs, 'viewbox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map((t) => Number(t));
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        return { width: parts[2], height: parts[3] };
      }
    }
  } catch {}
  return { width: 500, height: 500 };
}

function getAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(attrs);
  return m ? m[1] : null;
}

function setOrReplaceAttr(attrs: string, name: string, value: string): string {
  const re = new RegExp(`(\\b${name}\\s*=\\s*['"])([^'"]*)(['"])`, 'i');
  if (re.test(attrs)) return attrs.replace(re, `$1${value}$3`);
  return attrs.replace(/^/, `${name}="${value}" `);
}

function setOrReplaceFontSize(attrs: string, px: number): string {
  const reAttr = /\bfont-size\s*=\s*['"](\d+(?:\.\d+)?)[a-z%]*['"]/i;
  if (reAttr.test(attrs)) return attrs.replace(reAttr, `font-size="${px}px"`);
  const reStyle = /(style\s*=\s*['"][^'"]*?font-size\s*:\s*)(\d+(?:\.\d+)?)([a-z%]*)([^'"]*['"])/i;
  if (reStyle.test(attrs)) return attrs.replace(reStyle, (_m, p1, _n, _u, p4) => `${p1}${px}px${p4}`);
  return attrs.replace(/^/, `font-size="${px}px" `);
}

function adjustNumericAttr(attrs: string, name: string, delta: number): string {
  return attrs.replace(
    new RegExp(`(\\b${name}\\s*=\\s*['"])(-?\\d+(?:\\.\\d+)?)([^'"]*['"])`, 'i'),
    (_m, p1, num, p3) => {
      const next = (Number(num) + delta);
      return `${p1}${isFinite(next) ? next : num}${p3}`;
    }
  );
}

/** Force title to a single line by shrinking font-size if needed, and nudge down slightly. */
function enforceSingleLineTitle(
  svg: string,
  setTitleRaw: string,
  {
    maxWidth, rightPad = 20,
    minFontPx = 14, maxFontPx = 80,
    extraDownPx = 6,
    defaultFontPx = 48,
    defaultFamily = 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
    safetyPad = 2
  }: {
    maxWidth?: number; rightPad?: number; minFontPx?: number; maxFontPx?: number;
    extraDownPx?: number; defaultFontPx?: number; defaultFamily?: string; safetyPad?: number;
  } = {}
): string {
  try {
    const want = setTitleRaw.replace(/\s+/g, ' ').trim();
    if (!want) return svg;

    const wantLower = want.toLowerCase();

    let done = false;
    // REGEX LITERAL -> RegExp() to avoid TSX parsing edge cases
    const re = new RegExp("<text\\b([^>]*)>([\\s\\S]*?)<\\/text>", "gi");
    return svg.replace(re, (full, attrs, inner) => {
      if (done) return full;

      const plain = String(inner).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

      const looksLikeTitle =
        plain === wantLower ||
        plain.includes(wantLower) ||
        plain.startsWith('webhooks:') ||
        plain.startsWith('rebalance:') ||
        plain.includes('sell for');

      if (!looksLikeTitle) return full;

      // pull sizing/style context
      const style = getAttr(attrs, 'style') || '';
      const attrFontSize = getAttr(attrs, 'font-size');
      const attrFamily = getAttr(attrs, 'font-family');
      const attrX = getAttr(attrs, 'x');
      const svgDims = parseSvgSize(svg);
      const viewW = svgDims?.width || 500;
      let x = attrX ? parseFloat(attrX) : 30;
      if (!Number.isFinite(x)) x = 30;

      const usableWidth = (typeof maxWidth === 'number' && maxWidth > 0) ? maxWidth : Math.max(100, viewW - x - rightPad);

      let fontPx = attrFontSize ? parseFloat(attrFontSize) : defaultFontPx;

      const weight = (style.match(/font-weight\s*:\s*([^;]+)/i)?.[1] || '').trim();
      const fStyle = (style.match(/font-style\s*:\s*([^;]+)/i)?.[1] || '').trim();
      const variant = (style.match(/font-variant\s*:\s*([^;]+)/i)?.[1] || '').trim();
      let family = (style.match(/font-family\s*:\s*([^;]+)/i)?.[1] || attrFamily || defaultFamily);

      const toPx = (prop: string, base: number) => {
        const m = style.match(new RegExp(prop + '\\s*:\\s*([^;]+)', 'i'));
        const attr = getAttr(attrs, prop);
        const val = (m && m[1]) || attr || '';
               if (!val) return 0;
        const s = val.trim().toLowerCase();
        if (s === 'normal') return 0;
        if (s.endsWith('px')) return parseFloat(s);
        if (s.endsWith('em')) return parseFloat(s) * base;
        if (s.endsWith('%')) return (parseFloat(s) / 100) * base;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : 0;
      };

      const effWidth = (px: number) => {
        const letterSpacing = toPx('letter-spacing', px);
        const wordSpacing   = toPx('word-spacing',   px);

        const parts: string[] = [];
        if (fStyle) parts.push(fStyle);
        if (variant) parts.push(variant);
        if (weight) parts.push(weight);
        parts.push(`${px}px`);
        parts.push(family);
        const fontStr = parts.join(' ');

        let w = measureTextWidth(want, fontStr);
        const chars = Array.from(want).length;
        const spaces = (want.match(/\s/g) || []).length;
        if (letterSpacing) w += Math.max(0, letterSpacing) * Math.max(0, chars - 1);
        if (wordSpacing)   w += Math.max(0, wordSpacing)   * spaces;
        return w;
      };

      let guard = 0;
      let w = effWidth(fontPx);
      while (w > (usableWidth - safetyPad) && fontPx > minFontPx && guard++ < 120) { fontPx -= 1; w = effWidth(fontPx); }
      guard = 0;
      while (w < (usableWidth - safetyPad - 1) && fontPx < maxFontPx && guard++ < 120) { fontPx += 1; w = effWidth(fontPx); }
      if (w > (usableWidth - safetyPad)) fontPx -= 1;

      const targetLen = Math.max(usableWidth - safetyPad, 0);
      let a = setOrReplaceFontSize(attrs, fontPx);
      if (/textLength=/i.test(a)) a = a.replace(/textLength\s*=\s*['"][^'"]+['"]/i, `textLength="${targetLen}"`);
      else a = a + ` textLength="${targetLen}"`;
      if (/lengthAdjust=/i.test(a)) a = a.replace(/lengthAdjust\s*=\s*['"][^'"]+['"]/i, `lengthAdjust="spacingAndGlyphs"`);
      else a = a + ` lengthAdjust="spacingAndGlyphs"`;

      if (extraDownPx) a = adjustNumericAttr(a, 'y', extraDownPx);

      done = true;
      return `<text ${a}>${escapeXml(want)}</text>`;
    });
  } catch {
    return svg;
  }
}

function stripExistingRuntime(svg: string): string {
  try {
    let out = svg;
    out = out.replace(/<tspan\b[^>]*>[\s\S]*?runtime\s*:[\s\S]*?<\/tspan>/gi, '');
    out = out.replace(/<text\b[^>]*>(?:[^<]*?runtime\s*:[^<]*?)<\/text>/gi, '');
    return out;
  } catch { return svg; }
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function stripTags(s: string): string {
  return String(s || '').replace(/<[^>]+>/g, '');
}
function escapeXml(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Colorize P&L value and append additional stats as <tspan> lines under the P&L block. */
function colorizeAndAppendStats(svg: string, stats: {
  mode: 'webhooks' | 'rebalance';
  pnlUsd: number | null;
  // webhooks
  winRatePct?: number | null;
  trades?: number | null;
  wins?: number | null;
  losses?: number | null;
  // rebalance
  cadenceHours?: number | null;
  totalRebalances?: number | null;
  // common
  runtime: string | null;
}): string {
  try {
    let out = svg;
    let handled = false;
    // REGEX LITERAL -> RegExp() to avoid TSX parsing edge cases
    const re = new RegExp("<text\\b([^>]*)>([\\s\\S]*?)<\\/text>", "gi");
    out = out.replace(re, (full, attrs, inner) => {
      if (handled) return full;
      const plain = stripTags(inner).toLowerCase();
      if (!(plain.includes('p&l') || plain.includes('p&amp;l') || plain.includes('pnl'))) return full;

      const pos = isNum(stats.pnlUsd) && stats.pnlUsd > 0;
      const neg = isNum(stats.pnlUsd) && stats.pnlUsd < 0;
      const color = pos ? '#1BFDB2' : (neg ? '#FD1B77' : '');
      let colored = inner;
      if (color) colored = colored.replace(/([+\-]?\$?\d[\d,]*(?:\.\d+)?(?:\s*\(\s*[+\-]?\d+(?:\.\d+)?%\s*\))?)/, `<tspan fill="${color}">$1</tspan>`);

      const x = /\bx\s*=\s*['"]([^'"]+)['"]/i.exec(attrs)?.[1];
      const xAttr = x ? ` x="${x}"` : '';
      let appended = '';
      if (stats.mode === 'webhooks') {
        if (isNum(stats.trades)) appended += `<tspan${xAttr} dy="1.2em">trades: ${Math.round(stats.trades)}</tspan>`;
        if (isNum(stats.wins)) appended += `<tspan${xAttr} dy="1.2em">wins: ${Math.round(stats.wins)}</tspan>`;
        if (isNum(stats.losses)) appended += `<tspan${xAttr} dy="1.2em">losses: ${Math.round(stats.losses)}</tspan>`;
        if (isNum(stats.winRatePct)) {
          const wr = Math.round(stats.winRatePct);
          const wrColor = wr >= 50 ? '#1BFDB2' : '#FD1B77';
          appended += `<tspan${xAttr} dy="1.2em">win rate: <tspan fill="${wrColor}">${wr}%</tspan></tspan>`;
        }
      } else {
        // rebalance mode
        if (isNum(stats.cadenceHours)) appended += `<tspan${xAttr} dy="1.2em">cadence: ${Number(stats.cadenceHours).toFixed(0)}h</tspan>`;
        if (isNum(stats.totalRebalances)) appended += `<tspan${xAttr} dy="1.2em">rebalances: ${Math.round(stats.totalRebalances)}</tspan>`;
      }
      if (stats.runtime && stats.runtime.trim()) appended += `<tspan${xAttr} dy="1.2em">runtime: ${escapeXml(stats.runtime)}</tspan>`;

      handled = true;
      return `<text ${attrs}>${colored}${appended}</text>`;
    });
    return out;
  } catch {
    return svg;
  }
}

/** Gentle nudges to keep vertical rhythm predictable. */
function tweakLayoutDynamic(
  svg: string,
  setTitleRaw: string,
  setTitleWrapped: string,
  opts = {
    baseTitleFontDec: 5,
    baseTitleDown: 12,
    baseDataDown: 26,
    perExtraLineDownTitle: 6,
    perExtraLineDownData: 10,
    longLineThreshold: 22,
  }
): string {
  try {
    const lines = setTitleWrapped.split(/\n+/).filter(Boolean);
    const lineCount = Math.max(1, lines.length);
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);

    const extraDec = longest > opts.longLineThreshold ? Math.min(3, Math.ceil((longest - opts.longLineThreshold) / 6)) : 0;
    const titleDec = opts.baseTitleFontDec + extraDec;
    const extraLines = Math.max(0, lineCount - 2);

    const titleDown = opts.baseTitleDown + extraLines * opts.perExtraLineDownTitle;
    const dataDown  = opts.baseDataDown  + extraLines * opts.perExtraLineDownData;

    const wantPlainA = setTitleRaw.replace(/\s+/g, ' ').trim().toLowerCase();
    const wantPlainB = setTitleWrapped.replace(/\s+/g, ' ').trim().toLowerCase();

    let titleDone = false, totalDone = false, pnlDone = false;

    // REGEX LITERAL -> RegExp() to avoid TSX parsing edge cases
    const re = new RegExp("<text\\b([^>]*)>([\\s\\S]*?)<\\/text>", "gi");
    return svg.replace(re, (full, attrs, inner) => {
      const plain = stripTags(inner).replace(/\s+/g, ' ').trim().toLowerCase();

      const isTitle =
        (plain === wantPlainA) ||
        (plain.includes(wantPlainA)) ||
        (plain === wantPlainB) ||
        (plain.includes(wantPlainB)) ||
        (plain.startsWith('webhooks:')) ||
        (plain.startsWith('rebalance:')) ||
        (plain.includes('sell for'));

      if (!titleDone && isTitle) {
        let a = attrs;
        a = adjustNumericAttr(a, 'y', titleDown);
        a = decreaseFontSize(a, titleDec);
        titleDone = true;
        return `<text ${a}>${inner}</text>`;
      }

      const isTotal = !totalDone && (/\btotal\b/i.test(plain));
      if (isTotal) {
        totalDone = true;
        const a = adjustNumericAttr(attrs, 'y', dataDown);
        return `<text ${a}>${inner}</text>`;
      }

      const isPnl = !pnlDone && (plain.includes('p&l') || plain.includes('p&amp;l') || plain.includes('pnl'));
      if (isPnl) {
        pnlDone = true;
        const a = adjustNumericAttr(attrs, 'y', dataDown);
        return `<text ${a}>${inner}</text>`;
      }

      return full;
    });
  } catch { return svg; }
}

function replaceFooter(svg: string, newCopy: string): string {
  try {
    let out = svg;
    const copies = [
      'generated by mojomaxi.com',
      'generated by mojomaxi.com',
      'generated by mojomaxi',
      'generated by&nbsp;mojomaxi.com',
    ];
    for (const c of copies) {
      const re = new RegExp(escapeRegExp(c), 'ig');
      out = out.replace(re, escapeXml(newCopy));
    }
    return out;
  } catch {
    return svg;
  }
}

/* ------------------------------ events fetch ------------------------------ */

async function fetchRecentEvents(setId: string, signal?: AbortSignal): Promise<AnyEvent[]> {
  const { ok, json } = await safeJson(`/api/events/recent?setId=${encodeURIComponent(setId)}&limit=500`, signal);
  if (!ok || !json) return [];
  const arr = Array.isArray((json as any)?.events) ? (json as any).events : (Array.isArray(json) ? json : []);
  return arr as AnyEvent[];
}

/* --------------------------- rasterization helpers ------------------------ */

function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = (navigator as any).platform || '';
  const maxTouchPoints = (navigator as any).maxTouchPoints || 0;
  const iOSDevice = /iP(hone|ad|od)/.test(ua);
  const iPadOS13Plus = platform === 'MacIntel' && maxTouchPoints > 1; // iPad masquerading as Mac
  return iOSDevice || iPadOS13Plus;
}

/**
 * Rasterize post-processed SVG to an **opaque** PNG Blob + object URL.
 * We paint a white layer behind content on iOS to avoid "transparent → black" flattening
 * when saving to Photos / ShareSheet re-encodes the PNG.
 *
 * Tweaked to render at higher pixel density (min ~750px on the longest side)
 * for sharper text while keeping CSS size the same.
 */
function svgToOpaquePng(svgText: string): Promise<{ blob: Blob; url: string }> {
  return new Promise((resolve, reject) => {
    try {
      const { width, height } = parseSvgSize(svgText);

      const baseW = width || 500;
      const baseH = height || 500;

      // Minimum target resolution for the **longest** side
      const minTarget = 750;
      const scale = Math.max(1, minTarget / Math.max(baseW, baseH));

      const targetW = Math.round(baseW * scale);
      const targetH = Math.round(baseH * scale);

      const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const svgUrl = URL.createObjectURL(svgBlob);
      const img = new Image();

      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('canvas');

          ctx.clearRect(0, 0, targetW, targetH);

          // Scale draw so content is rendered at higher pixel density
          ctx.setTransform(scale, 0, 0, scale, 0, 0);
          ctx.drawImage(img, 0, 0, baseW, baseH);

          if (isAppleMobile()) {
            ctx.save();
            // Reset transform so fillRect covers the full canvas
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = '#FAFAFA';
            ctx.fillRect(0, 0, targetW, targetH);
            ctx.restore();
          }

          canvas.toBlob((blob) => {
            URL.revokeObjectURL(svgUrl);
            if (!blob) return reject(new Error('toBlob failed'));
            const url = URL.createObjectURL(blob);
            resolve({ blob, url });
          }, 'image/png', 1.0);
        } catch (e) {
          URL.revokeObjectURL(svgUrl);
          reject(e);
        }
      };

      img.onerror = (e) => {
        URL.revokeObjectURL(svgUrl);
        reject(e);
      };

      img.src = svgUrl;
    } catch (e) {
      reject(e);
    }
  });
}

/* -------------------------------- component ------------------------------- */

export type SharePLCardPreviewModalProps = {
  open: boolean;
  onClose: () => void;
  imageUrl: string;
  setId?: string;
  filename?: string;
  debugId?: string;
  onDebug?: (ev: { where: string; msg: string; data?: any }) => void;
};

function toAbsoluteUrl(u: string): URL | null {
  try {
    if (typeof window !== 'undefined') return new URL(u, window.location.origin);
    return new URL(u, 'http://localhost');
  } catch {
    return null;
  }
}

/* -------------------------- extra event utilities ------------------------- */

/** Prefer the **latest** start/baseline for P&L so restart overrides earlier runs. */
function findLatestStartingUsdFromEvents(events: AnyEvent[]): number | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  // Chronological sort
  const withTs = events
    .map((e) => ({ e, t: readEventTsSec(e) }))
    .filter((x) => isNum(x.t))
    .sort((a, b) => (a.t! - b.t!));

  // Pass 1: latest explicit startingTotalUsd/startTotalUsd
  for (let i = withTs.length - 1; i >= 0; i--) {
    const v = toNum((withTs[i].e as any)?.startingTotalUsd ?? (withTs[i].e as any)?.startTotalUsd);
    if (isNum(v)) return v;
  }
  // Pass 2: latest FIRST_REBALANCE_EQUITY snapshot
  for (let i = withTs.length - 1; i >= 0; i--) {
    const e = withTs[i].e as any;
    const kind = String(e?.kind || e?.type || '').toUpperCase();
    if (kind === 'FIRST_REBALANCE_EQUITY') {
      const n = toNum(e?.totalUsdSnapshot ?? e?.baselineUsd);
      if (isNum(n)) return n;
    }
  }
  // Pass 3: other baseline-ish fields as last resort
  for (let i = withTs.length - 1; i >= 0; i--) {
    const e = withTs[i].e as any;
    const candidates = [
      e?.totalUsdSnapshot, e?.baselineUsd,
      e?.equityAtStart, e?.startEquity, e?.startTotal,
      e?.vaultUsdBefore, e?.totalUsdBefore, e?.equityBeforeUsd,
      e?.frozenTotalUsd, e?.frozen_equity_total, e?.frozenEquityUsd,
    ];
    for (const c of candidates) {
      const n = toNum(c);
      if (isNum(n)) return n;
    }
  }
  return null;
}

/** Timestamp (seconds) when the FIRST baseline equity was recorded (via start). */
function findFirstBaselineTimestampSec(events: AnyEvent[]): number | null {
  const arr = Array.isArray(events) ? events : [];
  if (arr.length === 0) return null;
  const withTs = arr
    .map((e) => ({ e, t: readEventTsSec(e) }))
    .filter((x) => isNum(x.t))
    .sort((a, b) => (a.t! - b.t!));
  for (const { t, e } of withTs) {
    const kind = String((e as any)?.kind || (e as any)?.type || '').toUpperCase();
    const hasBaselineField =
      isNum(toNum((e as any)?.startingTotalUsd ?? (e as any)?.startTotalUsd ?? (e as any)?.baselineUsd ??
                  (e as any)?.totalUsdSnapshot ?? (e as any)?.equityAtStart ?? (e as any)?.startEquity ?? (e as any)?.startTotal ??
                  (e as any)?.vaultUsdBefore ?? (e as any)?.totalUsdBefore ?? (e as any)?.equityBeforeUsd ??
                  (e as any)?.frozenTotalUsd ?? (e as any)?.frozen_equity_total ?? (e as any)?.frozenEquityUsd));
    if (kind === 'FIRST_REBALANCE_EQUITY' || hasBaselineField) return t as number;
  }
  return null;
}

function readEventTsSec(e: AnyEvent): number | null {
  const raw = e?.ts ?? e?.timestamp ?? e?.time ?? e?.blockTime ?? e?.createdAt ?? e?.created_at ?? null;
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return raw > 1e12 ? Math.round(raw / 1000) : Math.round(raw);
  }
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 1e12 ? Math.round(n / 1000) : Math.round(n);
    const d = Date.parse(raw);
    if (Number.isFinite(d)) return Math.round(d / 1000);
  }
  return null;
}

/** Compute P&L % from equity values (falling back to reconstructing starting total). */
function computePctFromEquity(totalUsd: number | null, pnlUsd: number | null, startingTotalUsd?: number | null): number | null {
  if (!isNum(totalUsd) && !isNum(pnlUsd)) return null;
  if (isNum(startingTotalUsd) && startingTotalUsd > 0 && isNum(pnlUsd)) {
    return (Number(pnlUsd) / Number(startingTotalUsd)) * 100;
  }
  if (!isNum(totalUsd) || !isNum(pnlUsd)) return null;
  const starting = Number(totalUsd) - Number(pnlUsd);
  if (starting <= 0) return null;
  return (Number(pnlUsd) / starting) * 100;
}

export default function SharePLCardPreviewModal(props: SharePLCardPreviewModalProps) {
  const { open, onClose, imageUrl, setId, debugId, onDebug } = props;
  const [loading, setLoading] = React.useState(true);
  const [errored, setErrored] = React.useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = React.useState<string>('');

  // keep the exact blob we will save/share (so Save == Preview)
  const pngBlobRef = React.useRef<Blob | null>(null);
  const previewUrlRef = React.useRef<string | null>(null);

  // Reset state whenever modal closes to avoid showing stale images between runs
  React.useEffect(() => {
    if (!open) {
      if (previewUrlRef.current) {
        try { URL.revokeObjectURL(previewUrlRef.current); } catch {}
        previewUrlRef.current = null;
      }
      pngBlobRef.current = null;
      setPreviewSrc('');
      setErrored(null);
      setLoading(true);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const ac = new AbortController();

    async function run() {
      setLoading(true);
      setErrored(null);
      setPreviewSrc('');
      pngBlobRef.current = null;
      if (previewUrlRef.current) {
        try { URL.revokeObjectURL(previewUrlRef.current); } catch {}
        previewUrlRef.current = null;
      }

      try {
        let agg: Summary | null = null;
        let setDoc: WebhookSetDoc | null = null;
        let rbDoc: RebalanceSetDoc | null = null;
        let events: AnyEvent[] = [];

        if (setId && setId.trim()) {
          agg = await fetchResolveSet(setId, ac.signal);
          try { setDoc = await fetchWebhookSetDoc(setId, ac.signal); } catch {}
          try { rbDoc = await fetchRebalanceSetDoc(setId, ac.signal); } catch {}
          try { events = await fetchRecentEvents(setId, ac.signal); } catch {}
        }

        // Compute titles for both modes and choose by botType exactly like /debug/share
        let setTitleRaw = String(agg?.setTitle || '').trim() || (setId ? `Set ${setId.slice(0,8)}` : 'mojomaxi bot');

        // --- Prepare WEBHOOKS title ---
        let webhookComputedTitle: string | null = null;
        if (setDoc) {
          const mintA = String(setDoc?.prefs?.mintA || (setDoc as any)?.mintA || '').trim();
          const mintB = String(setDoc?.prefs?.mintB || (setDoc as any)?.mintB || '').trim();
          const mintIn = String(setDoc?.prefs?.mintIn || (setDoc as any)?.mintIn || setDoc?.buyMint || '').trim();
          const mintOut = String(setDoc?.prefs?.mintOut || (setDoc as any)?.mintOut || setDoc?.sellMint || '').trim();

          // Prefer A/B schema for title semantics (A = base we buy; B = quote we sell)
          const baseMint = mintA || mintIn;
          const quoteMint = mintB || mintOut;

          let tokenMap: Record<string, TokenMeta> = {};
          const mintsToFetch = [baseMint, quoteMint].filter((x) => !!x) as string[];
          if (mintsToFetch.length) {
            tokenMap = await fetchTokenMetaMulti(mintsToFetch, ac.signal);
            const baseMissing = !!(baseMint && !tokenMap[baseMint]?.symbol);
            const quoteMissing = !!(quoteMint && !tokenMap[quoteMint]?.symbol);
            if (baseMint && baseMissing) {
              const sym = await fetchDexSymbol(baseMint, ac.signal);
              if (sym) tokenMap[baseMint] = { address: baseMint, mint: baseMint, symbol: sym } as TokenMeta;
            }
            if (quoteMint && quoteMissing) {
              const sym = await fetchDexSymbol(quoteMint, ac.signal);
              if (sym) tokenMap[quoteMint] = { address: quoteMint, mint: quoteMint, symbol: sym } as TokenMeta;
            }
          }
          webhookComputedTitle = computeWebhookTitle(setDoc, tokenMap, agg);
        }

        // SELL-only stats (for webhooks) and rebalance count from events (used by heuristics)
        let sellsLocal: number | null = null, winsLocal: number | null = null, lossesLocal: number | null = null;
        if (Array.isArray(events) && events.length) {
          let sells = 0, wins = 0, losses = 0;
          for (const e of events) {
            const dir = upper(String((e as any)?.direction || ''));
            const pnl = Number((e as any)?.pnlUsd ?? (e as any)?.pnl);
            if (dir === 'SELL' && Number.isFinite(pnl)) {
              sells++;
              if (pnl > 0) wins++;
              else if (pnl < 0) losses++;
            }
          }
          sellsLocal = sells || null;
          winsLocal = wins || null;
          lossesLocal = losses || null;
        }
        const rebalanceCountLocal = Array.isArray(events) && events.length ? countAggregatedRebalances(events) : 0;

        // --- Prepare REBALANCE title (symbols) ---
        let rebalanceComputedTitle: string | null = null;
        let mints: string[] = [];
        if (rbDoc && Array.isArray(rbDoc.mints) && rbDoc.mints.length) {
          mints = rbDoc.mints.map((x:any)=>String((x && (x.mint || x.address || x)) || '').trim()).filter(Boolean);
        } else if (events && events.length) {
          mints = extractMintsFromEvents(events);
        }
        if (mints && mints.length >= 2) {
          const symMap = await resolveSymbolsForMints(mints, ac.signal);
          const syms: string[] = mints.map(m => (symMap[m] || '').trim()).filter(Boolean);
          if (syms.length >= 2) {
            rebalanceComputedTitle = computeRebalanceTitleFromSymbols(syms);
          }
        }

        // --- Decide botType exactly like debug/share ---
        let botType: BotType = (agg?.botType || 'webhooks') as BotType;
        // DB-first classification
        const dbBotType: BotType | null = (() => {
          if (rbDoc && (String(rbDoc.type || rbDoc.kind).toLowerCase().includes('rebalance') || Array.isArray(rbDoc.mints))) return 'rebalance';
          if (setDoc) return 'webhooks';
          return null;
        })();
        if (dbBotType) botType = dbBotType;

        // Strong rebalance signals (fallback only)
        const sourcesArr = Array.isArray(agg?.sources) ? (agg!.sources as any[]) : [];
        const hasRebalanceSource = sourcesArr.some((s) => typeof s === 'string' && /\/api\/rebalance\/set\//i.test(s));
        const hasCadence = isNum(agg?.cadenceHours) || (rbDoc && parseCadenceHours((rbDoc as any).cadence) != null);
        const hasRebalanceCountAgg = isNum(agg?.totalRebalances) && Number(agg!.totalRebalances) > 0;
        const hasRebalanceEvents = rebalanceCountLocal > 0;
        const mintsFromEv = extractMintsFromEvents(events || []);
        const hasManyMints = mintsFromEv.length >= 3;
        const explicitRebalanceEvent = (events || []).some((e: any) => {
          try {
            const t = String(e?.type || e?.kind || '').toLowerCase();
            return t.includes('rebalance') || !!e?.rebalance;
          } catch { return false; }
        });

        if (!dbBotType && botType !== 'rebalance') {
          if (hasRebalanceSource || hasCadence || hasRebalanceCountAgg || hasRebalanceEvents || hasManyMints || explicitRebalanceEvent) {
            botType = 'rebalance';
          } else if (rebalanceCountLocal > 0 && (sellsLocal || 0) === 0) {
            botType = 'rebalance';
          }
        }

        // --- Finalize title by botType ---
        if (botType === 'rebalance') {
          if (rebalanceComputedTitle) setTitleRaw = rebalanceComputedTitle;
          else setTitleRaw = setTitleRaw.replace(/\s+every\s+\d+\s*h(?:rs?)?/i, '').trim();
        } else {
          if (webhookComputedTitle) setTitleRaw = webhookComputedTitle!;
        }

        // Build share params (prefer agg numbers; include parity fields)
        const shareParams: PnlShareParams & Record<string, any> = {
          setTitle: setTitleRaw || (agg?.setTitle || 'mojomaxi bot'),
          botType: botType,
          ultra: true,
          format: 'svg',
          cb: Date.now(),
        };
        if (isNum(agg?.totalUsd)) shareParams.totalUsd = agg!.totalUsd;
        if (isNum(agg?.pnlUsd)) shareParams.pnlUsd = agg!.pnlUsd;
        if (isNum(agg?.pnlPct)) shareParams.pnlPct = agg!.pnlPct;
        if (isNum(agg?.runtimeSec)) shareParams.runtimeSec = agg!.runtimeSec;
        if (isNum(agg?.bestTradeUsd)) shareParams.bestTradeUsd = agg!.bestTradeUsd;
        if (isNum(agg?.totalTrades)) shareParams.totalTrades = agg!.totalTrades;
        if (isNum(agg?.winRatePct)) shareParams.winRatePct = agg!.winRatePct;
        if (isNum(agg?.cadenceHours)) shareParams.cadenceHours = agg!.cadenceHours;
        if (isNum(agg?.totalRebalances)) shareParams.totalRebalances = agg!.totalRebalances;
        if (isNum(agg?.startedAt)) shareParams.startedAt = agg!.startedAt;
        // cadenceHours: fallback to rbDoc.cadence when missing
        if (!isNum(shareParams.cadenceHours) && botType === 'rebalance' && rbDoc && (rbDoc as any).cadence) {
          const ch = parseCadenceHours((rbDoc as any).cadence);
          if (isNum(ch)) shareParams.cadenceHours = ch;
        }

        // --- Equity + P&L fallbacks to match metrics panel parity ---
        const wallet =
          (rbDoc && typeof (rbDoc as any).wallet === 'string' && (rbDoc as any).wallet ? String((rbDoc as any).wallet) : null) ??
          (setDoc && typeof (setDoc as any).wallet === 'string' && (setDoc as any).wallet ? String((setDoc as any).wallet) : null);

        let vaultId: string | null = null;
        try {
          vaultId =
            (rbDoc && ((rbDoc as any).vault || (rbDoc as any).vaultAddress) ? String(((rbDoc as any).vault || (rbDoc as any).vaultAddress)) : null) ||
            (setDoc && ((setDoc as any).vault || (setDoc as any).vaultAddress) ? String(((setDoc as any).vault || (setDoc as any).vaultAddress)) : null) ||
            (setId ? await fetchVaultId(setId, ac.signal) : null);
        } catch {}

        let eq: EquityResponse | null = null;
        try {
          if (vaultId) {
            eq = await fetchEquity({ setId: setId!, vault: vaultId, wallet }, ac.signal);
            if (!(eq && (eq as any).ok) && wallet) {
              const alt = await fetchEquity({ setId: setId!, wallet }, ac.signal);
              if (alt && (alt as any).ok) eq = alt;
            }
          } else if (wallet) {
            eq = await fetchEquity({ setId: setId!, wallet }, ac.signal);
          } else if (setId) {
            eq = await fetchEquity({ setId: setId! }, ac.signal);
          }
        } catch {}

        const totalUsdEq = isNum((eq as any)?.totalUsd) ? Number((eq as any)!.totalUsd) : null;
        // Prefer positive equity from live endpoint over 0 from aggregator
        if (typeof totalUsdEq === 'number' && isFinite(totalUsdEq) && totalUsdEq > 0) {
          shareParams.totalUsd = totalUsdEq;
        } else if (!isNum(shareParams.totalUsd) && isNum(totalUsdEq)) {
          // As a last resort, pass through 0 if nothing else was available.
          shareParams.totalUsd = totalUsdEq as any;
        }

        // Start with whatever we already have, will override for rebalance below
        let pnlUsdLocal: number | null = isNum(shareParams.pnlUsd) ? Number(shareParams.pnlUsd as any) :
          (isNum((eq as any)?.pnlUsd) ? Number((eq as any)!.pnlUsd) : null);

        let startingTotalLocal: number | null = isNum((eq as any)?.startingTotalUsd) ? Number((eq as any)!.startingTotalUsd) : null;

        // 🔑 Rebalance parity (match MetricsPanel): P&L = equity - startingTotalUsd
        if (botType === 'rebalance') {
          // 1) Choose the equity we will use: prefer live equity; else aggregator total
          const equityForPnl: number | null =
            (isNum(totalUsdEq) && totalUsdEq > 0) ? totalUsdEq :
            (isNum(shareParams.totalUsd) ? Number(shareParams.totalUsd as any) : null);

          // 2) Choose baseline: eq.startingTotalUsd -> rbDoc.* -> latest event baseline
          let baseline: number | null = isNum(startingTotalLocal) ? startingTotalLocal : null;
          if (!isNum(baseline) && rbDoc) {
            const fromDoc = toNum(rbDoc.startingTotalUsd ?? rbDoc.startTotalUsd ?? rbDoc.totalUsdSnapshot ?? rbDoc.baselineUsd);
            if (isNum(fromDoc)) baseline = fromDoc;
          }
          if (!isNum(baseline)) {
            const fromEvents = findLatestStartingUsdFromEvents(events || []);
            if (isNum(fromEvents)) baseline = fromEvents;
          }

          if (isNum(equityForPnl) && isNum(baseline)) {
            startingTotalLocal = baseline;
            pnlUsdLocal = Number(equityForPnl) - Number(baseline);
            // Force override for rebalance: strongly prefer startingTotalUsd-based P&L
            shareParams.pnlUsd = pnlUsdLocal;
            // Also set pnlPct directly from baseline
            if (baseline > 0) shareParams.pnlPct = Number(((pnlUsdLocal / baseline) * 100).toFixed(2));
          }
        }

        // If pct still missing, compute from equity + pnl
        if (!isNum(shareParams.pnlPct)) {
          const totalForPct = isNum(shareParams.totalUsd) ? Number(shareParams.totalUsd as any) : totalUsdEq;
          const pctLocal = computePctFromEquity(totalForPct, pnlUsdLocal, startingTotalLocal);
          if (isNum(pctLocal)) shareParams.pnlPct = Number(Number(pctLocal).toFixed(2));
        }

        // Fetch server SVG
        const url = buildPnlCardUrl(shareParams);
        const r = await fetch(url, { cache: 'no-store', signal: ac.signal });
        const ct = String(r.headers.get('content-type') || '');
        if (!ct.includes('image/svg')) {
          setPreviewSrc(imageUrl);
          setErrored(`unexpected content-type: ${ct || 'unknown'}`);
          return;
        }
        let svg = await r.text();

        // Post process to match /debug/share
        svg = undimSvg(svg);
        svg = enforceSingleLineTitle(svg, setTitleRaw || 'mojomaxi bot', { maxWidth: 440, extraDownPx: 6 });
        svg = stripExistingRuntime(svg);

        // Runtime: for REBALANCE, use time since FIRST_REBALANCE_EQUITY; otherwise keep server agg.
        let runtimeSecLocal: number | null = null;
        if (botType === 'rebalance' && Array.isArray(events) && events.length) {
          const firstTsSec = findFirstBaselineTimestampSec(events);
          if (isNum(firstTsSec)) {
            const nowSec = Math.floor(Date.now() / 1000);
            runtimeSecLocal = Math.max(0, nowSec - (firstTsSec as number));
          }
        }
        if (!isNum(runtimeSecLocal) && isNum(agg?.runtimeSec)) runtimeSecLocal = Number(agg!.runtimeSec);
        const runtimeText = humanRuntime(runtimeSecLocal);
        svg = colorizeAndAppendStats(svg, {
          mode: (botType === 'rebalance' ? 'rebalance' : 'webhooks'),
          pnlUsd: isNum(pnlUsdLocal) ? pnlUsdLocal : (isNum(agg?.pnlUsd) ? agg!.pnlUsd : null),
          trades: isNum(sellsLocal) ? sellsLocal : (isNum(agg?.totalTrades) ? agg!.totalTrades! : null),
          wins: isNum(winsLocal) ? winsLocal : null,
          losses: isNum(lossesLocal) ? lossesLocal : null,
          winRatePct: isNum(agg?.winRatePct) ? agg!.winRatePct : null,
          cadenceHours: isNum(agg?.cadenceHours) ? agg!.cadenceHours : ((rbDoc && (rbDoc as any).cadence) ? parseCadenceHours((rbDoc as any).cadence) : null),
          totalRebalances: isNum(agg?.totalRebalances) ? agg!.totalRebalances :
            (Array.isArray(events) && events.length ? countAggregatedRebalances(events) : null),
          runtime: runtimeText || null,
        });
        svg = tweakLayoutDynamic(svg, setTitleRaw, setTitleRaw);
        svg = replaceFooter(svg, 'maximize your on-chain mojo at mojomaxi.com');

        // 🔑 Create the *opaque* PNG used for both preview and saving
        const { blob, url: pngUrl } = await svgToOpaquePng(svg);
        if (!cancelled) {
          pngBlobRef.current = blob;
          previewUrlRef.current = pngUrl;
          setPreviewSrc(pngUrl);
          onDebug?.({ where: 'SharePLCardPreviewModal', msg: 'png-ready', data: { debugId } });
        }
      } catch (e: any) {
        if (!cancelled) {
          setErrored(String(e?.message || e));
          setLoading(false);
        }
      }
    }

    run();

    return () => {
      cancelled = true;
      try { ac.abort(); } catch {}
    };
  }, [open, setId, imageUrl, debugId, onDebug]);

  const handleSave = React.useCallback(async () => {
    try {
      const blob = pngBlobRef.current;
      if (!blob) return;
      const filename = (props.filename && props.filename.trim()) ? props.filename.trim() : `mojomaxi-${Date.now()}.png`;
      const file = new File([blob], filename, { type: 'image/png' });

      // Prefer Web Share with files when available (Android + iOS Safari 14+)
      // Note: This keeps the opaque PNG we just rendered.
      // @ts-ignore - canShare may not be in TS lib yet
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        // @ts-ignore
        await navigator.share({ files: [file], title: filename });
        return;
      }

      // Fallback: download attribute (desktop / some Android browsers)
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      a.rel = 'noopener';
      // iOS Safari ignores download; open in a new tab so user can long-press → Save Image
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { URL.revokeObjectURL(href); } catch {}
        a.remove();
      }, 0);
    } catch (e) {
      // no-op; UI stays intact
    }
  }, [props.filename]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center p-4 overflow-y-auto">
        <div className="w-full max-w-[540px] rounded-lg border border-neutral-800 bg-neutral-900/95 shadow-xl text-white">
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800/80">
            <div className="text-sm font-medium opacity-80">mojo pro share card</div>
            <button
              onClick={onClose}
              className="rounded px-2 py-1 text-sm border border-neutral-700 hover:bg-neutral-800/60"
            >
              Close
            </button>
          </div>
          <div className="p-4">
            <div className="flex flex-col items-center gap-3">
              
              <div className="relative rounded-md" style={{ width: "min(92vw, 500px, 92vh)", height: "min(92vw, 500px, 92vh)" }}>
                {previewSrc ? (
                  <img
                    src={previewSrc}
                    alt="share-preview"
                    draggable={false}
                    className="absolute inset-0 h-full w-full rounded-md object-contain bg-transparent select-none"
                    onLoad={() => setLoading(false)}
                    onError={() => { setErrored('image failed to load'); setLoading(false); }}
                  />
                ) : null}
                {(loading || !previewSrc) && (
                  <img
                    src="/assets/pleasewait.webp"
                    alt="please-wait"
                    draggable={false}
                    className="absolute inset-0 h-full w-full rounded-md object-contain select-none"
                  />
                )}
              </div>

              {errored ? <div className="text-xs text-red-400">Error: {errored}</div> : null}

              {/* tiny purple save pill */}
              {previewSrc && !errored ? (
                <button
                  onClick={handleSave}
                  className="mt-1 rounded-full px-3 py-1 text-[11px] font-medium bg-purple-600 hover:bg-purple-500 active:bg-purple-700 focus:outline-none focus:ring-1 focus:ring-purple-400 shadow"
                  aria-label="Save image"
                >
                  Save
                </button>
              ) : null}

            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* -------------------------- more event utilities ------------------------- */

function isRebalanceEvent(e: AnyEvent): boolean {
  const fields: Array<string> = [
    e?.kind, e?.type, e?.event, e?.action, e?.direction, e?.eventType,
    Array.isArray(e?.tags) ? e.tags.join(' ') : '',
    e?.title, e?.label
  ].filter(Boolean).map((s: any) => String(s).toLowerCase());
  const joined = fields.join(' ');
  return joined.includes('rebal');
}

function rebalanceGroupKey(e: AnyEvent): string | null {
  const id =
    e?.rebalanceId ?? e?.rebalance_id ??
    e?.batchId ?? e?.batch_id ??
    e?.groupId ?? e?.group_id ??
    e?.rebalanceGroupId ?? e?.rebalance_group_id ?? null;
  if (!id) return null;
  return String(id);
}

function countAggregatedRebalances(events: AnyEvent[]): number {
  const rebals = events.filter(isRebalanceEvent);
  if (rebals.length === 0) return 0;
  const byId = new Map<string, number>();
  for (const e of rebals) {
    const key = rebalanceGroupKey(e);
    if (key) byId.set(key, (byId.get(key) || 0) + 1);
  }
  if (byId.size > 0) return byId.size;
  const times = rebals
    .map((e) => readEventTsSec(e))
    .filter((t): t is number => isNum(t))
    .sort((a, b) => a - b);
  if (times.length === 0) return rebals.length;
  let clusters = 1;
  for (let i = 1; i < times.length; i++) {
    if ((times[i] - times[i - 1]) > 90) clusters++;
  }
  return clusters;
}
