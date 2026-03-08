/**
 * Jupiter Pro client (swap/v1) — authenticated API with Dynamic Slippage, Platform Fees, and Priority/Jito tips.
 * Host: https://api.jup.ag (override with JUPITER_PRO_BASE)
 * Auth: header 'x-api-key' = process.env.JUP_API_KEY
 */
export type QuoteParams = { inputMint: string; outputMint: string; amount: string | number; slippageBps: number; };
export type QuotePlan = {
  slippageBps: number;
  // When set (true/false), this should override any env-level default filter.
  // (We use this to avoid accidentally re-introducing direct-only routing.)
  onlyDirectRoutes?: boolean;
  restrictIntermediateTokens?: boolean;
  dexesOnly?: string[] | undefined;
  // When null, we will OMIT excludeDexes entirely and also suppress env-level default excludes.
  // When undefined, env defaults may apply.
  excludeDexes?: string[] | null | undefined;
  maxAccounts?: number | undefined;
  asLegacyTransaction?: boolean | undefined;
  platformFeeBps?: number | undefined;
};
export type QuoteResponse = { routePlan: any[]; inAmount: string; outAmount: string; other?: any; };
export type PrioritizationFeeLamports =
  | number | 'auto' | { jitoTipLamports: number }
  | { priorityLevelWithMaxLamports: { maxLamports: number; global?: boolean; priorityLevel?: 'medium'|'high'|'veryHigh' } };

export class JupiterApiError extends Error {
  status: number;
  body?: any;
  errorCode?: string;
  url?: string;

  // Back-compat constructor:
  // - (message, status:number, body?, errorCode?)
  // - (message, body, url, statusAsString)
  constructor(message: string, a: any, b?: any, c?: any) {
    super(message);
    this.name = "JupiterApiError";

    if (typeof a === "number") {
      this.status = a;
      this.body = b;
      this.errorCode = c;
    } else {
      // legacy ordering used by some helpers: (message, body, url, status)
      this.body = a;
      this.url = typeof b === "string" ? b : undefined;
      const st = typeof c === "number" ? c : Number(String(c || 0));
      this.status = Number.isFinite(st) ? st : 0;
      this.errorCode = message;
    }
  }
}


function sanitizeBase(raw?: string | null): string {
  const dflt = 'https://api.jup.ag';
  if (!raw) return dflt;
  let s = String(raw).trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('/swap/v1')) s = s.slice(0, -8);
  else if (s.endsWith('/swap')) s = s.slice(0, -5);
  return s || dflt;
}
const BASE = sanitizeBase(process.env.JUPITER_PRO_BASE);
const QUOTE_URL = `${BASE}/swap/v1/quote`;
const SWAP_INSTR_URL = `${BASE}/swap/v1/swap-instructions`;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = (process.env.JUP_API_KEY || '').trim();
  const hdrs: Record<string, string> = { 'content-type': 'application/json' };
  if (key) hdrs['x-api-key'] = key;
  return { ...hdrs, ...(extra || {}) };
}
async function doFetchJson(url: string, init?: RequestInit, timeoutMs?: number) {
  const ctl = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...(init || {}), signal: ctl?.signal as any });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const code =
        body && typeof body === "object"
          ? (body as any).error || (body as any).code || "http_error"
          : "http_error";
      throw new JupiterApiError(String(code), res.status, body, String(code));
    }
    return body as any;
  } finally {
    if (t) clearTimeout(t as any);
  }
}
function optionalFiltersFromPlan(plan?: QuotePlan): Record<string, string> {
  const out: Record<string, string> = {};
  // onlyDirectRoutes=false is handled by *suppressing* env defaults in getQuote.
  // We only emit the query param when true.
  if (plan?.onlyDirectRoutes === true) out.onlyDirectRoutes = 'true';
  if (typeof plan?.restrictIntermediateTokens === 'boolean') out.restrictIntermediateTokens = plan.restrictIntermediateTokens ? 'true' : 'false';
  if (Array.isArray(plan?.dexesOnly) && plan.dexesOnly.length) out.dexesOnly = plan.dexesOnly.join(',');
  if (plan?.excludeDexes === null) {
    // caller explicitly requests NO excludeDexes param
  } else if (Array.isArray(plan?.excludeDexes) && plan.excludeDexes.length) {
    out.excludeDexes = plan.excludeDexes.join(',');
  }
  if (typeof plan?.maxAccounts === 'number') out.maxAccounts = String(plan.maxAccounts);
  if (typeof plan?.asLegacyTransaction === 'boolean') out.asLegacyTransaction = plan.asLegacyTransaction ? 'true' : 'false';
  if (typeof plan?.platformFeeBps === 'number') out.platformFeeBps = String(plan.platformFeeBps);
  return out;
}


function requiredQuoteParams(raw: QuoteParams): Record<string, string> {
  const inputMint = String((raw as any)?.inputMint || "").trim();
  const outputMint = String((raw as any)?.outputMint || "").trim();
  const amount = String((raw as any)?.amount ?? "").trim();
  const slippageBps = Number((raw as any)?.slippageBps);
  if (!inputMint || !outputMint) throw new Error("invalid_quote_params:missing_mints");
  if (!amount) throw new Error("invalid_quote_params:missing_amount");
  if (!Number.isFinite(slippageBps)) throw new Error("invalid_quote_params:missing_slippage_bps");
  return {
    inputMint,
    outputMint,
    amount,
    slippageBps: String(Math.max(0, Math.min(10_000, Math.floor(slippageBps)))),
    dynamicSlippage: "true",
  };
}

export async function getQuote(raw: QuoteParams, plan?: QuotePlan): Promise<QuoteResponse> {
  // Env defaults are helpful, but for certain attempts we need to explicitly *suppress* them.
  const env = optionalFiltersFromEnv();
  // If caller wants direct routing disabled, remove any env-onlyDirectRoutes default.
  if (plan?.onlyDirectRoutes === false) delete env.onlyDirectRoutes;
  // If caller explicitly requests no excludeDexes, suppress env excludes.
  if (plan?.excludeDexes === null) delete env.excludeDexes;

  const req = { ...requiredQuoteParams(raw), ...env, ...optionalFiltersFromPlan(plan) };
  const url = QUOTE_URL + '?' + new URLSearchParams(Object.fromEntries(Object.entries(req).map(([k,v]) => [k, String(v)]))).toString();
  return doFetchJson(url, { method: 'GET', headers: authHeaders() });
}


function optionalFiltersFromEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  // Default filters controlled by env
  const onlyDirect = String(process.env.JUP_ONLY_DIRECT || "").toLowerCase();
  if (onlyDirect === "true" || onlyDirect === "1" || onlyDirect === "yes") {
    out.onlyDirectRoutes = "true";
  }

  const restrictInter = String(process.env.JUP_RESTRICT_INTERMEDIATE_TOKENS || "").toLowerCase();
  if (restrictInter === "true" || restrictInter === "1" || restrictInter === "yes") {
    out.restrictIntermediateTokens = "true";
  }

  const dexesOnly = String(process.env.JUP_ONLY_DEXES || "").trim();
  if (dexesOnly) out.dexesOnly = dexesOnly;

  const excludeDexes = String(process.env.JUP_EXCLUDE_DEXES || "").trim();
  if (excludeDexes) out.excludeDexes = excludeDexes;

  const maxAccountsRaw = String(process.env.JUP_MAX_ACCOUNTS || "").trim();
  if (maxAccountsRaw) out.maxAccounts = maxAccountsRaw;

  const legacyRaw = String(process.env.JUP_AS_LEGACY_TRANSACTION || "").toLowerCase();
  if (legacyRaw === "true" || legacyRaw === "1" || legacyRaw === "yes") out.asLegacyTransaction = "true";

  const feeBpsRaw = String(process.env.JUP_PLATFORM_FEE_BPS || "").trim();
  if (feeBpsRaw) out.platformFeeBps = feeBpsRaw;

  return out;
}

export type SwapInstructionsParams = {
  quoteResponse: any; userPublicKey: string;
  destinationTokenAccount?: string; feeAccount?: string; useSharedAccounts?: boolean; useTokenLedger?: boolean; wrapAndUnwrapSol?: boolean;
  dynamicComputeUnitLimit?: boolean; computeUnitLimit?: number; computeUnitPriceMicroLamports?: number;
  prioritizationFeeLamports?: number | 'auto' | { jitoTipLamports: number } | { priorityLevelWithMaxLamports: { maxLamports: number; global?: boolean; priorityLevel?: 'medium'|'high'|'veryHigh' } };
  asLegacyTransaction?: boolean;
  dynamicSlippage?: boolean | { maxBps: number; minBps?: number };
};
export async function getSwapInstructions(payload: SwapInstructionsParams): Promise<any> {
  const p:any = { ...payload };
  if (typeof p.useSharedAccounts === 'undefined') p.useSharedAccounts = true;
  if (typeof p.useTokenLedger === 'undefined') p.useTokenLedger = false;
  if (typeof p.wrapAndUnwrapSol === 'undefined') p.wrapAndUnwrapSol = true;
  if (typeof p.dynamicSlippage === 'undefined' && String(process.env.JUP_DYNAMIC_SLIPPAGE || '').toLowerCase() === 'true') {
    const max = Number(process.env.JUP_DYNAMIC_SLIPPAGE_MAX_BPS || 0); p.dynamicSlippage = max > 0 ? { maxBps: max } : true;
  }
  return doFetchJson(SWAP_INSTR_URL, { method:'POST', headers: authHeaders(), body: JSON.stringify(p) });
}

// Back-compat wrappers
export function jupProQuote(inputMint: string, outputMint: string, amount: string, plan: QuotePlan): Promise<QuoteResponse>;
export function jupProQuote(params: QuoteParams, plan?: QuotePlan): Promise<QuoteResponse>;
export function jupProQuote(a:any, b?:any, c?:any, d?:any): Promise<QuoteResponse> {
  if (typeof a==='string' && typeof b==='string' && typeof c==='string') {
    const plan = (typeof d==='object' ? d : undefined) as QuotePlan | undefined;
    return getQuote({ inputMint:a, outputMint:b, amount:c, slippageBps: plan?.slippageBps ?? 50 }, plan);
  }
  return getQuote(a as QuoteParams, b as QuotePlan | undefined);
}
export function jupProSwapInstructions(quoteResponse:any, userPublicKey:string, opts?: Partial<SwapInstructionsParams>): Promise<any>;
export function jupProSwapInstructions(payload: SwapInstructionsParams): Promise<any>;
export function jupProSwapInstructions(a:any, b?:any, c?:any): Promise<any> {
  if (a && typeof b === 'string' && (c === undefined || typeof c === 'object')) {
    const payload:any = { quoteResponse:a, userPublicKey:b, ...(c||{}) }; return getSwapInstructions(payload);
  }
  return getSwapInstructions(a as any);
}
const jupiterPro = { getQuote, getSwapInstructions, jupProQuote, jupProSwapInstructions };
export default jupiterPro;
