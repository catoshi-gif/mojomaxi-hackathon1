import { NextResponse } from "next/server";
import { guardDebugOrAdmin } from "@/lib/auth/guards";

const VAULT_BACKEND_URL = process.env.VAULT_BACKEND_URL!;
const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY!;

export async function POST(req: Request) {
  const blocked = guardDebugOrAdmin(req);
  if (blocked) return blocked;

  const { set } = await req.json().catch(() => ({}));
  if (!set) return NextResponse.json({ error: "Missing set" }, { status: 400 });

  const res = await fetch(`${VAULT_BACKEND_URL}/api/v1/vaults/pause`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-key": INTERNAL_API_KEY,
    },
    body: JSON.stringify({ set }),
  });

  const text = await res.text().catch(() => "");
  return new NextResponse(text || "{}", { status: res.status, headers: { "content-type": res.headers.get("content-type") || "application/json" }});
}
