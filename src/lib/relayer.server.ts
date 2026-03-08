// filepath: src/lib/relayer.server.ts
import 'server-only';
// server-only: load a relayer keypair for paying tx fees
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function parseKey(src?: string): Uint8Array {
  if (!src) throw new Error("RELAYER_SECRET_KEY not set");
  try {
    // base58 (preferred)
    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(src.trim())) {
      return Uint8Array.from(bs58.decode(src.trim()));
    }
    // JSON array
    const arr = JSON.parse(src);
    if (Array.isArray(arr)) return Uint8Array.from(arr);
  } catch {}
  throw new Error("RELAYER_SECRET_KEY must be base58 or JSON array");
}

let cached: Keypair | null = null;

export function getRelayer(): Keypair {
  if (cached) return cached;
  const secret = process.env.RELAYER_SECRET_KEY;
  const u8 = parseKey(secret);
  cached = Keypair.fromSecretKey(u8);
  return cached;
}
