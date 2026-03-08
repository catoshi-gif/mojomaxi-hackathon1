import type { NextRequest } from "next/server";

const INTERNAL_SECRET_KEYS = [
  "X_MM_INTERNAL_TOKEN",
  "MM_INTERNAL_TOKEN",
  "MOJOMAXI_INTERNAL_TOKEN",
  "INTERNAL_SHARED_SECRET",
  "INTERNAL_GATEWAY_SECRET",
  "INTERNAL_FETCH_TOKEN",
] as const;

function readFirstEnv(keys: readonly string[]): string {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export function constantTimeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

export function getInternalSecret(): string {
  return readFirstEnv(INTERNAL_SECRET_KEYS);
}

export function getCronSecret(): string {
  return String(process.env.CRON_SECRET || "").trim();
}

export function getVercelBypassSecret(): string {
  return String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
}

export function getProvidedInternalToken(headers: Headers): string {
  const auth = String(headers.get("authorization") || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return (
    bearer ||
    String(headers.get("x-mm-internal-token") || "").trim() ||
    String(headers.get("x-mojomaxi-internal-token") || "").trim()
  );
}

export function hasTrustedInternalProof(headers: Headers): boolean {
  const cron = getCronSecret();
  const auth = String(headers.get("authorization") || "").trim();
  if (cron && auth === `Bearer ${cron}`) return true;

  const bypass = getVercelBypassSecret();
  if (bypass && String(headers.get("x-vercel-protection-bypass") || "").trim() === bypass) {
    return true;
  }

  const expected = getInternalSecret();
  const provided = getProvidedInternalToken(headers);
  if (!expected || !provided) return false;
  return provided === expected || constantTimeEq(provided, expected);
}

export function isTrustedInternalRequest(req: Request | NextRequest): boolean {
  return hasTrustedInternalProof(req.headers);
}

export function sanitizeInternalHeaders(input: Headers, trusted: boolean): Headers {
  const out = new Headers(input);
  out.delete("x-mm-internal");
  out.delete("x-mm-internal-token");
  out.delete("x-mojomaxi-internal-token");
  if (trusted) out.set("x-mm-internal", "1");
  return out;
}

export function getAllowedInternalHosts(): string[] {
  const envHosts = String(process.env.MM_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const siteHost = String(process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim()
    .toLowerCase();

  const vercelHost = String(process.env.VERCEL_URL || process.env.NEXT_PUBLIC_VERCEL_URL || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim()
    .toLowerCase();

  return Array.from(new Set(["mojomaxi.com", siteHost, vercelHost, ...envHosts].filter(Boolean)));
}
