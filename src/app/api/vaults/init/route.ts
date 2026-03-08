// src/app/api/vaults/init/route.ts
import { NextRequest } from "next/server";

const BACKEND = process.env.VAULT_BACKEND_ORIGIN; // e.g. https://mojomaxi-vault.vercel.app

if (!BACKEND) {
  // Fail fast in build/runtime if not configured
  console.warn("[vaults/init] VAULT_BACKEND_ORIGIN is not set");
}

export async function POST(req: NextRequest) {
  if (!BACKEND) {
    return new Response(JSON.stringify({ ok: false, error: "VAULT_BACKEND_ORIGIN not set" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const body = await req.text();
  const resp = await fetch(`${BACKEND}/api/vaults/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { "content-type": resp.headers.get("content-type") || "application/json" },
  });
}
