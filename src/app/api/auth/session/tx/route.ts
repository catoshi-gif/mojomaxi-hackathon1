// filepath: src/app/api/auth/session/tx/route.ts
// Purpose: Exchange a *signed transaction* containing a nonce-bound Memo for an httpOnly session cookie.
// This is a Ledger-friendly fallback for wallets that don't implement `signMessage`.
// The tx is never broadcast — we only verify:
//   • fee payer == `wallet`
//   • tx carries a Memo instruction whose UTF-8 data equals buildSignMessage(wallet, nonce, ts)
//   • the transaction's first signature verifies against the compiled message with `wallet`'s pubkey
//
// Security: the same nonce (5‑min TTL) is consumed exactly once, preventing replay.

import 'server-only';
import { NextResponse } from 'next/server';
import { PublicKey, Transaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  buildSignMessage,
  consumeNonce,
  setWalletSessionCookie,
  SESSION_TTL_SEC,
} from '@/lib/auth/session.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isValidBase58Wallet(s: string): boolean {
  try {
    const k = new PublicKey(s);
    return !!k;
  } catch {
    return false;
  }
}

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';


function noStoreHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, private, must-revalidate',
    Pragma: 'no-cache',
    Vary: 'Cookie',
  };
}


export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const wallet = String(body?.wallet || '').trim();
    const nonce = String(body?.nonce || '').trim();
    const ts = Number(body?.ts || 0);
    const txBase64 = String(body?.txBase64 || '');
    if (!wallet || !isValidBase58Wallet(wallet) || !nonce || !Number.isFinite(ts) || ts <= 0 || !txBase64) {
      return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400, headers: noStoreHeaders() });
    }

    // Verify/consume nonce (5‑min TTL) — returns the stored value or null.
    const okNonce = await consumeNonce(wallet, nonce);
    if (!okNonce) {
      return NextResponse.json({ ok: false, error: 'invalid_nonce' }, { status: 401, headers: noStoreHeaders() });
    }

    // Decode the legacy transaction
    let tx: Transaction;
    try {
      const buf = Buffer.from(txBase64, 'base64');
      tx = Transaction.from(buf);
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid_tx' }, { status: 400, headers: noStoreHeaders() });
    }

    // Fee payer must match wallet
    const feePayer = tx.feePayer?.toBase58() || '';
    if (feePayer !== wallet) {
      return NextResponse.json({ ok: false, error: 'wrong_fee_payer' }, { status: 401, headers: noStoreHeaders() });
    }

    // Must include a Memo instruction with the exact expected message
    const expected = buildSignMessage(wallet, nonce, ts);
    const hasExpectedMemo = tx.instructions.some((ix) => {
      try {
        const pid = ix.programId?.toBase58?.() || '';
        if (pid !== MEMO_PROGRAM_ID) return false;
        const data = Buffer.isBuffer(ix.data) ? ix.data : Buffer.from(ix.data as any);
        const s = data.toString('utf8');
        return s === expected;
      } catch {
        return false;
      }
    });
    if (!hasExpectedMemo) {
      return NextResponse.json({ ok: false, error: 'memo_mismatch' }, { status: 401, headers: noStoreHeaders() });
    }

    // Verify the signature against the compiled legacy message
    const walletPk = new PublicKey(wallet);
    const sigEntry = (tx.signatures || []).find((s) => {
      try {
        return !!s?.publicKey && s.publicKey.equals(walletPk) && !!s.signature;
      } catch {
        return false;
      }
    });
    if (!sigEntry?.signature) {
      return NextResponse.json({ ok: false, error: 'missing_signature' }, { status: 401, headers: noStoreHeaders() });
    }
    const msgBytes = tx.serializeMessage(); // legacy message bytes
    const sig = Uint8Array.from(sigEntry.signature as Buffer);
    const pubkey = walletPk.toBytes();
    const ok = nacl.sign.detached.verify(msgBytes, sig, pubkey);
    if (!ok) {
      return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401, headers: noStoreHeaders() });
    }

// All good — set cookie
    const res = NextResponse.json({ ok: true, ttlSec: SESSION_TTL_SEC }, { status: 200, headers: noStoreHeaders() });
    const host = req.headers.get('host') || '';
    await setWalletSessionCookie(res, wallet, { ttlSec: SESSION_TTL_SEC, reqHost: host });
    return res;
  } catch {
    return NextResponse.json({ ok: false, error: 'unexpected' }, { status: 500, headers: noStoreHeaders() });
  }
}
