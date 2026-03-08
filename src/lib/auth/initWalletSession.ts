// filepath: src/lib/auth/initWalletSession.ts
// Client-side helper to establish an httpOnly wallet session cookie used to gate private webhook data.
// Behaviour:
//   - Can be called as:
//       initWalletSession(wallet, signMessage)
//       initWalletSession({ wallet, signMessage })
//       initWalletSession({ wallet, signMessage, signTransaction }) // NEW: Ledger-safe fallback
//   - Talks to /api/auth/nonce to either:
//       • confirm an existing mm_wallet_session cookie for this wallet (no signing), or
//       • obtain a nonce + message to sign once.
//   - Primary path uses signMessage (most wallets).
//   - Fallback path uses signTransaction to sign a *local* legacy tx that contains the same message
//     inside a Memo instruction (works on Ledger and other wallets that don't support signMessage).
//   - On success, dispatches a 'mm-wallet-session-ready' browser event so pages can refetch
//     webhook data knowing the server sees the user as the owner.
//
// Security notes:
//   - Both paths bind the server session to a one-time nonce (5‑min TTL in Redis).
//   - The transaction fallback NEVER broadcasts — it only signs a legacy Transaction containing
//     a Memo with the nonce-bound message. Server verifies both the signature and the memo contents.
//   - The actual session is 100% server-side (Upstash + httpOnly cookie). This helper never stores secrets.

type SignMessageFn = ((message: Uint8Array) => Promise<Uint8Array>) | null | undefined;
type SignTransactionFn = ((tx: any) => Promise<any>) | null | undefined;

function safeWallet(addr: string | null | undefined): string {
  return String(addr || '').trim();
}

const SESSION_HINT_KEY = 'mm_wallet_session_hint';
const FORCE_TX_PREFIX = 'mm_wallet_session_force_tx:';

function getForceTxPreference(addr: string | null | undefined): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const w: any = window as any;
    if (!w.localStorage) return false;
    const key = safeWallet(addr);
    if (!key) return false;
    return String(w.localStorage.getItem(FORCE_TX_PREFIX + key) || '') === '1';
  } catch {
    return false;
  }
}

function setForceTxPreference(addr: string | null | undefined, v: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    const w: any = window as any;
    if (!w.localStorage) return;
    const key = safeWallet(addr);
    if (!key) return;
    if (v) w.localStorage.setItem(FORCE_TX_PREFIX + key, '1');
    else w.localStorage.removeItem(FORCE_TX_PREFIX + key);
  } catch {
    // ignore
  }
}


function setSessionHint(addr: string | null | undefined): void {
  try {
    if (typeof window === 'undefined') return;
    const w: any = window as any;
    if (!w.localStorage) return;
    const key = safeWallet(addr);
    if (!key) {
      w.localStorage.removeItem(SESSION_HINT_KEY);
      return;
    }
    w.localStorage.setItem(SESSION_HINT_KEY, key);
  } catch {
    // ignore storage errors
  }
}

export function dispatchSessionReady(walletAddr: string) {
  if (typeof window === 'undefined') return;
  const w: any = window as any;
  const key = safeWallet(walletAddr);
  if (!key) return;
  if (!w.__mmWalletSessionReady) w.__mmWalletSessionReady = {};
  w.__mmWalletSessionReady[key] = true;
  try {
    const ev = new CustomEvent('mm-wallet-session-ready', { detail: { wallet: key } });
    window.dispatchEvent(ev);
  } catch {}
}

async function postJson(path: string, body: any): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
}

/**
 * Overloads so legacy call sites still work:
 *
 *   initWalletSession(wallet, signMessage)
 *   initWalletSession({ wallet, signMessage })
 *   initWalletSession({ wallet, signMessage, signTransaction }) // new – ledger-safe
 */
export async function initWalletSession(wallet: string, signMessage: SignMessageFn): Promise<void>;
export async function initWalletSession(opts: { wallet: string; signMessage?: SignMessageFn; signTransaction?: SignTransactionFn; preferTx?: boolean }): Promise<void>;
export async function initWalletSession(a: any, b?: any): Promise<void> {
  if (typeof window === 'undefined') return; // SSR guard

  // Normalize call signature
  let walletAddr: string;
  let signMessage: SignMessageFn | undefined;
  let signTransaction: SignTransactionFn | undefined;
  let preferTx = false;

  // Legacy signature: initWalletSession(wallet, signMessage)
  if (typeof a === 'string') {
    walletAddr = safeWallet(a);
    preferTx = getForceTxPreference(walletAddr);
    signMessage = b;
  } else {
    // New signature: initWalletSession({ wallet, signMessage, signTransaction })
    walletAddr = safeWallet(a?.wallet);
    signMessage = a?.signMessage;
    signTransaction = a?.signTransaction;
    preferTx = Boolean(a?.preferTx) || getForceTxPreference(walletAddr);
  }

  if (!walletAddr) return;

  // Shared helper for both signing paths.
  // Must work in browsers (Android/iOS/desktop) and not depend on Node Buffer.
  const toBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Prefer btoa in the browser; fall back to Buffer when available (e.g. during tests).
    if (typeof btoa === 'function') {
      let bin = '';
      for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return btoa(bin);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B: any = (globalThis as any).Buffer;
    if (B && typeof B.from === 'function') return B.from(u8).toString('base64');
    throw new Error('Base64 encoder unavailable');
  };

  try {
    // Ask server whether a session already exists or we need a fresh nonce.
    const r1 = await postJson('/api/auth/nonce', { wallet: walletAddr });
    const j1: any = await r1.json().catch(() => ({}));

    // No need to sign again if the cookie is already valid for this wallet.
    if (r1.ok && j1?.ok && j1?.already) {
      setSessionHint(walletAddr);
      dispatchSessionReady(walletAddr);
      return;
    }

    const nonce = typeof j1?.nonce === 'string' ? j1.nonce : '';
    const message = typeof j1?.message === 'string' ? j1.message : '';
    const ts = Number(j1?.ts ?? 0);

    // Sanity
    if (!r1.ok || !nonce || !message || !Number.isFinite(ts) || ts <= 0) return;

    // 1) Primary path: sign the message bytes
    let sessionOk = false;
    if (!preferTx && typeof signMessage === 'function') {
      try {
        const encoder = new TextEncoder();
        const msgBytes = encoder.encode(message);
        const rawSig = await signMessage(msgBytes);
        const bs58 = (await import('bs58')).default;

        const normalizeSigB58 = (raw: any): string => {
          const isBase58 = (s: string) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
          if (typeof raw === 'string') {
            const s = raw.trim();
            if (isBase58(s) && s.length >= 40) return s;
          }
          const wrapped = raw?.signature ?? raw?.sig ?? raw?.data;
          if (wrapped != null && wrapped !== raw) return normalizeSigB58(wrapped);
          if (raw instanceof Uint8Array) return bs58.encode(raw);
          if (raw instanceof ArrayBuffer) return bs58.encode(new Uint8Array(raw));
          if (Array.isArray(raw)) return bs58.encode(Uint8Array.from(raw));
          if (raw && typeof raw === 'object' && typeof (raw as any).length === 'number') {
            try { return bs58.encode(Uint8Array.from(Array.from(raw as any))); } catch {}
          }
          throw new Error('Unsupported signature format from wallet adapter');
        };

        const signatureBase58 = normalizeSigB58(rawSig);
const r2 = await postJson('/api/auth/session', { wallet: walletAddr, nonce, ts, signatureBase58 });
        const j2: any = await r2.json().catch(() => ({}));
        if (r2.ok && j2?.ok) {
          sessionOk = true;
          setForceTxPreference(walletAddr, false);
          setSessionHint(walletAddr);
          dispatchSessionReady(walletAddr);
          return;
        }
      } catch {
        if (typeof signTransaction === 'function') setForceTxPreference(walletAddr, true);
        // swallow and try fallback
      }
    }

    // 2) Fallback path: sign a *local* legacy transaction with the message in a Memo instruction
    //    Works on Ledger and on wallets that don't implement signMessage.
    if (!sessionOk && typeof signTransaction === 'function') {
      try {
        const { PublicKey, Transaction, TransactionInstruction } = await import('@solana/web3.js');
        const { ensureConnection } = await import('../rpc'); // client-safe singleton
        const conn = ensureConnection();

        const feePayer = new PublicKey(walletAddr);
        const { blockhash } = await conn.getLatestBlockhash('finalized').catch(async () => {
          const { blockhash: bh2 } = await conn.getLatestBlockhash('confirmed');
          return { blockhash: bh2 };
        });

        const memoProgramId = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
        const memoIx = new TransactionInstruction({
          programId: memoProgramId,
          keys: [],
          data: new TextEncoder().encode(message) as any,
        });

        const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(memoIx);
        const signedTx = await signTransaction(tx as any);
        // Serialize without requiring all signatures (we only need the fee payer)
        const serialized = (signedTx as any).serialize({ requireAllSignatures: false, verifySignatures: false });
        const txBase64 = toBase64(serialized);
const r3 = await postJson('/api/auth/session/tx', { wallet: walletAddr, nonce, ts, txBase64 });
        const j3: any = await r3.json().catch(() => ({}));
        if (r3.ok && j3?.ok) {
          sessionOk = true;
          setForceTxPreference(walletAddr, true);
          setSessionHint(walletAddr);
          dispatchSessionReady(walletAddr);
          return;
        }
      } catch {
        // fall through
      }
    }

    // If neither path succeeded, do nothing; UI will continue to show sanitized data.
  } catch {
    // ignore
  }
}
