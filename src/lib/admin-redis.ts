// File: src/lib/admin-redis.ts
// Minimal Upstash Redis REST helper (no new deps).
// Safe to co-exist with existing redis client; only used by admin routes.
//
// Env required (server-only):
// - UPSTASH_REDIS_REST_URL
// - UPSTASH_REDIS_REST_TOKEN
//
// Notes:
// - We use /pipeline endpoint to bundle commands and stay frugal.
// - All helpers handle JSON payloads when key values are JSON strings.
// - DOES NOT mutate existing app behavior; strictly additive for /admin APIs.

export type UpstashValue = string | number | null | Record<string, any> | Array<any>;

const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!URL_BASE || !TOKEN) {
  // We intentionally do not throw at import time to avoid build-time crashes on Vercel preview.
  // The first call will fail with a helpful error.
  // console.warn("[admin-redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

type PipelineCommand = (string | number)[];

async function _pipeline(commands: PipelineCommand[]): Promise<any[]> {
  if (!URL_BASE || !TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL / TOKEN are not set for admin pipeline.");
  }
  const res = await fetch(`${URL_BASE}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands),
    // Ensure we never cache admin data
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Upstash pipeline error: ${res.status} ${txt}`);
  }
  // Upstash returns an array of { result } or { error }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Unexpected Upstash pipeline response shape");
  }
  for (const item of data) {
    if (item && item.error) {
      throw new Error(`Upstash command error: ${item.error}`);
    }
  }
  return data.map((x: any) => (x ? x.result : null));
}

export async function cmd(command: PipelineCommand): Promise<any> {
  const [result] = await _pipeline([command]);
  return result;
}

export async function pipeline(commands: PipelineCommand[]): Promise<any[]> {
  return _pipeline(commands);
}

export async function get(key: string): Promise<UpstashValue> {
  const val = await cmd(["GET", key]);
  try {
    return typeof val === "string" ? JSON.parse(val) : val;
  } catch {
    return val;
  }
}

export async function set(key: string, value: any, opts?: { ex?: number; px?: number }) {
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  if (opts?.ex != null) return cmd(["SET", key, payload, "EX", opts.ex]);
  if (opts?.px != null) return cmd(["SET", key, payload, "PX", opts.px]);
  return cmd(["SET", key, payload]);
}

export async function zrevrangeWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>> {
  const raw = await cmd(["ZREVRANGE", key, start, stop, "WITHSCORES"]);
  // raw is array like [member, score, member, score, ...]
  if (!Array.isArray(raw)) return [];
  const out: Array<{ member: string; score: number }> = [];
  for (let i = 0; i < raw.length; i += 2) {
    const member = String(raw[i]);
    const score = Number(raw[i + 1]);
    out.push({ member, score: Number.isFinite(score) ? score : 0 });
  }
  return out;
}

export async function zadd(key: string, score: number, member: string) {
  return cmd(["ZADD", key, score, member]);
}

export async function lrange(key: string, start: number, stop: number): Promise<string[]> {
  const raw = await cmd(["LRANGE", key, start, stop]);
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

export async function scan(match: string, count = 200, cursor = "0"): Promise<{ cursor: string; keys: string[] }> {
  const res = await cmd(["SCAN", cursor, "MATCH", match, "COUNT", count]);
  // res: [ nextCursor, [keys...] ]
  if (!Array.isArray(res)) return { cursor: "0", keys: [] };
  const nextCursor = String(res[0] ?? "0");
  const keys: string[] = Array.isArray(res[1]) ? res[1].map((k: any) => String(k)) : [];
  return { cursor: nextCursor, keys };
}
