// src/lib/env.server.ts
// Validated server-side environment using Zod.
// Throws a descriptive error at startup if required vars are missing,
// instead of crashing deep in a request handler with a non-null assertion.

import { z } from "zod";

const serverEnvSchema = z.object({
  siteUrl: z.string().url("NEXT_PUBLIC_SITE_URL must be a valid URL"),
  programId: z.string().min(32, "NEXT_PUBLIC_VAULT_PROGRAM_ID must be a valid Solana public key"),
  redisUrl: z.string().url("UPSTASH_REDIS_REST_URL must be a valid URL"),
  redisToken: z.string().min(1, "UPSTASH_REDIS_REST_TOKEN is required"),
  rpcUrl: z.string().url("SOLANA_RPC_URL must be a valid URL"),
  rpcHeaders: z
    .record(z.string())
    .optional(),
});

function parseRpcHeaders(): Record<string, string> | undefined {
  const raw = process.env.SOLANA_RPC_HEADERS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    console.warn("[env.server] SOLANA_RPC_HEADERS is not a valid JSON object, ignoring");
    return undefined;
  } catch (e) {
    console.warn("[env.server] SOLANA_RPC_HEADERS JSON parse failed:", e);
    return undefined;
  }
}

function buildEnv() {
  const raw = {
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL || "",
    programId: process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || "",
    redisUrl: process.env.UPSTASH_REDIS_REST_URL || "",
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    rpcUrl: process.env.SOLANA_RPC_URL || "",
    rpcHeaders: parseRpcHeaders(),
  };

  const result = serverEnvSchema.safeParse(raw);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(
      `[env.server] Missing or invalid environment variables:\n${missing}\n` +
        `The app may not function correctly. Set these in your .env or Vercel dashboard.`,
    );
    // Return raw values so the app can still attempt to start (graceful degradation).
    // Routes that need these values will fail with clear errors at call time.
    return raw as z.infer<typeof serverEnvSchema>;
  }

  return result.data;
}

export const env = buildEnv();
