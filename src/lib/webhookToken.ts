// src/lib/webhookToken.ts
import { createHash, randomUUID } from "node:crypto";

export type HookKind = "buy" | "sell";

/**
 * Deterministic, URL-safe id from wallet + kind.
 * Useful for first-time seeding/recovery.
 */
export function stableWebhookId(wallet: string, kind: HookKind): string {
  const base = `${wallet}:${kind}:mojomaxi`;
  return createHash("sha256").update(base).digest("base64url").slice(0, 22);
}

/**
 * Fresh, non-JWT webhook id for (re)generation.
 * Keeps it short and URL-safe; not reversible.
 */
export function newWebhookId(wallet: string, kind: HookKind): string {
  const entropy = `${randomUUID()}:${wallet}:${kind}:${Date.now()}`;
  return createHash("sha256").update(entropy).digest("base64url").slice(0, 22);
}
