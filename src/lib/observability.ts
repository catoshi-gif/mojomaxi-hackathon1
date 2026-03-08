// filepath: src/lib/observability.ts
// Minimal structured observability helpers for launch hardening.
// Safe on both Edge and Node runtimes.

export type LogLevel = "info" | "warn" | "error";

export function getOrCreateRequestId(headers?: Headers | null): string {
  const existing =
    String(headers?.get("x-request-id") || "").trim() ||
    String(headers?.get("x-vercel-id") || "").trim();
  if (existing) return existing;
  try {
    const g: any = globalThis as any;
    const c = g?.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {}
  return `mm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function clientIpFromHeaders(headers?: Headers | null): string {
  const cf = String(headers?.get("cf-connecting-ip") || "").trim();
  if (cf) return cf;
  const xff = String(headers?.get("x-forwarded-for") || "").trim();
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  const xr = String(headers?.get("x-real-ip") || "").trim();
  return xr || "unknown";
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of ["api-key", "apikey", "key", "token", "auth"]) {
      if (u.searchParams.has(k)) u.searchParams.set(k, "REDACTED");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function summarizeError(err: unknown): string {
  if (!err) return "unknown_error";
  if (typeof err === "string") return err;
  const anyErr = err as any;
  return String(anyErr?.message || anyErr?.error || err);
}

export function logApiEvent(level: LogLevel, event: string, fields: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  try {
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    const fallback = `[${level}] ${event}`;
    if (level === "error") console.error(fallback, fields);
    else if (level === "warn") console.warn(fallback, fields);
    else console.log(fallback, fields);
  }
}
