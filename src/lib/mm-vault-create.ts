import { PublicKey, Transaction } from "@solana/web3.js";
import { ensureConnection } from "@/lib/vault-sdk";

function base64ToBytes(b64: string): Uint8Array {
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch {}
  // node-ish fallback
  const buf = typeof Buffer !== "undefined" ? Buffer.from(b64, "base64") : new Uint8Array([]);
  return new Uint8Array(buf);
}
/**
 * Vault creation client helper.
 *
 * Surgical fixes (no UI/UX changes):
 * - Remove invalid '# filepath' header that broke TS parsing on Vercel.
 * - Remove stray duplicate 'else' that caused a syntax error.
 * - Broaden wallet compatibility without altering behavior:
 *   • Prefer adapter.sendTransaction when available.
 *   • Fall back to adapter.signTransaction + sendRawTransaction.
 *   • Final fallback to window.solana.signAndSendTransaction/signTransaction for Wallet Standard providers.
 */

type Adapter = {
  publicKey?: { toBase58(): string } | null;
  sendTransaction?: (tx: Transaction, conn: any, opts?: any) => Promise<string>;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
};

type CreateResponse = {
  ok?: boolean;
  already?: boolean;
  tx64?: string;
  txs64?: string[];
  meta?: {
    admin?: string;
    setId?: string;
    programId?: string;
    vault?: string;
    authority?: string;
    feeBps?: number;
    ata?: { created?: string[]; existed?: string[]; mints?: string[] };
    already?: boolean;
  };
};

function getAdminPkString(adapter: Adapter): string | null {
  if (!adapter || !adapter.publicKey) return null;
  try { return adapter.publicKey.toBase58(); } catch { return null; }
}

async function tryAdapterSendOrSign(
  tx: Transaction,
  adapter: Adapter,
  conn: any
): Promise<string | null> {
  const sendFn = adapter?.sendTransaction;
  const signFn = adapter?.signTransaction;

  if (typeof sendFn === "function") {
    try {
      return await sendFn(tx, conn, { skipPreflight: false });
    } catch (e: any) {
      const msg = (e && (e.message || String(e))) || "";
      if (typeof signFn === "function" && typeof msg === "string" && msg.toUpperCase().includes("NOT IMPLEMENTED")) {
        const signed = await signFn(tx);
        return await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      }
      throw e;
    }
  }

  if (typeof signFn === "function") {
    try {
      const signed = await signFn(tx);
      const raw = signed.serialize();
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
      return sig || null;
    } catch {
      return null;
    }
  }

  return null;
}

function getWindowAdapter(): { signAndSendTransaction?: (tx: Transaction) => Promise<{ signature?: string; txid?: string } | string>; signTransaction?: (tx: Transaction) => Promise<Transaction> } | null {
  if (typeof window === "undefined") return null;
  const w: any = window as any;
  const prov =
    w?.solana ||
    w?.phantom?.solana ||
    w?.solflare ||
    w?.okxwallet?.solana ||
    null;
  return prov;
}

async function tryWindowSignAndSend(tx: Transaction): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const w: any = window as any;
  const prov = w?.solana || w?.phantom?.solana || w?.solflare || w?.okxwallet?.solana;
  if (!prov) return null;

  if (typeof prov.signAndSendTransaction === "function") {
    try {
      const res = await prov.signAndSendTransaction(tx);
      const sig = res?.signature || res?.txid || res || null;
      return sig ? String(sig) : null;
    } catch {
      return null;
    }
  }

  if (typeof prov.signTransaction === "function") {
    try {
      const signed = await prov.signTransaction(tx);
      const raw = signed.serialize();
      const conn = ensureConnection();
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
      return sig || null;
    } catch {
      return null;
    }
  }

  return null;
}

async function mmCreateVault(
  walletAdapter: Adapter,
  setId: string,
  mints?: string[]
): Promise<
  | { sig: string; vault: string; authority: string }
  | { sig: "already-initialized"; vault: string; authority: string }
  | null
> {
  try {
    const adminPkStr = getAdminPkString(walletAdapter);
    const adminPk = adminPkStr ? new PublicKey(adminPkStr) : undefined;
    const sendTx = walletAdapter?.sendTransaction?.bind(walletAdapter) as
      | ((tx: Transaction, conn: any, opts?: any) => Promise<string>)
      | undefined;
    const signTx = walletAdapter?.signTransaction?.bind(walletAdapter) as
      | ((tx: Transaction) => Promise<Transaction>)
      | undefined;

    if (!adminPk) throw new Error("Selected wallet adapter not ready (no publicKey).");
    if (!setId) throw new Error("Missing setId for vault creation.");

    const body: any = { admin: adminPkStr as string, setId };
    if (mints && mints.length) body.mints = mints;

    // Collect the exact TokenPicker logos for the provided mints so the server
    // can persist them into the global mint→logo registry at vault creation time.
    try {
      if (typeof window !== "undefined" && mints && mints.length) {
        const g: any = (window as any);
        const mmPick = (g && g.mmPickerLogos) || {};
        const mmTok  = (g && g.mmTokenLogos) || {};
        let ls: any = {};
        try { ls = JSON.parse(localStorage.getItem("mmPickerLogos") || "{}"); } catch {}
        const logos: Record<string, string> = {};
        for (const raw of mints) {
          const mint = String(raw || "").trim();
          if (!mint) continue;
          const u =
            (mmPick && mmPick[mint]) ||
            (mmTok && mmTok[mint]) ||
            (ls && ls[mint]) ||
            "";
          if (u && /^https?:\/\//i.test(String(u))) {
            logos[mint] = String(u);
          }
        }
        if (Object.keys(logos).length) {
          body.logos = logos;
        }
      }
    } catch {
      // best-effort only; do not block vault creation
    }

    const r = await fetch("/api/vaults/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const j = (await r.json().catch(() => ({}))) as CreateResponse;

    const vault = String((j?.meta as any)?.vault || "");
    const authority = String((j?.meta as any)?.authority || "");
    const already = Boolean((j as any)?.already) || Boolean((j?.meta as any)?.already);

    if (already) {
      if (!vault || !authority) {
        throw new Error("Vault creation response missing vault/authority meta.");
      }
      return { sig: "already-initialized", vault, authority };
    }

    if (!j?.ok) {
      throw new Error("Vault creation API returned ok:false");
    }

    const conn = ensureConnection();
    const txs64: string[] = Array.isArray((j as any)?.txs64) && (j as any).txs64.length
      ? (j as any).txs64.map((x: any) => String(x || "")).filter(Boolean)
      : [String((j as any)?.tx64 || "").trim()].filter(Boolean);

    if (!txs64.length) { throw new Error("Vault creation API missing tx64"); }

    let sig: string | null = null;
    // Send one or more transactions (chunked ATA prewarm).
    // We keep a single user gesture: the wallet will prompt as needed per tx.
    for (const raw of txs64) {
      const tx = Transaction.from(base64ToBytes(String(raw || "")));
      // feePayer/recentBlockhash are already set server-side
      let thisSig: string | null = null;

      if (sendTx || signTx) {
        thisSig = await tryAdapterSendOrSign(tx, { sendTransaction: sendTx as any, signTransaction: signTx as any }, conn);
      }

      if (!thisSig) {
        thisSig = await tryWindowSignAndSend(tx);
      }

      if (!thisSig) {
        throw new Error("Vault creation transaction could not be sent.");
      }

      sig = thisSig; // keep last signature
    }


    if (!vault || !authority) {
      throw new Error("Vault creation response missing vault/authority meta.");
    }

    if (already) {
      return { sig: "already-initialized", vault, authority };
    }

    return { sig, vault, authority };
  } catch (e) {
    console.error("[mm-vault-create] error", e);
    return null;
  }
}

/** Public entry that preserves legacy signature. */
export function createVaultForSet(
  walletAdapter: Adapter,
  setId: string,
  _mintIn?: string,
  _mintOut?: string,
  mintsOverride?: string[]
): Promise<
  | { sig: string; vault: string; authority: string }
  | { sig: "already-initialized"; vault: string; authority: string }
  | null
> {
  const raw = Array.isArray(mintsOverride) && mintsOverride.length
    ? mintsOverride
    : [_mintIn, _mintOut];
  const mints = Array.from(new Set((raw || []).map((s) => String(s || "").trim()).filter(Boolean)));
  return mmCreateVault(walletAdapter, setId, mints);
}
