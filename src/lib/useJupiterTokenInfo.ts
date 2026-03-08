// src/lib/useJupiterTokenInfo.ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePollingGate } from "@/lib/useActivityGate";

type PricesResponseV3 = {
  ok?: boolean;
  data?: Record<string, any>;
  prices?: Record<string, number>;
};

type TokenMeta = {
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
};

type TokenMetaResponseV2 = {
  data?: TokenMeta | null;
};

export type TokenInfo = {
  mint: string;
  name: string;
  symbol: string;
  decimals: number | null;
  priceUsd: number | null;
};

type CacheBuckets = {
  prices: Map<string, { value: number; ts: number }>;
  meta: Map<string, { value: TokenMeta; ts: number }>;
};

const CACHE_TTL_MS = 55_000;
const cache: CacheBuckets = {
  prices: new Map(),
  meta: new Map(),
};

async function fetchPricesV3(mints: string[]): Promise<Record<string, number>> {
  const ids = Array.from(new Set(mints)).filter(Boolean);
  if (ids.length === 0) return {};
  const url = `/api/prices?mints=${encodeURIComponent(ids.join(','))}`;
  // Allow browser/CDN caching (ETag + Cache-Control) from /api/prices.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter price v3 failed: ${res.status}`);
  const json: PricesResponseV3 = await res.json();
  const out: Record<string, number> = {};
  for (const key of Object.keys(json?.data || {})) {
    const entry: any = (json as any).data[key];
    const n = typeof entry === 'number' ? entry : Number(entry?.price ?? entry?.usdPrice ?? entry);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

async function fetchTokenMetaV2(mint: string): Promise<TokenMeta | null> {
  // Client-side: never call Jupiter directly (Pro may require API key). Use server API.
  try {
    // Token meta is cached server-side; do not force origin hits from the client.
    const res = await fetch(`/api/tokens/meta?mints=${encodeURIComponent(mint)}`);
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const items = json?.items || json?.data || json?.tokens || null;
    if (Array.isArray(items) && items.length) {
      const it = items.find((x: any) => String(x?.mint || x?.address || "").trim() === mint) || items[0];
      return {
        address: String(it?.mint || it?.address || mint),
        name: it?.name,
        symbol: it?.symbol,
        decimals: typeof it?.decimals === "number" ? it.decimals : undefined,
      };
    }
    // Some implementations return a map keyed by mint
    if (items && typeof items === "object") {
      const it = (items as any)[mint];
      if (it) {
        return {
          address: String(it?.mint || it?.address || mint),
          name: it?.name,
          symbol: it?.symbol,
          decimals: typeof it?.decimals === "number" ? it.decimals : undefined,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isFresh(ts: number) {
  return Date.now() - ts < CACHE_TTL_MS;
}

export function useJupiterTokenInfo(inputMints: string[], refreshMs = 60_000) {
  const { shouldPoll } = usePollingGate({ idleMs: 60_000 });
  const mints = useMemo(() => Array.from(new Set((inputMints || []).filter(Boolean))), [inputMints]);
  const [data, setData] = useState<Record<string, TokenInfo>>({});
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (mints.length === 0) return;

    const toFetchPrices: string[] = [];
    const now = Date.now();
    for (const m of mints) {
      const p = cache.prices.get(m);
      if (!p || !isFresh(p.ts)) toFetchPrices.push(m);
    }
    if (toFetchPrices.length) {
      try {
        const fresh = await fetchPricesV3(toFetchPrices);
        for (const [mint, price] of Object.entries(fresh)) {
          cache.prices.set(mint, { value: price, ts: now });
        }
      } catch (e) {
        console.warn("[useJupiterTokenInfo] price fetch failed", e);
      }
    }

    const metas = await Promise.all(
      mints.map(async (m) => {
        const cached = cache.meta.get(m);
        if (cached && isFresh(cached.ts)) return cached.value;
        const meta = await fetchTokenMetaV2(m);
        if (meta) cache.meta.set(m, { value: meta, ts: now });
        return meta;
      })
    );

    const next: Record<string, TokenInfo> = {};
    for (let i = 0; i < mints.length; i++) {
      const mint = mints[i];
      const meta = metas[i] || undefined;
      const price = cache.prices.get(mint)?.value ?? null;
      next[mint] = {
        mint,
        name: meta?.name || "",
        symbol: meta?.symbol || "",
        decimals: typeof meta?.decimals === "number" ? meta!.decimals! : null,
        priceUsd: typeof price === "number" ? price : null,
      };
    }
    setData(next);
  }, [mints]);

  useEffect(() => {
    load();
    if (refreshMs && refreshMs > 0) {
      // @ts-ignore
      timerRef.current = shouldPoll ? window.setInterval(load, refreshMs) : null;
      return () => {
        if (timerRef.current) {
          // @ts-ignore
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
      };
    }
  }, [load, refreshMs, shouldPoll]);

  return {
    byMint: data,
    get(mint: string) {
      return data[mint] || null;
    },
  };
}
