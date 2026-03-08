// Optional: simple secret check for TradingView webhooks
// Hardened:
//  - In production, require WEBHOOK_SECRET to be set (fail closed).
//  - Constant-time comparison to reduce timing leaks.
//  - Support a small set of compatible header names for forwarders/proxies.
import "server-only";
import { timingSafeEqual } from "node:crypto";

function constantTimeEq(a: string, b: string): boolean {
  // timingSafeEqual throws if lengths differ
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Assert the inbound webhook is authorized.
 *
 * Expected header: x-webhook-secret: <WEBHOOK_SECRET>
 * Also accepts:
 *  - x-mm-webhook-secret
 *  - authorization: Bearer <WEBHOOK_SECRET>
 */
export function assertWebhookSecret(headers: Headers) {
  const expected = (process.env.WEBHOOK_SECRET || "").trim();
  const isProd = process.env.NODE_ENV === "production";

  // In production, this endpoint should never be open by accident.
  if (isProd && !expected) {
    const err = new Error("misconfigured");
    (err as any).status = 500;
    (err as any).detail = "WEBHOOK_SECRET must be set in production.";
    throw err;
  }

  // Disabled in dev unless explicitly configured.
  if (!expected) return;

  const auth = (headers.get("authorization") || "").trim();
  const bearer =
    auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";

  const got =
    (headers.get("x-webhook-secret") || "").trim() ||
    (headers.get("x-mm-webhook-secret") || "").trim() ||
    bearer;

  if (!got || !constantTimeEq(got, expected)) {
    const err = new Error("unauthorized");
    (err as any).status = 401;
    throw err;
  }
}
