// src/lib/trade.ts
// Frontend server-only helper that forwards TradingView signals to the vault backend.
// NOTE: This file is only imported from Next.js "route handlers" (server) –
// so process.env stays server-side and the INTERNAL key is never exposed to browsers.

type ExecuteTradeArgs = {
  set: string;                   // e.g. "set_c802bac0-..."  (your webhook set id)
  kind: "buy" | "sell";          // derived from the link user copies
  payload: unknown;              // TradingView payload as-is (we'll canonicalize at backend)
};

const VAULT_BACKEND_URL = process.env.VAULT_BACKEND_URL;   // e.g. https://mojomaxi-vault.vercel.app
const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY;    // shared secret between FE -> BE

if (!VAULT_BACKEND_URL) {
  console.warn("[trade.ts] VAULT_BACKEND_URL is not set – forwarding will fail.");
}
if (!INTERNAL_API_KEY) {
  console.warn("[trade.ts] INTERNAL_API_KEY is not set – forwarding will fail.");
}

function makeIdempotencyKey(set: string, kind: string, payload: unknown) {
  // stable-ish id for replays (TradingView retries)
  const raw = JSON.stringify({ set, kind, payload });
  const encoder = new TextEncoder();
  const bytes = encoder.encode(raw);
  // simple DJB2 hash – cheap and good enough; backend still re-checks
  let h = 5381;
  for (let i = 0; i < bytes.length; i++) h = ((h << 5) + h) ^ bytes[i];
  return `tv-${set}-${kind}-${(h >>> 0).toString(16)}`;
}

export async function executeTrade({ set, kind, payload }: ExecuteTradeArgs) {
  if (!VAULT_BACKEND_URL || !INTERNAL_API_KEY) {
    throw new Error("Server not configured with VAULT_BACKEND_URL/INTERNAL_API_KEY");
  }

  const url = `${VAULT_BACKEND_URL.replace(/\/+$/, "")}/api/v1/ingest/${encodeURIComponent(set)}/${kind}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-key": INTERNAL_API_KEY,
      "x-idempotency-key": makeIdempotencyKey(set, kind, payload),
    },
    body: JSON.stringify({
      source: "tradingview",
      receivedAt: new Date().toISOString(),
      payload,            // pass-through
    }),
    // Don’t block TradingView on long work – the backend should decouple fast.
    // If you prefer to stream logs back, make this longer and return text.
    // 10s is plenty to accept/store/queue.
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vault backend ${res.status}: ${text || res.statusText}`);
  }

  // For visibility, return whatever backend echoes (job id / ok flag).
  return res.json().catch(() => ({}));
}

// Convenience wrappers for the Run/Pause/Stop buttons in your UI.
// These call FE proxy routes at /api/vaults/* that keep your key server-side.
async function postProxy(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`${path} failed: ${msg || res.statusText}`);
  }
  return res.json().catch(() => ({}));
}

export function runVault(set: string)   { return postProxy("/api/vaults/run",   { set }); }
export function pauseVault(set: string) { return postProxy("/api/vaults/pause", { set }); }
export function stopVault(set: string)  { return postProxy("/api/vaults/stop",  { set }); }
