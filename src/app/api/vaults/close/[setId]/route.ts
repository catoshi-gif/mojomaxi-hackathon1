// src/app/api/vaults/close/[setId]/route.ts
import { NextRequest } from "next/server";

const BACKEND = process.env.VAULT_BACKEND_ORIGIN;

export async function POST(
  req: NextRequest,
  { params }: any
) {
  if (!BACKEND) {
    return new Response(JSON.stringify({ ok: false, error: "VAULT_BACKEND_ORIGIN not set" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const resp = await fetch(`${BACKEND}/api/vaults/close/${encodeURIComponent(params.setId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { "content-type": resp.headers.get("content-type") || "application/json" },
  });
}
