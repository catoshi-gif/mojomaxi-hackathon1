
// filepath: src/app/_providers/TokenMetaProvider.tsx
'use client';
import React from 'react';

export type TokenMeta = {
  mint: string;
  address: string;
  symbol?: string;
  name?: string;
  logoURI?: string;
  decimals?: number;
  verified?: boolean;
};

type Ctx = {
  byMint: Record<string, TokenMeta>;
  setMany: (items: TokenMeta[]) => void;
};

const Ctx = React.createContext<Ctx | null>(null);

function toMap(items: TokenMeta[]): Record<string, TokenMeta> {
  const out: Record<string, TokenMeta> = {};
  for (const it of items || []) {
    try {
      const k = String((it as any).address || (it as any).mint || '').trim();
      if (!k) continue;
      const v: TokenMeta = {
        address: k,
        mint: k,
        symbol: (it as any).symbol,
        name: (it as any).name,
        logoURI: (it as any).logoURI ?? (it as any).logoUri,
        decimals: (it as any).decimals,
        verified: (it as any).verified,
      };
      out[k] = v;
    } catch {}
  }
  return out;
}

export default function TokenMetaProvider({ children }: { children: React.ReactNode }) {
  // Seed from any bootstrap that the page may have placed on window
  const initial: Record<string, TokenMeta> = React.useMemo(() => {
    if (typeof window === 'undefined') return {};
    const boot: any = (window as any).mmTokenMetaSeed || (window as any).__mmBootTokens || null;
    if (Array.isArray(boot)) return toMap(boot);
    const fromBoot = (window as any).__mmBootstrap?.tokens?.items;
    if (Array.isArray(fromBoot)) return toMap(fromBoot);
    return {};
  }, []);

  const [byMint, setByMint] = React.useState<Record<string, TokenMeta>>(initial);

  const setMany = React.useCallback((items: TokenMeta[]) => {
    if (!items || !items.length) return;
    setByMint((prev) => ({ ...prev, ...toMap(items) }));
  }, []);

  // Allow anyone to quickly seed via a browser event
  React.useEffect(() => {
    function onSeed(e: Event) {
      try {
        const det: any = (e as CustomEvent).detail;
        const arr: TokenMeta[] = Array.isArray(det) ? det : [];
        if (arr.length) setByMint((prev) => ({ ...prev, ...toMap(arr) }));
      } catch {}
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('mm:seedTokens' as any, onSeed as any);
      return () => window.removeEventListener('mm:seedTokens' as any, onSeed as any);
    }
    return;
  }, []);

  const ctx = React.useMemo<Ctx>(() => ({ byMint, setMany }), [byMint, setMany]);

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

/**
 * useTokenMeta — client helper to obtain meta for a set of mints.
 * It first returns whatever the provider already knows, then fetches any missing metas
 * from /api/tokens/meta and updates the provider cache. No UI/UX changes.
 */
export function useTokenMeta(mints: string[]): Record<string, TokenMeta> {
  const ctx = React.useContext(Ctx);
  const [ready, setReady] = React.useState<Record<string, TokenMeta>>({});

  React.useEffect(() => {
    let alive = true;
    (async () => {
      if (!ctx) return;
      const uniq = Array.from(new Set((mints || []).filter(Boolean)));
      const missing = uniq.filter((m) => !ctx.byMint[m]);
      if (missing.length) {
        try {
          const r = await fetch(`/api/tokens/meta?mints=${encodeURIComponent(missing.join(','))}`, { cache: 'no-store' });
          const j: any = await r.json().catch(() => ({}));
          const items: TokenMeta[] = Array.isArray(j?.items) ? j.items : [];
          if (items.length) ctx.setMany(items);
        } catch {}
      }
      const map: Record<string, TokenMeta> = {};
      for (const m of uniq) if (ctx.byMint[m]) map[m] = ctx.byMint[m];
      if (alive) setReady(map);
    })();
    return () => { alive = false; };
  }, [JSON.stringify(mints || []), ctx?.byMint]); // eslint-disable-line react-hooks/exhaustive-deps

  return ready;
}
