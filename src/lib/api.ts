// src/lib/api.ts
export type UiToken = { symbol: string; name: string; mint: string; logoURI: string };

export async function fetchTopTokens(): Promise<UiToken[]> {
  const r = await fetch("/api/tokens/top", { cache: "no-store" });
  const j = await r.json().catch(() => ({ ok: false, items: [] }));
  return Array.isArray(j.items) ? j.items : [];
}

export async function searchTokens(q: string): Promise<UiToken[]> {
  if (!q.trim()) return [];
  const r = await fetch(`/api/tokens/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
  const j = await r.json().catch(() => ({ ok: false, items: [] }));
  return Array.isArray(j.items) ? j.items : [];
}

export async function updateSetPrefs(setId: string, patch: Record<string, any>) {
  const r = await fetch(`/api/webhooks/set/${setId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefs: patch }),
  });
  return r.json();
}
