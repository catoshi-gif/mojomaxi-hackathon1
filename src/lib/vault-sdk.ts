// filepath: src/lib/vault-sdk.ts
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { cachedGetBalance, cachedGetTokenAccountBalance, cachedGetAccountInfoOwner, cachedGetMint } from "@/lib/rpc-cache";
import { ensureConnection as _sharedEnsureConnection } from "@/lib/rpc";
import {
  getAssociatedTokenAddressSync,
  getMint,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";


// Coerce rpc getTokenAccountBalance() return (TokenAmount) into a UI number
function uiFromTokenBal(bal: any): number {
  try {
    if (typeof bal === "number") return Number.isFinite(bal) ? bal : 0;
    const v: any = (bal && (bal as any).value) ? (bal as any).value : bal;
    if (typeof v?.uiAmount === "number") return v.uiAmount;
    const dec = Number(v?.decimals ?? NaN);
    const amtStr = v?.amount;
    if (typeof amtStr === "string" && Number.isFinite(dec) && dec >= 0) {
      const amt = Number(amtStr);
      if (Number.isFinite(amt)) return amt / Math.pow(10, dec);
    }
  } catch {}
  return 0;
}

// 🔧 ONLY CHANGE: smarter RPC selection so server-side traffic bypasses Cloudflare
export function activeRpcString(): string {
  const isServer = typeof window === "undefined";

  if (isServer) {
    // On the server, prefer non-Cloudflare, secret RPCs so WAF/bot rules on mojomaxi.com
    // never interfere with Solana program traffic.
    return (
      process.env.HELIUS_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      process.env.SOLANA_MAINNET_RPC ||
      process.env.SOLANA_RPC_ENDPOINT ||
      // Fallback to the public envs if no server-only RPC is configured
      process.env.NEXT_PUBLIC_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
      "https://api.mainnet-beta.solana.com"
    );
  }

  // Browser: preserve existing behavior, only use NEXT_PUBLIC_* envs
  return (
    process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}


// Consolidated: delegate to the shared global singleton in @/lib/rpc instead of
// maintaining a duplicate module-scoped Connection.  The shared singleton uses
// globalThis.__mmSingletonConn__ with fetch-timeout middleware.
export function ensureConnection(): Connection {
  return _sharedEnsureConnection({ endpoint: activeRpcString() });
}


const VAULT_SEED = Buffer.from("vault");
const VAULT_AUTH_SEED = Buffer.from("vault_authority");

function uuidToBytes16(setId: string): Uint8Array {
  const raw = String(setId || "").replace(/-/g, "");
  const out = new Uint8Array(16);
  if (/^[0-9a-fA-F]{16,32}$/.test(raw)) {
    const hex = raw.slice(0, 32).padEnd(32, "0");
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const enc = new TextEncoder().encode(String(setId || "mm"));
  for (let i = 0; i < 16; i++) out[i] = enc[i % enc.length] ^ ((i * 131) & 0xff);
  return out;
}

export function deriveVaultPda(programId: PublicKey, admin: PublicKey, setId16: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, admin.toBuffer(), Buffer.from(setId16)], programId);
}
export function deriveVaultAuthorityPda(programId: PublicKey, vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_AUTH_SEED, vault.toBuffer()], programId);
}

async function detectTokenProgramId(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  try {
    const infoRes = await cachedGetAccountInfoOwner(conn, mint, "processed");
    const info = infoRes.exists ? { owner: infoRes.owner! } as any : null;
    if (info?.owner && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }
  } catch {}
  return TOKEN_PROGRAM_ID;
}

export async function checkVaultStatus(adminPk: PublicKey, setId: string) {
  const programIdStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID;
  if (!programIdStr) throw new Error("Missing VAULT_PROGRAM_ID");
  const programId = new PublicKey(programIdStr);
  const setBytes = uuidToBytes16(setId);
  const [vault] = deriveVaultPda(programId, adminPk, setBytes);
  const conn = ensureConnection();
  const info = await conn.getAccountInfo(vault, { commitment: "processed" });
  return { exists: !!info, vault };
}



export async function readBalances(
  adminPk: PublicKey,
  setId: string,
  mintA: string,
  mintB: string
): Promise<{
  vault: PublicKey;
  userA: { uiAmount: number; decimals: number };
  userB: { uiAmount: number; decimals: number };
  vaultA: { uiAmount: number; decimals: number };
  vaultB: { uiAmount: number; decimals: number };
}> {
  const programIdStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID;
  if (!programIdStr) throw new Error("Missing VAULT_PROGRAM_ID");
  const programId = new PublicKey(programIdStr);
  const setBytes = uuidToBytes16(setId);
  const [vault] = deriveVaultPda(programId, adminPk, setBytes);
  const [vaultAuth] = deriveVaultAuthorityPda(programId, vault);

  const conn = ensureConnection();

  const mintPkA = new PublicKey(mintA);
  const mintPkB = new PublicKey(mintB);

  // Detect token program IDs
  const tokenProgramIdA = await detectTokenProgramId(conn, mintPkA);
  const tokenProgramIdB = await detectTokenProgramId(conn, mintPkB);

  // Decimals per mint
  const mintInfoA = await cachedGetMint(conn, mintPkA, "processed", tokenProgramIdA);
  const mintInfoB = await cachedGetMint(conn, mintPkB, "processed", tokenProgramIdB);
  const decA = mintInfoA.decimals;
  const decB = mintInfoB.decimals;

  // ATAs (user + vault authority), derived under the correct token program
  const userAtaA = getAssociatedTokenAddressSync(mintPkA, adminPk, false, tokenProgramIdA, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userAtaB = getAssociatedTokenAddressSync(mintPkB, adminPk, false, tokenProgramIdB, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultAtaA = getAssociatedTokenAddressSync(mintPkA, vaultAuth, true, tokenProgramIdA, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultAtaB = getAssociatedTokenAddressSync(mintPkB, vaultAuth, true, tokenProgramIdB, ASSOCIATED_TOKEN_PROGRAM_ID);

  const [uA, uB, vA, vB] = await Promise.all([
    cachedGetTokenAccountBalance(conn, userAtaA).catch(() => 0),
    cachedGetTokenAccountBalance(conn, userAtaB).catch(() => 0),
    cachedGetTokenAccountBalance(conn, vaultAtaA).catch(() => 0),
    cachedGetTokenAccountBalance(conn, vaultAtaB).catch(() => 0),
  ]);

  return {
    vault,
    userA: { uiAmount: uiFromTokenBal(uA), decimals: decA },
    userB: { uiAmount: uiFromTokenBal(uB), decimals: decB },
    vaultA: { uiAmount: uiFromTokenBal(vA), decimals: decA },
    vaultB: { uiAmount: uiFromTokenBal(vB), decimals: decB },
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function resilientSend(
  tx: Transaction,
  conn: Connection,
  adapter?: { sendTransaction?: (tx: Transaction, conn: Connection, opts?: any) => Promise<string> }
): Promise<string> {
  if (adapter?.sendTransaction) {
    try {
      const sig = await adapter.sendTransaction(tx, conn, { maxRetries: 3 });
      if (typeof sig === "string" && sig.length > 10) return sig;
    } catch (e) {
      console.debug("[vault-sdk] adapter.sendTransaction failed, falling back", e);
    }
  }
  try {
    const w: any = typeof window !== "undefined" ? (window as any).solana : undefined;
    if (w?.signAndSendTransaction) {
      const { signature } = await w.signAndSendTransaction(tx, { maxRetries: 3 });
      if (typeof signature === "string") return signature;
    }
  } catch (e) {
    console.debug("[vault-sdk] signAndSendTransaction failed, falling back", e);
  }
  try {
    const w: any = typeof window !== "undefined" ? (window as any).solana : undefined;
    if (w?.signTransaction) {
      const signed = await w.signTransaction(tx);
      return await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    }
  } catch (e) {
    console.debug("[vault-sdk] signTransaction+sendRaw failed", e);
  }
  throw new Error("No available wallet method to send transaction.");
}

export async function initVault(
  _conn: Connection,
  walletLike: { publicKey: PublicKey; signTransaction?: (tx: Transaction) => Promise<Transaction> },
  setId: string,
  _tokenAMint?: string | PublicKey,
  _tokenBMint?: string | PublicKey,
  feeBps: number = 0
): Promise<{ sig: string; vault: PublicKey; authority: PublicKey }> {
  const admin = walletLike.publicKey;
  const r = await fetch("/api/vaults/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: admin.toBase58(), setId, feeBps }),
  });
  const j = await r.json();
  if (!j?.ok || !j?.tx64) throw new Error(j?.error || "Server did not return a transaction.");
  const tx = Transaction.from(base64ToBytes(String(j.tx64)));
  const conn = ensureConnection();

  let sig: string;
  if (walletLike.signTransaction) {
    const signed = await walletLike.signTransaction(tx);
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  } else {
    sig = await resilientSend(tx, conn);
  }

  return {
    sig,
    vault: j.meta?.vault ? new PublicKey(j.meta.vault) : (await checkVaultStatus(admin, setId)).vault,
    authority: j.meta?.authority ? new PublicKey(j.meta.authority) : ((): PublicKey => {
      const programIdStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID;
      if (!programIdStr) throw new Error("Missing VAULT_PROGRAM_ID");
      const programId = new PublicKey(programIdStr);
      const setBytes = uuidToBytes16(setId);
      const [vault] = deriveVaultPda(programId, admin, setBytes);
      const [auth] = deriveVaultAuthorityPda(programId, vault);
      return auth;
    })(),
  };
}

export async function initVaultWithSend(
  adapter: { publicKey: PublicKey; sendTransaction?: (tx: Transaction, conn: Connection, opts?: any) => Promise<string> },
  setId: string,
  _tokenAMint?: string | PublicKey,
  _tokenBMint?: string | PublicKey,
  feeBps: number = 0
): Promise<{ sig: string; vault: PublicKey; authority: PublicKey }> {
  const r = await fetch("/api/vaults/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admin: adapter.publicKey.toBase58(), setId, feeBps }),
  });
  const j = await r.json();
  if (!j?.ok || !j?.tx64) throw new Error(j?.error || "Server did not return a transaction.");
  const tx = Transaction.from(base64ToBytes(String(j.tx64)));
  const conn = ensureConnection();
  const sig = await resilientSend(tx, conn, adapter);

  const programIdStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID;
  if (!programIdStr) throw new Error("Missing VAULT_PROGRAM_ID");
  const programId = new PublicKey(programIdStr);
  const setBytes = uuidToBytes16(setId);
  const [vault] = deriveVaultPda(programId, adapter.publicKey, setBytes);
  const [authority] = deriveVaultAuthorityPda(programId, vault);
  return { sig, vault, authority };
}

export async function depositToVaultWithSend(
  adapter: { publicKey: PublicKey; sendTransaction?: (tx: Transaction, conn: Connection, opts?: any) => Promise<string> },
  setId: string,
  mintPk: PublicKey,
  amountUi: number
): Promise<string> {
  const conn = ensureConnection();
  return depositCore(conn, adapter.publicKey, (tx) => resilientSend(tx, conn, adapter), setId, mintPk, amountUi);
}

export async function depositToVault(
  conn: Connection,
  walletLike: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  setId: string,
  mintPk: PublicKey,
  amountUi: number
): Promise<string> {
  return depositCore(conn, walletLike.publicKey, async (tx) => {
    const signed = await walletLike.signTransaction(tx);
    return conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  }, setId, mintPk, amountUi);
}


async function depositCore(
  conn: Connection,
  userPk: PublicKey,
  sender: (tx: Transaction) => Promise<string>,
  setId: string,
  mintPk: PublicKey,
  amountUi: number
): Promise<string> {
  const programIdStr = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || process.env.VAULT_PROGRAM_ID;
  if (!programIdStr) throw new Error("Missing VAULT_PROGRAM_ID");
  const programId = new PublicKey(programIdStr);
  const setBytes = uuidToBytes16(setId);
  const [vault] = deriveVaultPda(programId, userPk, setBytes);
  const [authority] = deriveVaultAuthorityPda(programId, vault);

  // Detect token program and derive ATAs under the correct program
  const tokenProgramId = await detectTokenProgramId(conn, mintPk);
  const userAta = getAssociatedTokenAddressSync(mintPk, userPk, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultAta = getAssociatedTokenAddressSync(mintPk, authority, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

  // Use cached mint fetch (30d TTL) to avoid repeated RPC + reduce mobile jank
  const mintInfo = await cachedGetMint(conn, mintPk, "processed", tokenProgramId);
  const dec = mintInfo.decimals;
  const amount = BigInt(Math.round(amountUi * Math.pow(10, dec)));

  const ixs: any[] = [];
  // Use cached account-owner probe (batched) to avoid thundering-herd getAccountInfo
  const destInfoOwner = await cachedGetAccountInfoOwner(conn, vaultAta, "processed").catch(() => ({ exists: false } as any));
  if (!destInfoOwner?.exists) {
    ixs.push(createAssociatedTokenAccountInstruction(userPk, vaultAta, authority, mintPk, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  ixs.push(createTransferCheckedInstruction(userAta, mintPk, vaultAta, userPk, amount, dec, [], tokenProgramId));

  const tx = new Transaction().add(...ixs);
  const { blockhash } = await conn.getLatestBlockhash({ commitment: "processed" });
  tx.feePayer = userPk;
  tx.recentBlockhash = blockhash;

  return sender(tx);
}
