// filepath: src/lib/solana.ts
import { Commitment, Connection, PublicKey } from "@solana/web3.js";

/**
 * Public, browser-safe Solana config & helpers.
 * - No secrets here.
 * - Browser should use Cloudflare Worker (NEXT_PUBLIC_RPC_URL).
 * - Fallback to public mainnet.
 */
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || "2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp"
);

// Client RPC endpoint (no keys)
export const RPC_URL: string =
  (process.env.NEXT_PUBLIC_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL.trim()) ||
  (process.env.NEXT_PUBLIC_SOLANA_RPC_URL && process.env.NEXT_PUBLIC_SOLANA_RPC_URL.trim()) ||
  "https://api.mainnet-beta.solana.com";

/** Lightweight shared client Connection (no custom headers). */
let __clientConn: Connection | null = null;
export function connection(commitment: Commitment = "processed"): Connection {
  if (__clientConn) return __clientConn;
  __clientConn = new Connection(RPC_URL, { commitment });
  return __clientConn;
}

/** Utility: coerce 0x/hex into a fixed 16-byte Buffer (left-padded). */
export function hexToBytes16(hex: string): Buffer {
  const clean = (hex || "").replace(/[^0-9a-fA-F]/g, "");
  const buf = Buffer.from(clean.length % 2 ? "0" + clean : clean, "hex");
  if (buf.length === 16) return buf;
  if (buf.length > 16) return buf.subarray(0, 16);
  const out = Buffer.alloc(16);
  buf.copy(out, 16 - buf.length);
  return out;
}

/** Native SOL "mint" placeholder used in UI logic. */
export const MINT_SOL = "So11111111111111111111111111111111111111112";
