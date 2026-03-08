import type { NextRequest } from "next/server";

export function baseUrlFrom(req: NextRequest): string {
  // Prefer NEXT_PUBLIC_SITE_URL if present
  const env = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  // Else infer from request
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`.replace(/\/+$/, "");
}
