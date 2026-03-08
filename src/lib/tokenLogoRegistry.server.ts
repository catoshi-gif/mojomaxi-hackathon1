// filepath: src/lib/tokenLogoRegistry.server.ts
// Global token logo registry (per-mint) backed by Upstash Redis.
// - Source of truth for token images across VaultInlinePanel & RebalanceInlinePanel.
// - Only populated from:
//    • Frontend TokenPicker logos at vault creation time (logos param)
//    • Jupiter Tokens API (Pro host) token meta (v2/token + search) for backfill
// - Never writes DexScreener / Birdeye / TrustWallet derived URLs into the registry.
//
// Node-only module.
import "server-only";
import { redis } from "@/lib/redis";

type AnyObj = Record<string, any>;

const GLOBAL_LOGO_KEY = "mm:v1:logos";

function isHttpUrl(val: unknown): val is string {
  return typeof val === "string" && /^https?:\/\//i.test(val);
}

/** Merge provided logos into the global registry, without overwriting existing entries. */

const JUP_API_KEY = (process.env.JUP_API_KEY || process.env.JUPITER_API_KEY || "").trim();
function jupHeaders(): HeadersInit {
  const h: Record<string, string> = { accept: "application/json" };
  if (JUP_API_KEY) h["x-api-key"] = JUP_API_KEY;
  return h;
}

async function fetchJupTokenMetaByMint(mint: string): Promise<{ icon?: string | null } | null> {
  const needle = String(mint || "").trim();
  if (!needle) return null;
  // Tokens v2: query by mint via search + exact id match
  const url = `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(needle)}&limit=20`;
  try {
    const r = await fetch(url, { cache: "no-store", headers: jupHeaders() });
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!Array.isArray(j)) return null;
    const hit = j.find((x: any) => String(x?.id || x?.mint || "").trim() === needle);
    if (!hit) return null;
    return { icon: typeof hit?.icon === "string" ? hit.icon : null };
  } catch {
    return null;
  }
}

export async function upsertGlobalTokenLogos(logos?: Record<string, string> | null): Promise<void> {
  try {
    if (!logos || typeof logos !== "object") return;
    const entries = Object.entries(logos)
      .map(([mint, url]) => [String(mint || "").trim(), String(url || "").trim()] as [string, string])
      .filter(([mint, url]) => !!mint && isHttpUrl(url));

    if (!entries.length) return;

    const current = (await redis.get<Record<string, string> | null>(GLOBAL_LOGO_KEY)) || {};
    const next: Record<string, string> = { ...current };
    let dirty = false;

    for (const [mint, url] of entries) {
      if (!next[mint]) {
        next[mint] = url;
        dirty = true;
      }
    }

    if (dirty) {
      await redis.set(GLOBAL_LOGO_KEY, next);
    }
  } catch {
    // best-effort only
  }
}

export async function getGlobalTokenLogo(mint: string): Promise<string | null> {
  const needle = String(mint || "").trim();
  if (!needle) return null;
  try {
    const current = (await redis.get<Record<string, string> | null>(GLOBAL_LOGO_KEY)) || {};
    const url = current[needle];
    return isHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}

async function fetchJupLiteLogo(mint: string): Promise<string | null> {
  const needle = String(mint || "").trim();
  if (!needle) return null;

  const meta = await fetchJupTokenMetaByMint(needle);
  const icon = meta?.icon;
  if (isHttpUrl(icon)) return icon;
  return null;
}

/**
 * Read the logo from the global registry; if missing, backfill from Jupiter Tokens API (Pro host) ONLY
 * and persist the discovered URL into the registry for future callers.
 */
export async function getOrBackfillGlobalTokenLogo(mint: string): Promise<string | null> {
  const needle = String(mint || "").trim();
  if (!needle) return null;

  const existing = await getGlobalTokenLogo(needle);
  if (existing) return existing;

  const url = await fetchJupLiteLogo(needle);
  if (!url) return null;

  try {
    await upsertGlobalTokenLogos({ [needle]: url });
  } catch {
    // best-effort
  }
  return url;
}
