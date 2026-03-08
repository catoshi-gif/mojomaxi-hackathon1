import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { Redis } from "@upstash/redis";
import { redis } from "@/lib/redis";

/**
 * Build internal headers for server-to-server fetches within the app.
 * Mirrors what other API routes (e.g. /api/vault/equity) expect so we don't
 * hit auth/waf in production. No behavior change for callers.
 */
function buildInternalHeaders(req: NextRequest, walletHeader?: string | null): Record<string, string> {
  const headers: Record<string, string> = { "x-mm-internal": "1" };
  try {
    const auth = String(
      req.headers.get("authorization") ||
        (process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "") ||
        ""
    ).trim();
    if (auth) headers["authorization"] = auth;
  } catch {}

  try {
    const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
    if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  } catch {}

  // Optional waf / service tokens
  try {
    const internalToken =
      (
        process.env.X_MM_INTERNAL_TOKEN ||
        process.env.MM_INTERNAL_TOKEN ||
        process.env.MOJOMAXI_INTERNAL_TOKEN ||
        process.env.INTERNAL_FETCH_TOKEN ||
        ""
      ).trim();
    if (internalToken) headers["x-mm-internal-token"] = internalToken;
  } catch {}

  try {
    const cid = process.env.CF_ACCESS_CLIENT_ID;
    const csec = process.env.CF_ACCESS_CLIENT_SECRET;
    const svc = process.env.CF_ACCESS_SERVICE_TOKEN;
    if (cid && csec) {
      headers["CF-Access-Client-Id"] = cid;
      headers["CF-Access-Client-Secret"] = csec;
    } else if (svc) {
      headers["Authorization"] = `Bearer ${svc}`;
    }
  } catch {}

  if (walletHeader && walletHeader.trim()) {
    headers["x-wallet"] = walletHeader.trim();
  }

  return headers;
}

type AnyObj = Record<string, any>;
type TokenMeta = { mint: string; symbol: string; decimals: number };

const COMMON: Record<string, TokenMeta> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    decimals: 6,
  },
  DezXAZ8z7PnrnRJjz3wXBoRgiXCa6xjnB7yaB1pPB263: {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgiXCa6xjnB7yaB1pPB263",
    symbol: "BONK",
    decimals: 5,
  },
  So11111111111111111111111111111111111111112: {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    decimals: 9,
  },
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function canonicalSetId(raw: string) {
  const s = String(raw || "").trim();
  const m = s.match(/^set[_-](.+)$/i);
  return m ? m[1] : s;
}
function dashedIf32Hex(id: string): string | null {
  const no = String(id || "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(no)) return null;
  return `${no.slice(0,8)}-${no.slice(8,12)}-${no.slice(12,16)}-${no.slice(16,20)}-${no.slice(20)}`;
}
function parseJSON<T = any>(v: any): T | null {
  if (v == null) return null;
  try {
    if (typeof v === "string") return JSON.parse(v) as T;
    return v as T;
  } catch {
    return null;
  }
}

type SetMeta = { setId: string; tokenA?: TokenMeta | null; tokenB?: TokenMeta | null };
const setMetaCache: Map<string, SetMeta> = new Map();

async function fetchSetMetaFromDirect(setId: string): Promise<SetMeta | null> {
  const keys = [
    `mm:wh:set:${setId}:meta`,
    `mm:set:${setId}:meta`,
    `mm:set:${setId}:config`,
    `mm:set:${setId}`,
  ];
  for (const k of keys) {
    const val = await redis.get(k).catch(() => null);
    const obj = parseJSON(val);
    if (obj && typeof obj === "object") {
      const a = (obj as any).tokenA || (obj as any).a || (obj as any)?.tokens?.a;
      const b = (obj as any).tokenB || (obj as any).b || (obj as any)?.tokens?.b;
      if (a || b) {
        return {
          setId,
          tokenA: a
            ? {
                mint: a.mint || a.address,
                symbol: a.symbol || a.ticker,
                decimals: Number(a.decimals ?? 0),
              }
            : null,
          tokenB: b
            ? {
                mint: b.mint || b.address,
                symbol: b.symbol || b.ticker,
                decimals: Number(b.decimals ?? 0),
              }
            : null,
        };
      }
    }
  }
  return null;
}

async function fetchSetMetaFromWallet(wallet: string, setId: string): Promise<SetMeta | null> {
  const arr = parseJSON(await redis.get(`mm:set:${wallet}`).catch(() => null)) as any[] | null;
  if (Array.isArray(arr)) {
    const s = arr.find((x) => String(x?.id || x?.setId) === setId);
    if (s) {
      const a = s?.tokenA || s?.a;
      const b = s?.tokenB || s?.b;
      return {
        setId,
        tokenA: a
          ? {
              mint: a.mint || a.address,
              symbol: a.symbol || a.ticker,
              decimals: Number(a.decimals ?? 0),
            }
          : null,
        tokenB: b
          ? {
              mint: b.mint || b.address,
              symbol: b.symbol || b.ticker,
              decimals: Number(b.decimals ?? 0),
            }
          : null,
      };
    }
  }
  return fetchSetMetaFromDirect(setId);
}

async function resolveSetMeta(setId: string, wallet?: string | null): Promise<SetMeta | null> {
  const cached = setMetaCache.get(setId);
  if (cached) return cached;
  let meta: SetMeta | null = null;
  if (wallet) meta = await fetchSetMetaFromWallet(wallet, setId);
  if (!meta) meta = await fetchSetMetaFromDirect(setId);
  if (meta) setMetaCache.set(setId, meta);
  return meta;
}

function pick(meta: SetMeta | null, mint?: string | null): TokenMeta | null {
  if (!meta || !mint) return COMMON[mint as string] || null;
  if (meta.tokenA?.mint === mint) return meta.tokenA;
  if (meta.tokenB?.mint === mint) return meta.tokenB;
  return COMMON[mint] || null;
}

function deriveKindAndDirection(raw: AnyObj): {
  kind: string;
  direction?: "BUY" | "SELL";
} {
  const t = (raw as any).type;
  if (t === "deposit") return { kind: "DEPOSIT" };
  if (t === "withdraw") return { kind: "WITHDRAW" };
  const m = String(
    (raw as any).message || (raw as any).kind || (raw as any).event || ""
  )
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
  if (m.includes("swap_buy") || m === "buy")
    return { kind: "SWAP_BUY", direction: "BUY" };
  if (m.includes("swap_sell") || m === "sell")
    return { kind: "SWAP_SELL", direction: "SELL" };
  if (m.includes("deposit")) return { kind: "DEPOSIT" };
  if (m.includes("withdraw")) return { kind: "WITHDRAW" };
  if (m) return { kind: m.toUpperCase().replace(/[^A-Z0-9_]/g, "_") };
  return { kind: "EVENT" };
}

function buildHeadlineCompact(
  spentUi: number | null,
  receivedUi: number | null,
  spentSym?: string | null,
  receivedSym?: string | null
) {
  const left =
    receivedUi != null && receivedSym
      ? `${receivedUi.toLocaleString()} ${receivedSym}`
      : null;
  const right =
    spentUi != null && spentSym ? `${spentUi.toLocaleString()} ${spentSym}` : null;
  if (left && right) return `${left} → ${right}`;
  return left || right || "—";
}

// --- Price & meta helpers (Jupiter first, DexScreener fallback; 55s TTL) ---
const _priceCache = new Map<string, { v: number; t: number }>();
const _metaCache = new Map<string, { s?: string; n?: string; t: number }>();
const _TTL = 55_000;

async function _jupPricesUsd(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!mints.length) return out;
  const url = `https://price.jup.ag/v4/price?mints=${encodeURIComponent(
    mints.join(",")
  )}&vsToken=USDC`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("bad jup");
    const j = await r.json();
    const data = j?.data || {};
    for (const m of mints) {
      const p = Number(data?.[m]?.price || data?.[m]?.priceUsd);
      if (Number.isFinite(p)) out[m] = p;
    }
  } catch {}
  return out;
}

async function _dexPriceUsd(mint: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(
        mint
      )}`,
      { cache: "no-store" }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const pairs: any[] = j?.pairs || [];
    let best = 0,
      price = Number.NaN;
    for (const p of pairs) {
      const liq = Number(p?.liquidity?.usd || 0);
      const pu = Number(p?.priceUsd);
      if (liq > best && Number.isFinite(pu)) {
        best = liq;
        price = pu;
      }
    }
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

async function _pricesByMint(mints: string[]): Promise<Record<string, number>> {
  const now = Date.now();
  const uniq = Array.from(new Set(mints.filter(Boolean)));
  const need = uniq.filter((m) => {
    const c = _priceCache.get(m);
    return !(c && now - c.t < _TTL);
  });
  let jup: Record<string, number> = {};
  if (need.length) {
    jup = await _jupPricesUsd(need);
    for (const m of need) {
      const v = jup[m];
      if (Number.isFinite(v)) _priceCache.set(m, { v, t: now });
    }
  }
  for (const m of need) {
    if (!_priceCache.has(m)) {
      const d = await _dexPriceUsd(m).catch(() => null);
      if (d != null) _priceCache.set(m, { v: d, t: now });
    }
  }
  const out: Record<string, number> = {};
  for (const m of uniq) {
    const c = _priceCache.get(m);
    if (c) out[m] = c.v;
  }
  return out;
}

async function _tokenMeta(
  mint: string
): Promise<{ symbol?: string; name?: string } | null> {
  const now = Date.now();
  const c = _metaCache.get(mint);
  if (c && now - c.t < _TTL) return { symbol: c.s, name: c.n };
  try {
    const r = await fetch(
      `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}&limit=20`,
      {
        cache: "no-store",
      }
    );
    if (r.ok) {
      const j = await r.json();
      const v = j?.data || j;
      if (Array.isArray(v)) {
        const hit = v.find((x: any) => String(x?.id || x?.mint || '').trim() === mint);
        const vv = hit || v[0];
        if (vv?.symbol || vv?.name) {
          _metaCache.set(mint, { s: vv.symbol, n: vv.name, t: now });
          return { symbol: vv.symbol, name: vv.name };
        }
      }
      if (v?.symbol || v?.name) {
        _metaCache.set(mint, { s: v.symbol, n: v.name, t: now });
        return { symbol: v.symbol, name: v.name };
      }
    }
  } catch {}
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(
        mint
      )}`,
      { cache: "no-store" }
    );
    if (r.ok) {
      const j = await r.json();
      const p = (j?.pairs || [])[0]?.baseToken || {};
      const s = typeof p?.symbol === "string" ? p.symbol : undefined;
      const n = typeof p?.name === "string" ? p.name : undefined;
      if (s || n) {
        _metaCache.set(mint, { s, n, t: now });
        return { symbol: s, name: n };
      }
    }
  } catch {}
  return null;
}

// Route detector ("webhook" vs "rebalance")
function detectRoute(raw: AnyObj): "webhook" | "rebalance" | "unknown" {
  try {
    const fields = [
      String((raw as any)?.route || ""),
      String((raw as any)?.source || ""),
      String((raw as any)?.origin || ""),
      String((raw as any)?.botType || ""),
      String((raw as any)?.type || ""),
      String((raw as any)?.strategy || ""),
      String(
        (raw as any)?.title ||
          (raw as any)?.message ||
          (raw as any)?.kind ||
          (raw as any)?.event ||
          ""
      ),
    ]
      .join("|")
      .toLowerCase();

    if (fields.includes("rebalance")) return "rebalance";
    if ((raw as any)?.isRebalance === true) return "rebalance";
    if ((raw as any)?.rebalance === true) return "rebalance";
    if ((raw as any)?.rebalanceId || (raw as any)?.rebalanceSetId) return "rebalance";
    if (Array.isArray((raw as any)?.rebalancePairs)) return "rebalance";

    if (fields.includes("tradingview") || fields.includes("webhook")) return "webhook";
    if ((raw as any)?.tv === true || (raw as any)?.tvWebhook === true) return "webhook";

    const m = String(
      (raw as any)?.message || (raw as any)?.kind || (raw as any)?.event || ""
    ).toLowerCase();
    if (m.includes("swap") || m === "buy" || m === "sell") return "webhook";

    return "unknown";
  } catch {
    return "unknown";
  }
}

function toEvent(row: any, setMeta?: SetMeta | null): AnyObj | null {
  const r = parseJSON(row) ?? row;
  if (!r || typeof r !== "object") return null;

  const routeKind = detectRoute(r);

  const ts = Number((r as any).ts ?? (r as any).t ?? Date.now());
  const { kind, direction } = deriveKindAndDirection(r);
  const ok = typeof (r as any).ok === "boolean" ? (r as any).ok : undefined;
  const setId = String((r as any).setId || (r as any).set_id || "");

  let inputMint = (r as any).inputMint ?? (r as any).inMint ?? (r as any).mintIn ?? null;
  let outputMint =
    (r as any).outputMint ?? (r as any).outMint ?? (r as any).mintOut ?? null;

  // Normalize mint strings (never lowercase; mints are case-sensitive)
  inputMint = inputMint != null ? String(inputMint).trim() : inputMint;
  outputMint = outputMint != null ? String(outputMint).trim() : outputMint;


  let inSymbol = (r as any).inputSymbol ?? null;
  let outSymbol = (r as any).outputSymbol ?? null;
  const inMetaByMint = pick(setMeta || null, inputMint);
  const outMetaByMint = pick(setMeta || null, outputMint);
  inSymbol = inSymbol || inMetaByMint?.symbol || null;
  outSymbol = outSymbol || outMetaByMint?.symbol || null;

  // Hard rule: Wrapped SOL must always display as SOL, even if a stale payload symbol was provided.
  const WSOL_MINT = "So11111111111111111111111111111111111111112";
  if (inputMint === WSOL_MINT) inSymbol = "SOL";
  if (outputMint === WSOL_MINT) outSymbol = "SOL";


  const inAtoms = (r as any).amountInAtoms ?? (r as any).amountIn ?? null;
  const outAtoms = (r as any).amountOutAtoms ?? (r as any).amountOut ?? null;
  const decIn = (r as any).inputDecimals ?? inMetaByMint?.decimals ?? undefined;
  const decOut = (r as any).outputDecimals ?? outMetaByMint?.decimals ?? undefined;

  const inUiAtoms =
    inAtoms != null && typeof decIn === "number"
      ? Number(inAtoms) / Math.pow(10, decIn)
      : null;
  const outUiAtoms =
    outAtoms != null && typeof decOut === "number"
      ? Number(outAtoms) / Math.pow(10, decOut)
      : null;

  const inUiEv = (r as any).amountInUi ?? null;
  const outUiEv = (r as any).amountOutUi ?? null;

  const inUi = inUiAtoms != null ? inUiAtoms : inUiEv != null ? Number(inUiEv) : null;
  const outUi = outUiAtoms != null ? outUiAtoms : outUiEv != null ? Number(outUiEv) : null;

  const tx = (r as any).tx || (r as any).signature || null;
  const txUrl = (r as any).txUrl || (tx ? `https://solscan.io/tx/${tx}` : null);
  const txUrls = Array.isArray((r as any).txUrls)
    ? (r as any).txUrls.filter(Boolean)
    : undefined;

  const frozenInUsd = (r as any).inTotalUsd;
  const frozenOutUsd = (r as any).outTotalUsd;
  const frozenInPrice = (r as any).inUsdPrice;
  const frozenOutPrice = (r as any).outUsdPrice;

  const headlineCompact = buildHeadlineCompact(inUi, outUi, inSymbol, outSymbol);

  const out: AnyObj = {
    runId: (r as any).runId ?? undefined,
    id: String((r as any).id || (r as any).ingestId || ""),
    setId,
    ts,
    kind,
    direction,
    ok,
    txUrl,
    txUrls,
    source:
      (r as any).source ||
      (kind === "DEPOSIT" || kind === "WITHDRAW" ? "mojomaxi" : "tradingview"),
    route:
      routeKind !== "unknown"
        ? routeKind
        : kind === "DEPOSIT" || kind === "WITHDRAW"
        ? "unknown"
        : "webhook",
    headlineCompact,
    inputMint: inputMint ?? undefined,
    outputMint: outputMint ?? undefined,
    amountInUi: inUi ?? undefined,
    amountOutUi: outUi ?? undefined,
    inSymbol: inSymbol ?? undefined,
    outSymbol: outSymbol ?? undefined,
    inTotalUsd: typeof frozenInUsd === "number" ? frozenInUsd : undefined,
    outTotalUsd: typeof frozenOutUsd === "number" ? frozenOutUsd : undefined,
    inUsdPrice: typeof frozenInPrice === "number" ? frozenInPrice : undefined,
    outUsdPrice: typeof frozenOutPrice === "number" ? frozenOutPrice : undefined,
    wallet: (r as any).wallet ?? undefined,
    title: (r as any).title ?? undefined,
    type: (r as any).type ?? undefined,

    // REBALANCE passthrough
    aggregated: (r as any).aggregated === true ? true : undefined,
    totalsUiByMint:
      (r as any).totalsUiByMint ?? (r as any).lastTotalsUiByMint ?? undefined,
    totalsUsdByMint:
      (r as any).totalsUsdByMint ?? (r as any).lastTotalsUsdByMint ?? undefined,
    totalUsd: (r as any).totalUsd ?? (r as any).lastTotalUsd ?? undefined,
    startingTotalUsd: (r as any).startingTotalUsd ?? undefined,
    pnlUsd: typeof (r as any).pnlUsd === "number" ? (r as any).pnlUsd : undefined,
    pnlPct: typeof (r as any).pnlPct === "number" ? (r as any).pnlPct : undefined,
    pnlLastUsd:
      typeof (r as any).pnlLastUsd === "number"
        ? (r as any).pnlLastUsd
        : undefined,
    pnlLastPct:
      typeof (r as any).pnlLastPct === "number"
        ? (r as any).pnlLastPct
        : undefined,
    pnlPartial:
      typeof (r as any).pnlPartial === "boolean"
        ? (r as any).pnlPartial
        : undefined,
    rebalancePairs: Array.isArray((r as any).rebalancePairs)
      ? ((r as any).rebalancePairs as any[])
      : undefined,
    rebalanceNonce:
      (r as any).rebalanceNonce ?? (r as any).swapNonce ?? (r as any).nonce ?? undefined,
  };
  return out;
}

/** Lightweight Redis JSON/Hash/String fetcher */
async function _getJSONLoose(key: string): Promise<any | null> {
  try {
    const v = (await (redis as any).json?.get?.(key, "$")) as any;
    if (Array.isArray(v) && v.length) return v[0];
    if (v && typeof v === "object") return v;
  } catch {}
  try {
    const raw = await (redis as any).get(key);
    if (typeof raw === "string" && raw.trim().startsWith("{")) return JSON.parse(raw);
  } catch {}
  try {
    const h = await (redis as any).hgetall(key);
    if (h && typeof h === "object") return h;
  } catch {}
  return null;
}

/** Module-scoped helper: fetch a JSON document through internal API (honors auth headers). */
async function _getJSONLooseHTTP(_req: NextRequest, key: string): Promise<any | null> {
  // Formerly this fetched an internal debug index endpoint to retrieve cached docs while honoring
  // internal auth/WAF headers. Since debug endpoints are removed, read directly
  // from Upstash instead. This preserves the existing call sites/behavior while
  // removing the /api/debug/* dependency surface.
  return _getJSONLoose(key);
}

function _first<T>(...vals: (T | undefined | null)[]): T | null {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v as T;
  }
  return null;
}

/**
 * Enrich in-place: for the latest REBALANCE per set, if totals are missing (0/NaN/undefined),
 * prefer per-run frozen snapshot (mm:rebal:run:{setId}:{runKey}). If missing, fall back to
 * set aggregate doc (mm:rebal:set:{setId}). Final last resort calls /api/vault/equity.
 * This preserves existing behavior while ensuring cron runs get "frozen" totals.
 */
async function enrichRebalanceTotalsInPlace(
  events: AnyObj[],
  req: NextRequest,
  reqOrigin?: string
) {
  const cache = new Map<string, any>();
  const latestTsBySet = new Map<string, number>();

  for (const ev of events) {
    const k = String((ev as any)?.kind || "").toUpperCase();
    if (k !== "REBALANCE") continue;
    const sid0 = String((ev as any)?.setId || "");
    if (!sid0) continue;
    const ts0 = Number((ev as any)?.ts || 0);
    const prev = latestTsBySet.get(sid0) || 0;
    if (ts0 > prev) latestTsBySet.set(sid0, ts0);
  }

  for (const e of events) {
    const k = String((e as any).kind || "").toUpperCase();
    if (k !== "REBALANCE") continue;
    const sid = String((e as any).setId || "");
    if (!sid) continue;

    // Consider missing if 0/NaN/undefined
    const total = Number((e as any).totalUsd);
    const last = Number((e as any).lastTotalUsd);
    const hasTotals =
      (Number.isFinite(total) && total > 0) || (Number.isFinite(last) && last > 0);
    if (hasTotals) continue;

    const ts = Number((e as any)?.ts || 0);
    const latest = latestTsBySet.get(sid) || 0;
    if (ts !== latest) continue;

    // Prefer per-run frozen snapshot FIRST (so an early doc==0 never masks it)
    let totalUsd: number | null = null;
    let lastTotalUsd: number | null = null;

    try {
      const runId = String((e as any)?.runId || "").trim();
      const nonce = String(
        (e as any)?.rebalanceNonce || (e as any)?.swapNonce || (e as any)?.nonce || ""
      ).trim();
      const runKey = runId || (nonce ? `nonce:${nonce}` : "");
      if (runKey) {
        const fr =
          (await _getJSONLoose(`mm:rebal:run:${sid}:${runKey}`)) ||
          (await _getJSONLooseHTTP(req, `mm:rebal:run:${sid}:${runKey}`));
        if (fr && typeof fr === "object") {
          const snap = Number((fr as any).totalUsd);
          const lastSnap = Number((fr as any).lastTotalUsd);
          if (Number.isFinite(snap) && snap > 0) totalUsd = snap;
          if (Number.isFinite(lastSnap)) lastTotalUsd = lastSnap as any;
        }
      }
    } catch {}

    // Fallback to set aggregate doc (ignore zeros; treat them as "missing")
    let doc = cache.get(sid);
    if (!doc) {
      doc =
        (await _getJSONLoose(`mm:rebal:set:${sid}`)) ||
        (await _getJSONLoose(`mm:rebal:set_${sid}`)) ||
        (await _getJSONLoose(`mm:rebal:set-${sid}`));
      cache.set(sid, doc || null);
    }
    if (totalUsd == null && doc && typeof doc === "object") {
      const docTotalRaw = Number((doc as any).totalUsd);
      const docLastRaw = Number((doc as any).lastTotalUsd);
      const docStartRaw = Number((doc as any).startingTotalUsd);
      const docTotal = Number.isFinite(docTotalRaw) && docTotalRaw > 0 ? docTotalRaw : null;
      const docLast = Number.isFinite(docLastRaw) && docLastRaw > 0 ? docLastRaw : null;
      const docStart = Number.isFinite(docStartRaw) && docStartRaw > 0 ? docStartRaw : null;
      if (docTotal != null) {
        totalUsd = docTotal;
      } else if (docLast != null) {
        totalUsd = docLast;
        lastTotalUsd = lastTotalUsd ?? docLast;
      } else if (docStart != null) {
        totalUsd = docStart;
      }
    }
    // Last resort: equity endpoint (may be live; preserves old behavior)
    if (totalUsd == null) {
      try {
        const origin = reqOrigin || process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "";
        // EXTRA: pass wallet and vault when known (event -> set doc), and header x-wallet
        const walletHint = _first<string>((e as any)?.wallet, (doc as any)?.wallet, (doc as any)?.walletAddress);
        const vaultHint  = _first<string>((doc as any)?.vault, (doc as any)?.vaultAddress, (doc as any)?.vaultId);
        const qs = new URLSearchParams();
        qs.set("setId", sid);
        qs.set("snapshot", "1");
        if (walletHint) qs.set("wallet", walletHint);
        if (vaultHint)  qs.set("vault", vaultHint);
        const url = origin
          ? `${origin}/api/vault/equity?${qs.toString()}`
          : `/api/vault/equity?${qs.toString()}`;
        const r = await fetch(url, { cache: "no-store", headers: buildInternalHeaders(req, walletHint) });
        if (r.ok) {
          const j: any = await r.json();
          const vTotal = Number(j?.totalUsd ?? j?.equityUsd ?? j?.equity);
          const vLast  = Number(j?.startingTotalUsd ?? j?.lastTotalUsd);
          if (Number.isFinite(vTotal) && vTotal > 0) totalUsd = vTotal;
          if (Number.isFinite(vLast)) lastTotalUsd = vLast;
        }
      } catch {}
    }

    if (totalUsd != null) (e as any).totalUsd = totalUsd;
    if (lastTotalUsd != null) (e as any).lastTotalUsd = lastTotalUsd;
    if (totalUsd != null && lastTotalUsd != null) {
      const deltaUsd = totalUsd - lastTotalUsd;
      (e as any).pnlLastUsd = deltaUsd;
      (e as any).pnlLastPct = lastTotalUsd > 0 ? deltaUsd / lastTotalUsd : undefined;
    }
  }
}

/**
 * Coalesce duplicate REBALANCE rows by runId/nonce and backfill frozen totals for the latest per set.
 * Maintains existing behavior but eliminates live-equity drift for cron runs.
 *
 * PATCH (2025-12): unify near-duplicate first-run rows when one has a runKey and the other does not.
 * We alias the time-bucket to the strongest nearby runKey within the coalescing window.
 */
async function coalesceRebalanceByRunId(
  rows: AnyObj[],
  req: NextRequest
): Promise<AnyObj[]> {
  const REBALANCE_WINDOW_MS = 3 * 60_000;

  const runKeyOf = (e: AnyObj): { sid: string; key: string | null } => {
    const sid = String((e as any)?.setId || "");
    const runId = String((e as any)?.runId || "").trim();
    const nonce = String(
      (e as any)?.rebalanceNonce || (e as any)?.swapNonce || (e as any)?.nonce || ""
    ).trim();
    const key = runId || (nonce ? `nonce:${nonce}` : "");
    return { sid, key: key || null };
  };

  // Collect "strong" runs (have runKey), and build a bucket→runKey alias map.
  const strongBySet: Map<string, { ts: number; key: string }[]> = new Map();
  const bucketAliasBySet: Map<string, Map<number, string>> = new Map();

  for (const ev of rows) {
    const kindUp = String((ev as any)?.kind || "").toUpperCase();
    if (kindUp !== "REBALANCE") continue;
    const { sid, key } = runKeyOf(ev);
    if (!sid || !key) continue;
    const ts = Number((ev as any)?.ts || 0) || 0;
    const arr = strongBySet.get(sid) || [];
    arr.push({ ts, key });
    strongBySet.set(sid, arr);
    const bucket = Math.floor(ts / REBALANCE_WINDOW_MS);
    const aliases = bucketAliasBySet.get(sid) || new Map<number, string>();
    const prev = aliases.get(bucket);
    // Prefer the later run in the same bucket
    if (!prev) {
      aliases.set(bucket, key);
    } else {
      const prevTs = (strongBySet.get(sid) || []).find(x => x.key === prev)?.ts ?? -Infinity;
      if (ts >= prevTs) aliases.set(bucket, key);
    }
    bucketAliasBySet.set(sid, aliases);
  }
  for (const [sid, arr] of strongBySet) arr.sort((a, b) => a.ts - b.ts);

  // Index by (set|runKey) or time bucket, but alias buckets to nearby strong runKey when present.
  const idx: Map<string, number> = new Map();
  const out: AnyObj[] = [];

  const prefer = (a: AnyObj, b: AnyObj): AnyObj => {
    // Prefer aggregated with more txUrls; then later timestamp.
    const agA = (a as any)?.aggregated ? 1 : 0;
    const agB = (b as any)?.aggregated ? 1 : 0;
    if (agA !== agB) return agB ? b : a;
    const tA = Array.isArray((a as any)?.txUrls)
      ? ((a as any).txUrls as string[]).length
      : (a as any)?.txUrl
      ? 1
      : 0;
    const tB = Array.isArray((b as any)?.txUrls)
      ? ((b as any).txUrls as string[]).length
      : (b as any)?.txUrl
      ? 1
      : 0;
    if (tA !== tB) return tB > tA ? b : a;
    const tsA = Number((a as any)?.ts || 0);
    const tsB = Number((b as any)?.ts || 0);
    return tsB >= tsA ? b : a;
  };

  for (const ev of rows) {
    const kindUp = String((ev as any)?.kind || "").toUpperCase();
    if (kindUp !== "REBALANCE") {
      out.push(ev);
      continue;
    }

    const { sid, key } = runKeyOf(ev);
    const ts = Number((ev as any)?.ts || 0) || 0;
    const hasUrls = Array.isArray((ev as any)?.txUrls)
      ? ((ev as any).txUrls as any[]).length > 0
      : !!(ev as any)?.txUrl;
    const hasPairs =
      Array.isArray((ev as any)?.rebalancePairs) &&
      (ev as any).rebalancePairs.length > 0;
    const aggregated = !!(ev as any)?.aggregated;

    // Drop weak aggregated placeholder if a strong row exists nearby
    if (!key && aggregated && !hasUrls && !hasPairs) {
      const arr = strongBySet.get(sid) || [];
      if (arr.some(({ ts: t }) => Math.abs(t - ts) <= REBALANCE_WINDOW_MS)) {
        continue;
      }
    }

    // Choose canonical group key:
    const bucket = Math.floor(ts / REBALANCE_WINDOW_MS);
    const bucketKey = `${sid}|bucket:${bucket}`;
    const runKey = key ? `${sid}|${key}` : null;

    // If this row has no runKey, try to alias its bucket to a nearby strong run.
    let canonicalGk = runKey;
    if (!canonicalGk) {
      const alias = bucketAliasBySet.get(sid)?.get(bucket) || null;
      if (alias) {
        canonicalGk = `${sid}|${alias}`;
      } else {
        // Fallback: nearest strong run within window
        const arr = strongBySet.get(sid) || [];
        let best: { ts: number; key: string } | null = null;
        for (const r of arr) {
          if (Math.abs(r.ts - ts) <= REBALANCE_WINDOW_MS) {
            if (!best || Math.abs(r.ts - ts) < Math.abs(best.ts - ts)) best = r;
          }
        }
        canonicalGk = best ? `${sid}|${best.key}` : null;
      }
    }
    if (!canonicalGk) canonicalGk = bucketKey;

    // If we previously created a bucket group for this window, re-point it to the canonical run group.
    const otherGk = canonicalGk.startsWith(`${sid}|bucket:`) ? (runKey || "") : bucketKey;
    if (otherGk && idx.has(otherGk) && !idx.has(canonicalGk)) {
      const i = idx.get(otherGk)!;
      idx.delete(otherGk);
      idx.set(canonicalGk, i);
    }

    if (!idx.has(canonicalGk)) {
      idx.set(canonicalGk, out.length);
      out.push(ev);
    } else {
      const i = idx.get(canonicalGk)!;
      out[i] = prefer(out[i], ev);
    }
  }

  // Backfill frozen totals for latest run per set if missing (preserve old behavior + frozen-first)
  const latestTsBySet: Map<string, number> = new Map();
  for (const e of out) {
    const k = String((e as any)?.kind || "").toUpperCase();
    if (k !== "REBALANCE") continue;
    const sid = String((e as any)?.setId || "");
    const ts = Number((e as any)?.ts || 0) || 0;
    const prev = latestTsBySet.get(sid) || 0;
    if (ts > prev) latestTsBySet.set(sid, ts);
  }

  const reqOrigin = (() => {
    try {
      return new URL((req as any).url).origin;
    } catch {
      return "";
    }
  })();
  const cache: Map<string, any> = new Map();

  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    const k = String((e as any)?.kind || "").toUpperCase();
    if (k !== "REBALANCE") continue;
    const sid = String((e as any).setId || "");
    if (!sid) continue;

    // Missing considered if 0/NaN/undefined
    const total = Number((e as any).totalUsd);
    const last = Number((e as any).lastTotalUsd);
    const hasTotals =
      (Number.isFinite(total) && total > 0) || (Number.isFinite(last) && last > 0);
    if (hasTotals) continue;

    const ts = Number((e as any)?.ts || 0) || 0;
    const latest = latestTsBySet.get(sid) || 0;
    if (ts !== latest) continue;

    let totalUsd: number | null = null;
    let lastTotalUsd: number | null = null;

    // Prefer per-run frozen snapshot FIRST
    try {
      const runId = String((e as any)?.runId || "").trim();
      const nonce = String(
        (e as any)?.rebalanceNonce || (e as any)?.swapNonce || (e as any)?.nonce || ""
      ).trim();
      const runKey = runId || (nonce ? `nonce:${nonce}` : "");
      if (runKey) {
        const fr =
          (await _getJSONLoose(`mm:rebal:run:${sid}:${runKey}`)) ||
          (await _getJSONLooseHTTP(req, `mm:rebal:run:${sid}:${runKey}`));
        if (fr && typeof fr === "object") {
          const snap = Number((fr as any).totalUsd);
          const lastSnap = Number((fr as any).lastTotalUsd);
          if (Number.isFinite(snap) && snap > 0) totalUsd = snap;
          if (Number.isFinite(lastSnap)) lastTotalUsd = lastSnap as any;
        }
      }
    } catch {}

    // Next: set aggregate doc (ignore zeros; treat as missing)
    if (totalUsd == null) {
      let doc = cache.get(sid);
      if (!doc) {
        doc =
          (await _getJSONLooseHTTP(req, `mm:rebal:set:${sid}`)) ||
          (await _getJSONLooseHTTP(req, `mm:rebal:set_${sid}`)) ||
          (await _getJSONLooseHTTP(req, `mm:rebal:set-${sid}`));
        cache.set(sid, doc || null);
      }
      if (doc && typeof doc === "object") {
        const docTotalRaw = Number((doc as any).totalUsd);
        const docLastRaw = Number((doc as any).lastTotalUsd);
        const docStartRaw = Number((doc as any).startingTotalUsd);
        const docTotal =
          Number.isFinite(docTotalRaw) && docTotalRaw > 0 ? docTotalRaw : null;
        const docLast =
          Number.isFinite(docLastRaw) && docLastRaw > 0 ? docLastRaw : null;
        const docStart =
          Number.isFinite(docStartRaw) && docStartRaw > 0 ? docStartRaw : null;
        if (docTotal != null) {
          totalUsd = docTotal;
        } else if (docLast != null) {
          totalUsd = docLast;
          lastTotalUsd = lastTotalUsd ?? docLast;
        } else if (docStart != null) {
          totalUsd = docStart;
        }
      }
    }

    // Last resort: equity endpoint (may be live; preserves old behavior)
    if (totalUsd == null) {
      try {
        const origin = reqOrigin || process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "";
        // EXTRA: pass wallet and vault when known (event -> set doc), and header x-wallet
        let doc = cache.get(sid);
        if (!doc) {
          doc =
            (await _getJSONLooseHTTP(req, `mm:rebal:set:${sid}`)) ||
            (await _getJSONLooseHTTP(req, `mm:rebal:set_${sid}`)) ||
            (await _getJSONLooseHTTP(req, `mm:rebal:set-${sid}`));
          cache.set(sid, doc || null);
        }
        const walletHint = _first<string>((e as any)?.wallet, (doc as any)?.wallet, (doc as any)?.walletAddress);
        const vaultHint  = _first<string>((doc as any)?.vault, (doc as any)?.vaultAddress, (doc as any)?.vaultId);
        const qs = new URLSearchParams();
        qs.set("setId", sid);
        qs.set("snapshot", "1");
        if (walletHint) qs.set("wallet", walletHint);
        if (vaultHint)  qs.set("vault", vaultHint);
        const url = origin
          ? `${origin}/api/vault/equity?${qs.toString()}`
          : `/api/vault/equity?${qs.toString()}`;
        const r = await fetch(url, { cache: "no-store", headers: buildInternalHeaders(req, walletHint) });
        if (r.ok) {
          const j = await r.json().catch(() => ({} as any));
          const v = Number(j?.totalUsd ?? j?.equityUsd ?? j?.equity);
          if (Number.isFinite(v) && v > 0) totalUsd = v;
        }
      } catch {}
    }

    if (typeof totalUsd === "number" && Number.isFinite(totalUsd)) {
      (out[i] as any).totalUsd = totalUsd;
      if (typeof lastTotalUsd === "number" && Number.isFinite(lastTotalUsd)) {
        const deltaUsd = totalUsd - lastTotalUsd;
        (out[i] as any).pnlLastUsd = deltaUsd;
        (out[i] as any).pnlLastPct = lastTotalUsd > 0 ? deltaUsd / lastTotalUsd : undefined;
      }
    }
  }

  // Final ordering
  const chrono = out
    .slice()
    .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  return chrono;
}

/** Ensure the first REBALANCE since a FIRST_REBALANCE_EQUITY marker has no per-last P&L. */
function ensureFirstRebalanceNoPnl(rows: AnyObj[]): AnyObj[] {
  try {
    const bySet: Record<string, AnyObj[]> = {};
    const baselineTs: Record<string, number> = {};
    for (const e of rows) {
      const kindUp = String((e as any)?.kind || "").toUpperCase();
      const sid = String((e as any)?.setId || "");
      if (!sid) continue;
      if (kindUp === "FIRST_REBALANCE_EQUITY") {
        const ts = Number((e as any)?.ts || 0) || 0;
        if (!(sid in baselineTs) || ts > baselineTs[sid]) baselineTs[sid] = ts;
      } else if (kindUp === "REBALANCE") {
        (bySet[sid] ||= []).push(e);
      }
    }

    for (const sid of Object.keys(bySet)) {
      const list = bySet[sid]
        .slice()
        .sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
      const baseTs = baselineTs[sid] ?? -Infinity;
      let first: AnyObj | null = null;
      for (const ev of list) {
        const ts = Number((ev as any)?.ts || 0) || 0;
        if (ts >= baseTs) {
          first = ev;
          break;
        }
      }
      if (!first && list.length === 1) first = list[0]; // fallback if baseline not found
      if (first) {
        if ("pnlLastUsd" in first) (first as any).pnlLastUsd = undefined;
        if ("pnlLastPct" in first) (first as any).pnlLastPct = undefined;
      }
    }
    return rows;
  } catch {
    return rows;
  }
}

async function readSet(
  req: NextRequest,
  setIdRaw: string,
  limit: number
): Promise<AnyObj[]> {
  const setId = canonicalSetId(setIdRaw);
  const meta = await resolveSetMeta(setId).catch(() => null);

  const keys = [
    `mm:set:${setId}:recent`,
    `mm:events:${setId}`,
    `mm:set:${setId}:events`,
    `mm:set:set_${setId}:events`,
    `mm:set:set-${setId}:events`,
  ];
  // Read dashed variant too if this looks like a 32-hex id (compat)
  const dashed = dashedIf32Hex(setId);
  if (dashed && dashed !== setId) {
    const alt = [
      `mm:set:${dashed}:recent`,
      `mm:events:${dashed}`,
      `mm:set:${dashed}:events`,
      `mm:set:set_${dashed}:events`,
      `mm:set:set-${dashed}:events`,
    ];
    for (const k of alt) keys.push(k);
  }

  // Fetch all key variants in parallel — one round-trip per batch instead of sequential lrange calls.
  // We still honour the early-break semantics: if the first non-empty key has enough events we stop.
  // Using Promise.all here does at most keys.length concurrent lrange calls, which Upstash handles fine.
  const allArrays = await Promise.all(
    keys.map((k) => redis.lrange(k, 0, limit - 1).catch(() => []) as Promise<any[]>)
  );
  const all: AnyObj[] = [];
  for (const arr of allArrays) {
    if (Array.isArray(arr) && arr.length) {
      for (const row of arr) {
        const ev = toEvent(row, meta);
        if (ev) all.push(ev);
      }
    }
    if (all.length >= limit) break;
  }

  // Deduplicate identical rows
  const seen = new Set<string>();
  let deduped: AnyObj[] = [];
  for (const e of all) {
    const key = JSON.stringify([
      e.ts,
      e.kind,
      e.direction,
      e.inputMint,
      e.outputMint,
      e.amountInUi,
      e.amountOutUi,
      e.txUrl,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  // Keep only meaningful SWAP_REBALANCE entries (symbol or amount or tx present).
  deduped = deduped.filter((ev: any) => {
    const kindUp = String(ev?.kind || "").toUpperCase();
    if (kindUp !== "SWAP_REBALANCE") return true;
    const hasSym = !!(ev?.inSymbol || ev?.outSymbol);
    const hasAmt =
      Number(ev?.amountInUi ?? 0) > 0 || Number(ev?.amountOutUi ?? 0) > 0;
    const hasTx =
      (typeof (ev as any)?.txUrl === "string" && (ev as any)?.txUrl) ||
      (typeof (ev as any)?.signature === "string" && (ev as any)?.signature) ||
      (typeof (ev as any)?.sig === "string" && (ev as any)?.sig);
    return hasSym || hasAmt || !!hasTx;
  });

  // BUY/SELL merge (signal+tx -> single row)
  function _fpBuySell(ev: AnyObj): string | null {
    const setId = String((ev as any)?.setId || "");
    const kind = String((ev as any)?.kind || (ev as any)?.direction || "").toUpperCase();
    if (kind !== "BUY" && kind !== "SELL") return null;
    const inMint = String((ev as any)?.inputMint || "");
    const outMint = String((ev as any)?.outputMint || "");
    const amtIn = Number((ev as any)?.amountInUi ?? 0);
    const ts = Number((ev as any)?.ts || 0);
    if (!setId || !inMint || !outMint || !Number.isFinite(amtIn) || !ts) return null;
    const bucket = Math.floor(ts / 5000);
    return `${setId}|${kind}|${inMint}>${outMint}|${bucket}|${Math.round(amtIn * 1e6)}`;
  }
  function _mergeTxMeta(a: AnyObj, b: AnyObj): AnyObj {
    const runIdA = typeof (a as any)?.runId === "string" ? (a as any).runId : undefined;
    const runIdB = typeof (b as any)?.runId === "string" ? (b as any).runId : undefined;
    const runId = runIdA ?? runIdB;

    const out: AnyObj = { ...(runId ? { runId } : {}), ...a, ...b };
    const urls = new Set<string>();
    const add = (u: any) => {
      if (!u) return;
      if (Array.isArray(u)) u.forEach((x) => typeof x === "string" && x && urls.add(x));
      else if (typeof u === "string") urls.add(u);
    };
    add((a as any).txUrl);
    add((a as any).txUrls);
    add((b as any).txUrl);
    add((b as any).txUrls);
    const list = Array.from(urls);
    if (list.length === 1) (out as any).txUrl = list[0];
    if (list.length >= 1) (out as any).txUrls = list;
    const srcA = String((a as any).source || "").toLowerCase();
    const srcB = String((b as any).source || "").toLowerCase();
    if (srcA === "tradingview" || srcB === "tradingview")
      (out as any).source = "tradingview";
    const ta = Number((a as any).ts || 0),
      tb = Number((b as any).ts || 0);
    (out as any).ts = Math.max(ta, tb) || (out as any).ts || Date.now();
    return out;
  }
  function mergeBuySellSignalAndTx(list: AnyObj[]): AnyObj[] {
    const idxByFp = new Map<string, number>();
    const out: AnyObj[] = [];
    for (const ev of list) {
      const fp = _fpBuySell(ev);
      if (!fp) {
        out.push(ev);
        continue;
      }
      if (!idxByFp.has(fp)) {
        idxByFp.set(fp, out.length);
        out.push(ev);
      } else {
        const i = idxByFp.get(fp)!;
        out[i] = _mergeTxMeta(out[i], ev);
      }
    }
    return out;
  }

  // Hide aggregated REBALANCE placeholders with no tx/pairs
  function dropEmptyAggregatedRebalances(rows: AnyObj[]): AnyObj[] {
    try {
      const out: AnyObj[] = [];
      for (const e of rows || []) {
        const k = String((e as any)?.kind || "").toUpperCase();
        if (k === "REBALANCE") {
          const aggregated = !!(e as any)?.aggregated;
          const hasPairs =
            Array.isArray((e as any)?.rebalancePairs) &&
            (e as any).rebalancePairs.length > 0;
          const hasUrls = Array.isArray((e as any)?.txUrls)
            ? ((e as any).txUrls as any[]).length > 0
            : !!(e as any)?.txUrl;
          if (aggregated && !hasPairs && !hasUrls) {
            continue;
          }
        }
        out.push(e);
      }
      return out;
    } catch {
      return rows;
    }
  }

  // Step: merge BUY/SELL
  deduped = mergeBuySellSignalAndTx(deduped);

  // Step: remove weak aggregated rebalances
  deduped = dropEmptyAggregatedRebalances(deduped);

  // Step: enrich totals in-place using per-run frozen + fallbacks
  await enrichRebalanceTotalsInPlace(deduped, req, undefined);

  // Step: coalesce duplicates by runId/nonce (returns sorted desc)
  deduped = await coalesceRebalanceByRunId(deduped, req);

  // Step: ensure first REBALANCE after baseline has no P&L
  deduped = ensureFirstRebalanceNoPnl(deduped);

  // Price live for items that still lack frozen per-leg totals
  const needLive: { e: AnyObj; inMint?: string | null; outMint?: string | null }[] = [];
  const mintSet = new Set<string>();
  for (const e of deduped) {
    const hasFrozen =
      typeof (e as any).inTotalUsd === "number" ||
      typeof (e as any).outTotalUsd === "number";
    if (!hasFrozen) {
      const inMint = (e as any).inputMint || null;
      const outMint = (e as any).outputMint || null;
      if (inMint) mintSet.add(inMint);
      if (outMint) mintSet.add(outMint);
      needLive.push({ e, inMint, outMint });
    }
  }
  if (needLive.length) {
    const prices = await _pricesByMint(Array.from(mintSet));
    for (const { e, inMint, outMint } of needLive) {
      const inP = inMint ? prices[inMint] : undefined;
      const outP = outMint ? prices[outMint] : undefined;
      const inAmt = Number((e as any).amountInUi ?? 0);
      const outAmt = Number((e as any).amountOutUi ?? 0);
      if (inMint && Number.isFinite(inP))
        (e as any).inTotalUsd = Math.round(inAmt * inP * 100) / 100;
      if (outMint && Number.isFinite(outP))
        (e as any).outTotalUsd = Math.round(outAmt * outP * 100) / 100;
      if (Number.isFinite(inP)) (e as any).inUsdPrice = inP;
      if (Number.isFinite(outP)) (e as any).outUsdPrice = outP;
    }
  }

  // Compute BUY/SELL pnl pairs from per-leg USD totals
  const chrono = [...deduped].sort(
    (a, b) => Number(a?.ts || 0) - Number(b?.ts || 0)
  );
  let lastBuyUsd: number | undefined = undefined;
  for (const e of chrono) {
    const dir = String((e as any)?.direction || "").toUpperCase();
    const usdIn = Number((e as any)?.inTotalUsd ?? Number.NaN);
    const usdOut = Number((e as any)?.outTotalUsd ?? Number.NaN);

    if (dir === "BUY") {
      lastBuyUsd = Number.isFinite(usdIn) ? usdIn : undefined;
    }
    if (dir === "SELL") {
      if (Number.isFinite(usdOut) && Number.isFinite(lastBuyUsd)) {
        const base = lastBuyUsd as number;
        (e as any).pnlUsd = usdOut - base;
        (e as any).pnlPct = base > 0 ? ((e as any).pnlUsd as number) / base : undefined;
        (e as any).pnlPartial = false;
      } else {
        (e as any).pnlUsd = undefined;
        (e as any).pnlPct = undefined;
        (e as any).pnlPartial = true;
      }
      lastBuyUsd = undefined;
    }
  }

  const outFinal = chrono.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  return outFinal.slice(0, limit);
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const wallet = String(url.searchParams.get("wallet") || "").trim();
    // Wallets are CASE-SENSITIVE (Solana base58). We keep a legacy lowercase key ONLY for reading old data.
    const walletKey = wallet;
    const legacyWalletKeyLower = wallet.toLowerCase();
    const setIdRaw = String(
      url.searchParams.get("setId") || url.searchParams.get("set") || ""
    ).trim();
    const limit = clamp(Number(url.searchParams.get("limit") || 200), 1, 500);
    const sinceTs = clamp(
      Number(
        url.searchParams.get("sinceTs") ||
          url.searchParams.get("since") ||
          url.searchParams.get("cursorTs") ||
          url.searchParams.get("cursor") ||
          0
      ),
      0,
      Number.MAX_SAFE_INTEGER
    );

    const sinceTsFloor = sinceTs > 0 ? sinceTs - 1 : 0;
    const view = String(
      url.searchParams.get("view") || url.searchParams.get("format") || ""
    );
    const compactGlobal =
      view === "global" ||
      url.searchParams.get("compact") === "1" ||
      url.searchParams.get("global") === "1";

    // Per-set view
    if (setIdRaw) {
      const events = await readSet(req, setIdRaw, limit);
      return NextResponse.json(
        { ok: true, events },
        {
          status: 200,
          headers: { "cache-control": "no-store, no-cache, must-revalidate" },
        }
      );
    }

    // Wallet view: union of all known set ids for the wallet
    if (wallet) {
      let mergedSets: AnyObj[] = [];

// Fast path: wallet-scoped recent stream (written by /api/events/append).
// IMPORTANT: this is supplemental only. We still fan out per-set lists to preserve rich context.
const walletRecentKeyA = `mm:wallet:${walletKey}:recent`;
const walletRecentKeyB =
  legacyWalletKeyLower && legacyWalletKeyLower !== walletKey
    ? `mm:wallet:${legacyWalletKeyLower}:recent`
    : null;

const walletRowsA = (await redis.lrange(walletRecentKeyA, 0, limit - 1).catch(() => [])) as any[];
const walletRowsB = walletRecentKeyB
  ? ((await redis.lrange(walletRecentKeyB, 0, limit - 1).catch(() => [])) as any[])
  : [];

const walletRows = ([] as any[]).concat(walletRowsA || [], walletRowsB || []);
let walletStreamEvents: AnyObj[] = [];
if (Array.isArray(walletRows) && walletRows.length) {
  // Best-effort attach set token symbols from cached meta.
  const setIds = new Set<string>();
  for (const row of walletRows) {
    const r = parseJSON(row) ?? row;
    if (r && typeof r === "object") {
      const sid = String((r as any).setId || (r as any).set_id || "");
      if (sid) setIds.add(canonicalSetId(sid));
    }
  }
  await Promise.all(
    Array.from(setIds).map((sid) => resolveSetMeta(sid, walletKey).catch(() => null))
  );

  walletStreamEvents = walletRows
    .map((row) => {
      const r = parseJSON(row) ?? row;
      const sid =
        r && typeof r === "object"
          ? canonicalSetId(String((r as any).setId || (r as any).set_id || ""))
          : "";
      const meta = sid ? setMetaCache.get(sid) || null : null;
      return toEvent(row, meta);
    })
    .filter(Boolean) as AnyObj[];
}
      const [
        setIdsSetA,
        setIdsSetB,
        setIdsListA,
        setIdsListB,
        rebalIdsSetA,
        rebalIdsSetB,
        rebalIdsListA,
        rebalIdsListB,
      ] = (await Promise.all([
        redis.smembers(`mm:wallet:${walletKey}:sets`).catch(() => []),
        legacyWalletKeyLower !== walletKey
          ? redis.smembers(`mm:wallet:${legacyWalletKeyLower}:sets`).catch(() => [])
          : Promise.resolve([]),
        redis.lrange(`mm:wh:sets:${walletKey}:list`, 0, -1).catch(() => []),
        legacyWalletKeyLower !== walletKey
          ? redis.lrange(`mm:wh:sets:${legacyWalletKeyLower}:list`, 0, -1).catch(() => [])
          : Promise.resolve([]),
        redis.smembers(`mm:rebal:wallet:${walletKey}:sets`).catch(() => []),
        legacyWalletKeyLower !== walletKey
          ? redis.smembers(`mm:rebal:wallet:${legacyWalletKeyLower}:sets`).catch(() => [])
          : Promise.resolve([]),
        redis.lrange(`WALLET_REBAL_SETS:${walletKey}`, 0, -1).catch(() => []),
        legacyWalletKeyLower !== walletKey
          ? redis.lrange(`WALLET_REBAL_SETS:${legacyWalletKeyLower}`, 0, -1).catch(() => [])
          : Promise.resolve([]),
      ])) as string[][];

      const ids = Array.from(
        new Set([
          ...(setIdsSetA || []),
          ...(setIdsSetB || []),
          ...(setIdsListA || []),
          ...(setIdsListB || []),
          ...(rebalIdsSetA || []),
          ...(rebalIdsSetB || []),
          ...(rebalIdsListA || []),
          ...(rebalIdsListB || []),
        ])
      ) as string[];

      if (ids.length > 0) {
        const lists = await Promise.all(ids.map((id) => readSet(req, id, limit)));
        mergedSets = ([] as AnyObj[]).concat(...lists);
        mergedSets.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
      } else {
        // Fallback: filter recent global events by wallet
        const list = (await redis
          .lrange(`mm:events:recent`, 0, limit * 5)
          .catch(() => [])) as any[];
        const events = (list || [])
          .map((row) => toEvent(row, null))
          .filter(Boolean)
          .filter((e) => String((e as any)?.wallet || "") === wallet) as AnyObj[];
        events.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
        mergedSets = events.slice(0, limit);
      }

// Merge wallet recent stream (supplemental) after per-set/global aggregation.
if (walletStreamEvents && walletStreamEvents.length) {
  mergedSets = ([] as AnyObj[]).concat(mergedSets || [], walletStreamEvents || []);
  mergedSets.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
}


      // Clean up DEPOSIT/WITHDRAW noise
      // NOTE: RebalanceInlinePanel appends minimal WITHDRAW/DEPOSIT rows that may use legacy fields
      // (symbol/amountUi/tx) instead of inSymbol/outSymbol + amountInUi/amountOutUi. We must not
      // drop real user actions from the wallet activity stream.
      const cleaned = mergedSets.filter((ev: any) => {
        const K = String(ev?.kind || "").toUpperCase();
        if (K === "DEPOSIT" || K === "WITHDRAW") {
          const hasTx = !!(
            ev?.tx ||
            ev?.signature ||
            ev?.sig ||
            ev?.txid ||
            (typeof ev?.txUrl === "string" && ev.txUrl.includes("/tx/"))
          );

          // If we have a tx, it's a real on-chain action — keep it even if metadata is missing.
          if (hasTx) return true;

          const amt = Number(
            ev?.amountInUi ??
              ev?.amountOutUi ??
              ev?.amountUi ??
              ev?.uiAmount ??
              ev?.uiAmountString ??
              ev?.amount ??
              0
          );

          const hasSym = !!(
            ev?.inSymbol ||
            ev?.outSymbol ||
            ev?.symbol ||
            ev?.inputSymbol ||
            ev?.outputSymbol
          );

          const hasMint = !!(
            ev?.mint ||
            ev?.inMint ||
            ev?.outMint ||
            ev?.inputMint ||
            ev?.outputMint
          );

          return (Number.isFinite(amt) && amt > 0 && (hasSym || hasMint)) || (hasSym || hasMint);
        }
        return true;
      });

      // Deduplicate across sets
      const seen = new Set<string>();
      const out: AnyObj[] = [];
      for (const e of cleaned) {
        const k = `${e?.id || ""}|${e?.ts || ""}|${e?.kind || ""}|${e?.inMint || ""}|${
          e?.outMint || ""
        }|${e?.amountInUi || ""}|${e?.amountOutUi || ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
        if (out.length >= limit) break;
      }
      return NextResponse.json(
        { ok: true, events: out },
        {
          status: 200,
          headers: { "cache-control": "no-store, no-cache, must-revalidate" },
        }
      );
    }

    // Global view
    const fetchN = compactGlobal ? Math.min(limit * 5, 500) : limit;
    const list = (await redis
      .lrange(`mm:events:recent`, 0, fetchN - 1)
      .catch(() => [])) as any[];
    const eventsFull = (list || [])
      .map((row) => toEvent(row, null))
      .filter(Boolean) as AnyObj[];
    if (compactGlobal) {
      const swaps = eventsFull.filter((e: any) =>
        /swap|buy|sell/i.test(String(e?.kind || ""))
      );
      const trimmed = swaps.slice(0, limit).map((e: any) => {
        const inSym =
          e?.inSymbol || e?.inputSymbol || e?.tokenIn?.symbol || null;
        const outSym =
          e?.outSymbol || e?.outputSymbol || e?.tokenOut?.symbol || null;
        const base = inSym;
        const quote = outSym;
        const pair = base && quote ? `${base}/${quote}` : undefined;
        const route = detectRoute(e);
        return {
          ts: e?.ts,
          t: e?.ts,
          kind: e?.kind,
          route,
          base,
          quote,
          pair,
          inSymbol: inSym,
          outSymbol: outSym,
          inMint: e?.inMint || e?.mintIn || e?.inputMint || e?.tokenIn?.mint || null,
          outMint:
            e?.outMint || e?.mintOut || e?.outputMint || e?.tokenOut?.mint || null,
          amountInUi: e?.amountInUi ?? e?.inAmountUi ?? null,
          amountOutUi: e?.amountOutUi ?? e?.outAmountUi ?? null,
          inUsdPrice: e?.inUsdPrice ?? null,
          outUsdPrice: e?.outUsdPrice ?? null,
          inTotalUsd: e?.inTotalUsd ?? null,
          outTotalUsd: e?.outTotalUsd ?? null,
        };
      });
      const latestTs = Math.max(
  0,
  ...trimmed.map((e: any) => Number(e?.ts ?? e?.t ?? 0)).filter((n: any) => Number.isFinite(n))
);
const etag = `W/"events:${walletKey || setIdRaw || "all"}:${latestTs}"`;
const inm = req.headers.get("if-none-match");
if (inm && inm === etag) {
  return new Response(null, {
    status: 304,
    headers: {
      etag,
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}
const outEvents = sinceTs > 0
  ? trimmed.filter((e: any) => Number(e?.ts ?? e?.t ?? 0) > sinceTsFloor)
  : trimmed;
return NextResponse.json(
  { ok: true, events: outEvents, cursorTs: latestTs, mode: sinceTs > 0 ? "delta" : "full" },
  {
    status: 200,
    headers: { etag, "cache-control": "no-store, no-cache, must-revalidate" },
  }
);
    }
    const latestTs = Math.max(
  0,
  ...eventsFull.map((e: any) => Number(e?.ts ?? e?.t ?? 0)).filter((n: any) => Number.isFinite(n))
);
const etag = `W/"events:${walletKey || setIdRaw || "all"}:${latestTs}"`;
const inm = req.headers.get("if-none-match");
if (inm && inm === etag) {
  return new Response(null, {
    status: 304,
    headers: {
      etag,
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}
const outEvents = sinceTs > 0
  ? eventsFull.filter((e: any) => Number(e?.ts ?? e?.t ?? 0) > sinceTsFloor)
  : eventsFull;
return NextResponse.json(
  { ok: true, events: outEvents, cursorTs: latestTs, mode: sinceTs > 0 ? "delta" : "full" },
  {
    status: 200,
    headers: { etag, "cache-control": "no-store, no-cache, must-revalidate" },
  }
);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "events_error" },
      { status: 500 }
    );
  }
}
