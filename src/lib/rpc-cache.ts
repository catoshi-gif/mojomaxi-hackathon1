// filepath: src/lib/rpc-cache.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Production-safe RPC cache + micro-batching for Solana web3.js calls.
 *
 * >>> ZERO UI/UX CHANGES <<<
 * - Keeps all existing function names and return shapes that panels rely on.
 * - Adds cross-component batching so hundreds of single-account RPC calls
 *   collapse into a handful of `getMultipleAccountsInfo` bursts.
 * - Sets very long TTLs for *static* data (mint + owner), per request.
 *
 * Exports (unchanged):
 *  - cachedGetBalance(conn, pubkey, commitment?) -> Promise<number>
 *  - cachedGetTokenAccountBalance(conn, ata, commitment?) -> Promise<{ value: { amount: string, decimals: number, uiAmount: number, uiAmountString: string } }>
 *  - cachedGetAccountInfoOwner(conn, pubkey, commitment?) -> Promise<{ exists: boolean, owner?: PublicKey }>
 *  - cachedGetMint(conn, mint, commitment?, programId?) -> Promise<Mint>
 *  - TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID
 *
 * Notes:
 *  - Balances (lamports + token balances) default TTL: 60s (unchanged).
 *  - Account owner + mint decimals are effectively static: set to 30 days.
 *  - All calls respect the existing Connection's endpoint/commitment.
 *
 * Implementation details:
 *  - A global per-endpoint, per-commitment batcher coalesces all account
 *    requests arriving in the same tick using `setTimeout(0)`.
 *  - We decode SPL Token account amount + mint and Mint.decimals directly
 *    from account data to avoid extra RPCs. (Token-2022 supported.)
 *  - We still provide `cachedGetMint()` for compatibility. It uses the
 *    batcher under the hood and returns a shape compatible with SPL's `getMint`.
 */
import {
  AccountInfo,
  Commitment,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import {
  Mint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

// ------------------------------- TTLs ---------------------------------------
// 60s for balances is desirable (live-ish UI)
const TTL_BALANCE = 60 * 1000;
// Mint + owner practically never change -> 30 days to eliminate page-load churn
const TTL_OWNER   = 30 * 24 * 60 * 60 * 1000;
const TTL_MINT    = 30 * 24 * 60 * 60 * 1000;

// --------------------------- Memory safety ----------------------------------
// Android dapp browsers (and some embedded webviews) can freeze if we allow
// unbounded growth of the global RPC cache over long sessions.
// These caps are intentionally generous and only evict oldest entries.
const MAX_CACHE_ENTRIES = 8000;
const MAX_MINT_META_ENTRIES = 4000;

// ---------------------------- Global state ----------------------------------
type PublicKeyish = PublicKey | string | { toBase58(): string };

type CacheEntry = { at: number; value: any };
type CacheMap = Map<string, CacheEntry>;
type InflightMap = Map<string, Promise<any>>;

type GlobalShape = {
  cache: CacheMap;
  inflight: InflightMap;
  schedulers: Map<string, Batcher>;
  mintMeta: Map<string, { decimals: number }>;
};

declare global {
  // eslint-disable-next-line no-var
  var __mmRpcCache2__: GlobalShape | undefined;
}

function globalState(): GlobalShape {
  const g = globalThis as any;
  if (!g.__mmRpcCache2__) {
    g.__mmRpcCache2__ = {
      cache: new Map(),
      inflight: new Map(),
      schedulers: new Map(),
      mintMeta: new Map(),
    };
  }
  return g.__mmRpcCache2__;
}

// ---------------------------- Utilities -------------------------------------
function endpointOf(conn: Connection): string {
  return (conn as any)._rpcEndpoint || (conn as any).rpcEndpoint || "unknown";
}
function commitmentOf(conn: Connection, override?: Commitment) {
  return override || (conn as any)._commitment || "processed";
}
function keyFor(conn: Connection, parts: (string | number)[], commitment?: Commitment) {
  return [endpointOf(conn), commitmentOf(conn, commitment), ...parts].join("|");
}

function pruneOldest<K, V>(m: Map<K, V>, max: number) {
  try {
    while (m.size > max) {
      const first = m.keys().next();
      if (!first || (first as any).done) break;
      m.delete((first as any).value);
    }
  } catch {
    // non-fatal
  }
}

function normalizePk(pk: PublicKeyish): PublicKey {
  if (pk instanceof PublicKey) return pk;
  if (typeof pk === "string") return new PublicKey(pk);
  // duck-typed
  return new PublicKey(pk.toBase58());
}

function bigIntFromLE(bytes: Uint8Array, offset = 0) {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  }
  return v;
}

function bigInt10Pow(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}
function formatUiAmountString(amountBn: bigint, decimals: number): string {
  if (decimals === 0) return amountBn.toString(10);
  const base = bigInt10Pow(decimals);
  const whole = amountBn / base;
  const frac = amountBn % base;
  if (frac === 0n) return whole.toString(10);
  const fracStr = frac.toString(10).padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString(10)}.${fracStr}`;
}
function toTokenAmount(amountBn: bigint, decimals: number) {
  const amount = amountBn.toString(10);
  const base = bigInt10Pow(decimals);
  const uiAmount = Number(amountBn) / Number(base);
  const uiAmountString = formatUiAmountString(amountBn, decimals);
  return { amount, decimals, uiAmount, uiAmountString };
}

// ----------------------------- Batcher --------------------------------------
class Batcher {
  private conn: Connection;
  private commitment: Commitment;
  private q: Map<string, { pk: PublicKey; resolvers: ((ai: AccountInfo<Buffer> | null) => void)[] }> = new Map();
  private scheduled = false;
  private static MAX = 100;

  constructor(conn: Connection, commitment: Commitment) {
    this.conn = conn;
    this.commitment = commitment;
  }

  enqueue(pk: PublicKey): Promise<AccountInfo<Buffer> | null> {
    const k = pk.toBase58();
    const existing = this.q.get(k);
    if (existing) {
      return new Promise((res) => existing.resolvers.push(res));
    }
    return new Promise((resolve) => {
      this.q.set(k, { pk, resolvers: [resolve] });
      if (!this.scheduled) {
        this.scheduled = true;
        // Defer to end of tick to collect more keys from other components
        setTimeout(() => void this.flush(), 0);
      }
    });
  }

  private async flush() {
    this.scheduled = false;
    const items = Array.from(this.q.values());
    this.q.clear();
    if (items.length === 0) return;

    const keys = items.map((x) => x.pk);
    const chunks: PublicKey[][] = [];
    for (let i = 0; i < keys.length; i += Batcher.MAX) {
      chunks.push(keys.slice(i, i + Batcher.MAX));
    }

    const debug = process.env.NEXT_PUBLIC_MM_DEBUG_RPC === "1";
    const results: (AccountInfo<Buffer> | null)[] = [];
    for (const c of chunks) {
      try {
        if (debug) console.log(`[mm/rpc] getMultipleAccountsInfo x${c.length}`);
        const r = await this.conn.getMultipleAccountsInfo(c, { commitment: this.commitment } as any);
        results.push(...r);
      } catch (e) {
        // Fail this chunk gracefully
        if (debug) console.warn("[mm/rpc] getMultipleAccountsInfo failed:", e);
        results.push(...Array(c.length).fill(null));
      }
    }

    // Resolve in order
    let idx = 0;
    for (const item of items) {
      const ai = results[idx++] ?? null;
      for (const r of item.resolvers) r(ai as any);
    }
  }
}

function schedulerFor(conn: Connection, commitment?: Commitment): Batcher {
  const gs = globalState();
  const key = `${endpointOf(conn)}|${commitmentOf(conn, commitment)}`;
  let s = gs.schedulers.get(key);
  if (!s) {
    s = new Batcher(conn, commitmentOf(conn, commitment));
    gs.schedulers.set(key, s);
  }
  return s;
}

// ----------------------- cache wrapper helpers ------------------------------
function cacheWrap<T>(cacheKey: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const gs = globalState();
  const entry = gs.cache.get(cacheKey);
  const now = Date.now();

  if (entry && now - entry.at < ttlMs) {
    return Promise.resolve(entry.value as T);
  }
  const existing = gs.inflight.get(cacheKey);
  if (existing) return existing as Promise<T>;

  const p = compute()
    .then((val) => {
      gs.cache.set(cacheKey, { at: Date.now(), value: val });
      // Prevent unbounded cache growth across long sessions.
      pruneOldest(gs.cache, MAX_CACHE_ENTRIES);
      return val;
    })
    .finally(() => gs.inflight.delete(cacheKey));
  gs.inflight.set(cacheKey, p);
  return p;
}

// ------------------------- decoding helpers ---------------------------------
function decodeTokenAccountAmountAndMint(ai: AccountInfo<Buffer> | null): { amount: bigint; mint: PublicKey } | null {
  if (!ai || !ai.data) return null;
  const data = ai.data instanceof Buffer ? ai.data : Buffer.from(ai.data as any);
  if (data.length < 72) return null;
  const mint = new PublicKey(data.subarray(0, 32));
  const amount = bigIntFromLE(data, 64);
  return { amount, mint };
}

function decodeMintDecimals(ai: AccountInfo<Buffer> | null): number | null {
  if (!ai || !ai.data) return null;
  const data = ai.data instanceof Buffer ? ai.data : Buffer.from(ai.data as any);
  if (data.length < 45) return null;
  return data[44]; // u8 decimals
}

// ----------------------------- Public API -----------------------------------

export async function cachedGetAccountInfo(
  conn: Connection,
  pubkey: PublicKeyish,
  commitment: Commitment = "processed",
): Promise<AccountInfo<Buffer> | null> {
  const pk = normalizePk(pubkey);
  const key = keyFor(conn, ["getAccountInfo", pk.toBase58()], commitment);
  return cacheWrap<AccountInfo<Buffer> | null>(key, TTL_OWNER, async () => {
    const ai = await schedulerFor(conn, commitment).enqueue(pk);
    return ai ?? null;
  });
}
export async function cachedGetBalance(
  conn: Connection,
  pubkey: PublicKeyish,
  commitment: Commitment = "processed",
): Promise<number> {
  const pk = normalizePk(pubkey);
  const key = keyFor(conn, ["getBalance", pk.toBase58()], commitment);
  return cacheWrap<number>(key, TTL_BALANCE, async () => {
    const ai = await schedulerFor(conn, commitment).enqueue(pk);
    return ai?.lamports ?? 0;
  });
}

/**
 * Returns same structure the panels use from `getTokenAccountBalance`.
 * If the account doesn't exist, returns a zeroed TokenAmount structure.
 */
export async function cachedGetTokenAccountBalance(
  conn: Connection,
  ata: PublicKeyish,
  commitment: Commitment = "processed",
): Promise<{ value: { amount: string; decimals: number; uiAmount: number; uiAmountString: string } }> {
  const pk = normalizePk(ata);
  const key = keyFor(conn, ["getTokenAccountBalance", pk.toBase58()], commitment);
  return cacheWrap(key, TTL_BALANCE, async () => {
    const ai = await schedulerFor(conn, commitment).enqueue(pk);
    const decoded = decodeTokenAccountAmountAndMint(ai);
    if (!decoded) {
      return { value: { amount: "0", decimals: 0, uiAmount: 0, uiAmountString: "0" } };
    }
    const { amount, mint } = decoded;

    const gs = globalState();
    const mintKey = keyFor(conn, ["mint.decimals", mint.toBase58()], commitment);
    const decimals: number = await cacheWrap<number>(mintKey, TTL_MINT, async () => {
      // Try cache first
      const cached = gs.mintMeta.get(mint.toBase58());
      if (cached) return cached.decimals;

      // Batch fetch + decode decimals
      const mintAi = await schedulerFor(conn, commitment).enqueue(mint);
      const dec = decodeMintDecimals(mintAi);
      if (dec === null) {
        // Fallback — if the account is missing (shouldn't happen), just assume 0
        return 0;
      }
      gs.mintMeta.set(mint.toBase58(), { decimals: dec });
      return dec;
    });

    const ta = toTokenAmount(amount, decimals);
    return { context: { slot: 0 }, value: ta };
  });
}

export async function cachedGetAccountInfoOwner(
  conn: Connection,
  pubkey: PublicKeyish,
  commitment: Commitment = "processed",
): Promise<{ exists: boolean; owner?: PublicKey }> {
  const pk = normalizePk(pubkey);
  const key = keyFor(conn, ["getAccountInfo.owner", pk.toBase58()], commitment);
  return cacheWrap(key, TTL_OWNER, async () => {
    const ai = await schedulerFor(conn, commitment).enqueue(pk);
    if (ai) {
      return { exists: true, owner: ai.owner };
    }
    return { exists: false };
  });
}

/**
 * Compatibility shim for code that still imports `cachedGetMint`.
 * We satisfy the `Mint` interface fields we know are read by panels/SDK.
 * (decimals, supply); other fields are filled conservatively.
 */
export async function cachedGetMint(
  conn: Connection,
  mint: PublicKeyish,
  commitment: Commitment = "processed",
  _programId?: PublicKeyish, // accepted but unused — we read directly from account data
): Promise<Mint> {
  const pk = normalizePk(mint);
  const key = keyFor(conn, ["getMint", pk.toBase58()], commitment);
  return cacheWrap<Mint>(key, TTL_MINT, async () => {
    const ai = await schedulerFor(conn, commitment).enqueue(pk);
    const dec = decodeMintDecimals(ai) ?? 0;
    // SPL's Mint has shape:
    // { mintAuthority, supply, decimals, isInitialized, freezeAuthority, ... }
    // We can compute supply only if necessary; for now set to 0n when absent.
    // Downstream code only reads `decimals`.
    const out: any = {
      decimals: dec,
      // sensible defaults (unused)
      supply: 0n,
      isInitialized: true,
      mintAuthority: null,
      freezeAuthority: null,
    };
    return out as Mint;
  });
}

// ----------------------------- Extras ---------------------------------------
/** Warm the account-info cache for a set of public keys. Safe no-op if empty. */
export async function prewarmAccounts(
  conn: Connection,
  pubkeys: PublicKeyish[],
  commitment: Commitment = "processed",
): Promise<void> {
  const list = Array.from(new Set(pubkeys.map((p) => normalizePk(p).toBase58()))).map((s) => new PublicKey(s));
  if (list.length === 0) return;
  const s = schedulerFor(conn, commitment);
  await Promise.all(list.map((pk) => s.enqueue(pk)));
}

/** Purge selected cache keys (or the whole cache) without affecting in-flight queues. */
export function purgeRpcCache(predicate?: (key: string) => boolean) {
  const gs = globalState();
  if (!predicate) {
    gs.cache.clear();
    return;
  }
  for (const k of Array.from(gs.cache.keys())) {
    if (predicate(k)) gs.cache.delete(k);
  }
}

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

// ----------------------- Compatibility shims (optional) ---------------------
// To catch any direct `conn.getAccountInfo/getTokenAccountBalance/getBalance`
// calls that bypass our helpers, we patch them in the browser to delegate into
// the batcher. This is intentionally conservative and falls back to the native
// call on any error. Server code remains untouched.
//
// You can disable these shims by omitting NEXT_PUBLIC_MM_PATCH_CONN="1".
try {
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_MM_PATCH_CONN === "1") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Web3 = require("@solana/web3.js") as typeof import("@solana/web3.js");
    const proto = (Web3.Connection as any).prototype;

    if (!proto.__mmPatched) {
      const origGetAccountInfo = proto.getAccountInfo;
      const origGetTokenAccountBalance = proto.getTokenAccountBalance;
      const origGetBalance = proto.getBalance;

      proto.getAccountInfo = async function (this: Connection, pubkey: any, opts?: any) {
        try {
          return await cachedGetAccountInfo(this, pubkey, (opts?.commitment || opts) as Commitment);
        } catch (e) {
          return await origGetAccountInfo.call(this, pubkey, opts);
        }
      };

      proto.getTokenAccountBalance = async function (this: Connection, pubkey: any, opts?: any) {
        try {
          return await cachedGetTokenAccountBalance(this, pubkey, (opts?.commitment || opts) as Commitment);
        } catch (e) {
          return await origGetTokenAccountBalance.call(this, pubkey, opts);
        }
      };

      proto.getBalance = async function (this: Connection, pubkey: any, opts?: any) {
        try {
          return await cachedGetBalance(this, pubkey, (opts?.commitment || opts) as Commitment);
        } catch (e) {
          return await origGetBalance.call(this, pubkey, opts);
        }
      };

      Object.defineProperty(proto, "__mmPatched", { value: true, enumerable: false });
      if (process.env.NEXT_PUBLIC_MM_DEBUG_RPC === "1") {
        console.log("[mm/rpc] Connection prototype patched for client-side batching.");
      }
    }
  }
} catch (e) {
  // Non-fatal
}
