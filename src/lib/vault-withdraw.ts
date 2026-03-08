// filepath: src/lib/vault-withdraw.ts
"use client";

import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

function base64ToBytes(b64: string): Uint8Array {
  try {
    if (typeof window !== "undefined" && typeof window.atob === "function") {
      const bin = window.atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch {}
  // Fallback (SSR / Node)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const buff = (typeof Buffer !== "undefined") ? Buffer.from(b64, "base64") : new Uint8Array();
  return buff as unknown as Uint8Array;
}


// Added: tiny fetch timeout to avoid UI hangs on slow edge cases.
async function fetchWithTimeout(input: RequestInfo, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 15000, ...rest } = init;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}



// Soft-confirm with a strict time budget so mobile UIs never "hang" waiting for RPC.
// Returns true only if confirmation completes within the budget; otherwise false.
// Never throws.
async function _mmSoftConfirm(
  conn: Connection,
  sig: string,
  timeoutMs: number = 8000
): Promise<boolean> {
  try {
    const t = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(0, timeoutMs)));
    const c = (async () => {
      try {
        const { blockhash: bh, lastValidBlockHeight: lvbh } = await conn.getLatestBlockhash("confirmed");
        await conn.confirmTransaction({ signature: sig, blockhash: bh, lastValidBlockHeight: lvbh }, "confirmed");
        return true;
      } catch {
        return false;
      }
    })();
    return await Promise.race([t, c]);
  } catch {
    return false;
  }
}

function activeRpcString(): string {
  if (typeof window !== "undefined") {
    const origin = window.location.origin || "";
    return origin ? `${origin}/api/rpc` : "/api/rpc";
  }
  return (
    process.env.HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  )!.trim();
}

type WalletSendTransaction = (
  tx: Transaction,
  connection: Connection,
  options?: unknown
) => Promise<string>;

/**
 * Server-built withdraw flow:
 *  1) POST /api/vaults/withdraw to build tx (server sets recentBlockhash, fee payer, signers)
 *  2) Client signs/sends
 *  3) Soft-confirm: we try to confirm, but NEVER throw on timeout; we return the signature regardless
 *     so the UI can continue (and Activity logging can run).
 */
export async function withdrawFromVaultServerFirst(
  wallet:
    | {
        publicKey: PublicKey;
        sendTransaction: WalletSendTransaction;
        signTransaction?: (tx: Transaction) => Promise<Transaction>;
      }
    | {
        publicKey: PublicKey;
        signTransaction: (tx: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;
        sendTransaction?: WalletSendTransaction;
      },
  setId: string,
  mint: string,
  amountUi: number | string,
  decimals?: number,
  vault?: string
) {
  if (!wallet?.publicKey) throw new Error("Wallet not connected");

  const conn = new Connection(activeRpcString(), { commitment: "confirmed" });

  // If the vault account was never initialized (rare RPC hiccup during create),
  // the withdraw builder can return a special 409 payload with an init tx to sign.
  // This is a no-op for healthy vaults and preserves UI/UX.
  async function maybeInitVaultFromServerPayload(payload: any): Promise<string | null> {
    try {
      const init64 = payload?.initTx64;
      if (!init64 || typeof init64 !== "string") return null;

      const bytes = base64ToBytes(init64);

      // Try legacy Transaction first (most common for init_vault in this repo).
      let legacyTx: Transaction | null = null;
      let v0Tx: VersionedTransaction | null = null;

      try {
        legacyTx = Transaction.from(bytes);
      } catch {
        legacyTx = null;
      }

      if (!legacyTx) {
        try {
          v0Tx = VersionedTransaction.deserialize(bytes);
        } catch {
          v0Tx = null;
        }
      }

      if (legacyTx) {
        const sig =
          "sendTransaction" in wallet && typeof (wallet as any).sendTransaction === "function"
            ? await (wallet as any).sendTransaction(legacyTx, conn, { maxRetries: 3 })
            : await (async () => {
                const signed = await (wallet as any).signTransaction(legacyTx);
                return await conn.sendRawTransaction((signed as Transaction).serialize(), { preflightCommitment: "confirmed" });
              })();
        // soft confirm
        void conn.confirmTransaction(sig as any, "confirmed").catch(() => {});
        return String(sig);
      }

      if (v0Tx) {
        const sig =
          "sendTransaction" in wallet && typeof (wallet as any).sendTransaction === "function"
            ? await (wallet as any).sendTransaction(v0Tx as any, conn, { maxRetries: 3 } as any)
            : await (async () => {
                const signed = await (wallet as any).signTransaction(v0Tx);
                return await conn.sendRawTransaction((signed as VersionedTransaction).serialize(), { preflightCommitment: "confirmed" });
              })();
        void conn.confirmTransaction(sig as any, "confirmed").catch(() => {});
        return String(sig);
      }

      return null;
    } catch {
      return null;
    }
  }

  // 1) Ask server to build the withdraw tx
  const buildBody = {
    setId,
    mint,
    amountUi: String(amountUi),
    decimals: typeof decimals === "number" ? decimals : undefined,
    admin: wallet.publicKey.toBase58(),
    ...(vault ? { vault } : {}),
  };

  let resp = await fetch("/api/vaults/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildBody),
  });

  let j = await resp.json().catch(() => ({} as any));

  // Rare: vault PDA exists (can hold funds) but the vault state account was never initialized due to RPC hiccup during create.
  // In that case, the server may return 409 with an initTx64 to sign. We sign it once and retry the withdraw builder once.
  if (resp.status === 409 && j?.error === "vault_not_initialized" && j?.initTx64) {
    await maybeInitVaultFromServerPayload(j);
    resp = await fetch("/api/vaults/withdraw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody),
    });
    j = await resp.json().catch(() => ({} as any));
  }

  if (!resp.ok || j?.ok === false || !j?.tx64) {
    // Defensive: if backend returns AccountNotInitialized without 409 wrapper, attempt init via /api/vaults/create once.
    const msg = String(j?.error || `withdraw builder failed (status ${resp.status})`);
    if ((/AccountNotInitialized|3012/i).test(msg)) {
      try {
        const cr = await fetch("/api/vaults/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ admin: wallet.publicKey.toBase58(), setId, mints: [mint] }),
        });
        const cj: any = await cr.json().catch(() => ({}));
        if (cr.ok && cj?.tx64) {
          await maybeInitVaultFromServerPayload({ initTx64: cj.tx64 });
          resp = await fetch("/api/vaults/withdraw", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildBody),
          });
          j = await resp.json().catch(() => ({} as any));
        }
      } catch {}
    }
    if (!resp.ok || j?.ok === false || !j?.tx64) throw new Error(msg);
  }

  const txBytes = base64ToBytes(String(j.tx64));
  const tx = VersionedTransaction.deserialize(txBytes);

  // 2) Sign + send (support both sendTransaction and signTransaction paths)
  const sig =
    "sendTransaction" in wallet && typeof (wallet as any).sendTransaction === "function"
      ? await (wallet as any).sendTransaction(tx, conn, { maxRetries: 3 })
      : await (async () => {
          const signed = await (wallet as any).signTransaction(tx);
          return await conn.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
        })();

  // 3) Best-effort confirmation: try to confirm briefly but never block the UI.
//    Returns `confirmed: true` only when verified on-chain within a small time budget.
let confirmed = await _mmSoftConfirm(conn, sig as string, 8000);

  return {
    sig,
    confirmed,
    vault: j?.meta?.vault || null,
    userToken: j?.meta?.userAta || null,
    vaultToken: j?.meta?.vaultToken || null,
  };
}
