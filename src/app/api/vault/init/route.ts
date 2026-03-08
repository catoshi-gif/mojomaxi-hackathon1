import { NextResponse } from "next/server";
import { guardDebugOrAdmin } from "@/lib/auth/guards";

const VAULT_BACKEND_URL = process.env.VAULT_BACKEND_URL!;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY!;

// Body: { owner: string; setId: string; tokenA: {mint:string}, tokenB:{mint:string} }
export async function POST(req: Request) {
  const blocked = guardDebugOrAdmin(req);
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const res = await fetch(`${VAULT_BACKEND_URL}/api/vaults/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-key": INTERNAL_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
