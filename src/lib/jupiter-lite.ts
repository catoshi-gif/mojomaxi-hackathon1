/**
 * Jupiter API (Pro host) client (swap/v1) — hardened + per-call filters + safer swap-instructions defaults.
 *
 * - Host: https://api.jup.ag (sanitized)
 * - Quote: minimal required params; supports per-call onlyDirectRoutes via QuotePlan (positional call)
 * - Env filters: JUP_ONLY_DIRECT / JUP_EXCLUDE_DEXES (merged; per-call overrides env for onlyDirectRoutes)
 * - Swap-instructions: defaults to useSharedAccounts=false and useTokenLedger=false unless caller/env overrides
 * - Back-compat: legacy named exports and positional signatures preserved
 */

export type QuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  slippageBps: number;
};

export type QuotePlan = {
  slippageBps: number;
  onlyDirectRoutes?: boolean;
  restrictIntermediateTokens?: boolean; // ignored on Lite
  dexesOnly?: string[] | undefined;     // ignored on Lite
  excludeDexes?: string[] | undefined;  // we only support via env (CSV)
  maxAccounts?: number;                  // ignored on Lite quote
  asLegacyTransaction?: boolean;         // ignored on Lite quote
  platformFeeBps?: number;
};

export type QuoteResponse = {
  routePlan: any[];
  inAmount: string;
  outAmount: string;
  other?: any;
};

export type SwapInstructionsParams = {
  quoteResponse: any;
  userPublicKey: string;
  destinationTokenAccount?: string;
  feeAccount?: string;
  useSharedAccounts?: boolean;
  useTokenLedger?: boolean;
  wrapAndUnwrapSol?: boolean;
  dynamicComputeUnitLimit?: boolean;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  prioritizationFeeLamports?: number;
  asLegacyTransaction?: boolean;
  restrictIntermediateTokens?: boolean; // scrubbed
};

export class JupiterApiError extends Error {
  status: number;
  body?: any;
  errorCode?: string;
  constructor(message: string, status: number, body?: any, errorCode?: string) {
    super(message);
    this.name = 'JupiterApiError';
    this.status = status;
    this.body = body;
    this.errorCode = errorCode;
  }
}

// --- BASE sanitizer ---
function sanitizeBase(raw?: string | null): string {
  const dflt = 'https://api.jup.ag';
  if (!raw) return dflt;
  let s = String(raw).trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('/swap/v1')) s = s.slice(0, -8);
  else if (s.endsWith('/swap')) s = s.slice(0, -5);
  return s || dflt;
}


function authHeaders(extra?: Record<string, string>): HeadersInit {
  const key = String(process.env.JUP_API_KEY || process.env.JUPITER_API_KEY || "").trim();
  const h: Record<string, string> = { ...(extra || {}) };
  if (key) h["x-api-key"] = key;
  return h;
}

const BASE = sanitizeBase(process.env.JUPITER_LITE_BASE);
const QUOTE_URL = `${BASE}/swap/v1/quote`;
const SWAP_INSTR_URL = `${BASE}/swap/v1/swap-instructions`;

function isNotSupportedPlan(err: unknown): boolean {
  const e = err as any;
  const code = e?.errorCode || e?.body?.errorCode;
  const msg = (e?.message || '').toString();
  return code === 'NOT_SUPPORTED' || msg.includes('NOT_SUPPORTED') || msg.toLowerCase().includes('not supported');
}
function isHttpErrorWithStatus(err: unknown, status: number): boolean {
  const e = err as any;
  return !!e && typeof e.status === 'number' && e.status === status;
}

// Required fields only
function requiredQuoteParams(params: QuoteParams): Record<string, any> {
  return {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: typeof params.amount === 'string' ? params.amount : String(params.amount),
    slippageBps: params.slippageBps,
  };
}

function optionalFiltersFromEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (String(process.env.JUP_ONLY_DIRECT || '').toLowerCase() === 'true') out.onlyDirectRoutes = 'true';
  const ex = (process.env.JUP_EXCLUDE_DEXES || '').trim();
  if (ex) out.excludeDexes = ex;
  return out;
}

function optionalFiltersFromPlan(plan?: QuotePlan): Record<string, string> {
  const out: Record<string, string> = {};
  if (plan?.onlyDirectRoutes === true) out.onlyDirectRoutes = 'true';
  return out;
}

async function doFetchJson(url: string, init?: RequestInit) {
  const mergedInit: RequestInit = { ...(init || {}) };
  mergedInit.headers = authHeaders((init as any)?.headers as any);
  const res = await fetch(url, mergedInit);
  const text = await res.text();
  let body: any = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!res.ok) {
    const errMsg = `Jupiter API ${res.status} ${res.statusText} @ ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`;
    const errorCode = (body && typeof body === 'object' ? (body as any).errorCode : undefined) || (body as any)?.code;
    throw new JupiterApiError(errMsg, res.status, body, errorCode);
  }
  return body;
}

export async function getQuote(rawParams: QuoteParams, plan?: QuotePlan): Promise<QuoteResponse> {
  // Start with required fields; merge env filters and per-call plan filters (plan overrides env for onlyDirectRoutes)
  const req = { ...requiredQuoteParams(rawParams), ...optionalFiltersFromEnv(), ...optionalFiltersFromPlan(plan) };
  const url = QUOTE_URL + '?' + new URLSearchParams(
    Object.fromEntries(Object.entries(req).map(([k, v]) => [k, String(v)]))
  ).toString();

  try {
    return await doFetchJson(url);
  } catch (e) {
    if (isNotSupportedPlan(e) || isHttpErrorWithStatus(e, 404)) {
      const req2 = requiredQuoteParams(rawParams); // retry without optional filters
      const retryUrl = QUOTE_URL + '?' + new URLSearchParams(
        Object.fromEntries(Object.entries(req2).map(([k, v]) => [k, String(v)]))
      ).toString();
      return await doFetchJson(retryUrl);
    }
    throw e;
  }
}

export async function getSwapInstructions(payload: SwapInstructionsParams & { quoteResponse: any }): Promise<any> {
  const scrubbed: any = { ...payload };

  // Safer defaults to avoid shared-accounts/token-ledger edge cases in some pools
  if (typeof scrubbed.useSharedAccounts === 'undefined') {
    scrubbed.useSharedAccounts = String(process.env.JUP_USE_SHARED || '').toLowerCase() === 'true' ? true : false;
  }
  if (typeof scrubbed.useTokenLedger === 'undefined') {
    scrubbed.useTokenLedger = String(process.env.JUP_USE_TOKEN_LEDGER || '').toLowerCase() === 'true' ? true : false;
  }
  if (typeof scrubbed.wrapAndUnwrapSol === 'undefined') {
    scrubbed.wrapAndUnwrapSol = true;
  }

  delete scrubbed.restrictIntermediateTokens; // never send
  if (!scrubbed.quoteResponse) throw new Error('quoteResponse is required');
  if (!scrubbed.userPublicKey) throw new Error('userPublicKey is required');

  return doFetchJson(SWAP_INSTR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scrubbed),
  });
}

// Legacy positional-call wrappers
export function jupLiteQuote(inputMint: string, outputMint: string, amount: string, plan: QuotePlan): Promise<QuoteResponse>;
export function jupLiteQuote(params: QuoteParams): Promise<QuoteResponse>;
export function jupLiteQuote(a: any, b?: any, c?: any, d?: any): Promise<QuoteResponse> {
  if (typeof a === 'string' && typeof b === 'string' && typeof c === 'string') {
    const plan: QuotePlan = (d || {}) as QuotePlan;
    return getQuote({ inputMint: a, outputMint: b, amount: c, slippageBps: plan.slippageBps ?? 100 }, plan);
  }
  return getQuote(a as QuoteParams);
}

export function jupLiteSwapInstructions(quoteResponse: any, userPublicKey: string, opts?: Partial<SwapInstructionsParams>): Promise<any>;
export function jupLiteSwapInstructions(payload: SwapInstructionsParams & { quoteResponse: any }): Promise<any>;
export function jupLiteSwapInstructions(a: any, b?: any, c?: any): Promise<any> {
  if (a && typeof b === 'string' && (c === undefined || typeof c === 'object')) {
    const payload: any = { quoteResponse: a, userPublicKey: b, ...(c || {}) };
    return getSwapInstructions(payload);
  }
  return getSwapInstructions(a as any);
}

const jupiterLite = { getQuote, getSwapInstructions, jupLiteQuote, jupLiteSwapInstructions };
export default jupiterLite;
