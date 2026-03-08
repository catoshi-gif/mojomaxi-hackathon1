// src/app/api/tokens/top/route.ts
// Jupiter Token API v2 (Lite) — Top traded 24h → normalize to {address,mint,symbol,name,logoURI,verified}

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 21600; // 6h

type AnyObj = Record<string, any>;

const JUP_API_KEY = (process.env.JUP_API_KEY || process.env.JUPITER_API_KEY || "").trim();
function jupHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (JUP_API_KEY) h["x-api-key"] = JUP_API_KEY;
  return h;
}

const LITE = "https://api.jup.ag/tokens/v2";

function isVerified(t: AnyObj): boolean {
  const v = t?.verified ?? t?.isVerified ?? t?.jupVerified;
  if (typeof v === "boolean") return v;

  const tags: string[] = Array.isArray(t?.tags) ? t.tags : [];
  const cats: string[] = Array.isArray(t?.categories) ? t.categories : [];
  const lbls: string[] = Array.isArray(t?.labels) ? t.labels : [];
  const hay = [...tags, ...cats, ...lbls].map((s) => String(s).toLowerCase());
  return hay.includes("verified") || hay.includes("jup-verified") || hay.includes("jupiter-verified");
}

function norm(t: AnyObj) {
  const id = String(t?.id ?? t?.mint ?? t?.address ?? "").trim();
  return {
    symbol: String(t?.symbol ?? "").toUpperCase(),
    name: String(t?.name ?? t?.symbol ?? "").trim(),
    address: id,
    mint: id,
    logoURI: String(t?.icon ?? t?.logoURI ?? "").trim(),
    verified: isVerified(t),
  };
}

// Pinned fallback if the API hiccups (kept tiny)
const FALLBACK_PINNED: AnyObj[] = [
  { id: "So11111111111111111111111111111111111111112", symbol: "SOL",  name: "Wrapped SOL", icon: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png", verified: true },
  { id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin", verified: true },
  { id: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "Tether USD", verified: true },
  { id: "JUP2jxvDsQdPZB6eV8aWX7Ga2oF3D6w9M8w36wS4kvb", symbol: "JUP",  name: "Jupiter", verified: true },
  { id: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk", verified: true },
  { id: "7WifqRZ2uL6zzb8aF7t4uV3oSGVw1s4v6t1tKkJ1bRRf", symbol: "WIF",  name: "dogwifhat", verified: true },
];

export async function GET() {
  try {
    // Docs pattern: /tokens/v2/<category>/<interval>?limit=...
    // We’ll use "toptraded/24h" as a good default signal.
    const res = await fetch(`${LITE}/toptraded/24h?limit=80`, {
      
      headers: jupHeaders(),
      cache: "force-cache",
      next: { revalidate },
    });
    if (!res.ok) throw new Error(`jup toptraded failed: ${res.status}`);
    const data = await res.json();
    const raw: AnyObj[] = Array.isArray(data) ? data : [];

    // Normalize & dedupe
    const seen = new Set<string>();
    const list: AnyObj[] = [];
    for (const t of raw) {
      const n = norm(t);
      if (!n.address || seen.has(n.address)) continue;
      seen.add(n.address);
      list.push(n);
    }
    // Keep Jupiter's order (toptraded/24h already ranked by 24h volume)
    const tokens = list.slice(0, 20);
    return NextResponse.json({ ok: true, tokens, items: tokens, updatedAt: Date.now() });
  } catch {
    const tokens = FALLBACK_PINNED.map(norm);
    return NextResponse.json({ ok: true, tokens, items: tokens, updatedAt: Date.now() });
  }
}
