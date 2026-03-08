// src/lib/redis.ts
// Single shared Upstash Redis client for the entire app.
// Every module that needs Redis should import from here.
// P0 consolidation: avoids 5–6 separate Redis.fromEnv() instances
// which can exhaust connection limits under burst concurrency.

import { Redis } from "@upstash/redis";

let _instance: Redis | null = null;

function createRedis(): Redis {
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (url && token) {
    return new Redis({ url, token });
  }
  // Fallback: fromEnv() will use the same env vars but also supports
  // UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN automatically.
  return Redis.fromEnv();
}

export function getRedis(): Redis {
  if (!_instance) _instance = createRedis();
  return _instance;
}

/** The shared singleton — use this everywhere. */
export const redis = getRedis();
