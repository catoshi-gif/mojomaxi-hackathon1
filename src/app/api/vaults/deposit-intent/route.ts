import { guardDebugOrAdmin } from "@/lib/auth/guards";
// src/app/api/vault/deposit-intent/route.ts
export const runtime = "nodejs";
const VAULT_BACKEND = process.env.NEXT_PUBLIC_VAULT_BACKEND_URL!;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY!;

export async function POST(req: Request) {
  const blocked = guardDebugOrAdmin(req);
  if (blocked) return blocked;

  const body = await req.json();
  const r = await fetch(`${VAULT_BACKEND}/api/v1/deposit-intent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": INTERNAL_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return new Response(text, { status: r.status });
}
