// FULL FILE REPLACEMENT for: src/app/_lib/tokenRegistry.ts
// filepath: src/app/_lib/tokenRegistry.ts
'use client';

/**
 * Minimal client-only registry for "mints visible on the page".
 * Panels (VaultInlinePanel, RebalanceInlinePanel, etc.) should call
 * registerVisibleMints() with a stable id and the list of mints they render.
 * The page-level orchestrator (in /app/app/page.tsx) reads from this registry
 * to compute the union and perform a one-shot cleanup sweep for missing
 * symbols and USD prices after first paint.
 *
 * Design constraints:
 * - Tiny and side-effect free (no timers). Purely stores sets in-memory.
 * - Safe with multiple panel instances: id-scoped buckets + cleanup.
 * - No server or network access here; orchestration happens in page.tsx.
 */

export type RegistryId = string;

const _buckets: Map<RegistryId, Set<string>> = new Map();

function _norm(m: string): string {
  return (m || '').trim();
}

/**
 * Register a set of mints for a given UI source id. Returns an unregister
 * function that should be called on unmount. Re-register by invoking again
 * with the same id (the previous set is replaced).
 */
export function registerVisibleMints(id: RegistryId, mints: readonly string[] | undefined | null): () => void {
  const next = new Set<string>();
  for (const m of mints || []) {
    const t = _norm(String(m));
    if (t) next.add(t);
  }
  _buckets.set(id, next);
  return () => {
    try { _buckets.delete(id); } catch {}
  };
}

/** Returns the union of all currently registered mints. */
export function getVisibleMints(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const set of _buckets.values()) {
    for (const m of set) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
