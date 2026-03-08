// src/lib/env.ts
// minimal env surface — no build-time throws

export const NEXT_PUBLIC_SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://mojomaxi-9znv.vercel.app";

export const SOLANA_RPC_URLS =
  (process.env.RPC_POOL || process.env.NEXT_PUBLIC_RPC_URL || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
