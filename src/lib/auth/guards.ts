import { NextRequest, NextResponse } from "next/server";
import { getSessionWalletFromRequest } from "@/lib/auth/session.server";
import { isTrustedInternalRequest } from "@/lib/auth/internal";

// Enforce owner session for DApp mutations:
// - validates a logged-in wallet session (httpOnly cookie)
// - requires x-wallet header to match session wallet
// - if body contains a "wallet" field, it must also match
export async function requireOwnerSession(req: NextRequest, ownerWallet?: string) : Promise<{ ok: true; wallet: string } | { ok: false; res: NextResponse }> {
  const sessionWallet = await getSessionWalletFromRequest(req as any);
  if (!sessionWallet) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }

  const headerWallet = (req.headers.get("x-wallet") || "").trim();
  if (!headerWallet || headerWallet !== sessionWallet) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  }

  // If caller provided a wallet in body, enforce it matches the session too.
  // Use a clone so we don't consume the body stream used later by the route.
  try {
    const clone = req.clone();
    const body: any = await clone.json();
    if (body && typeof body === "object" && body.wallet) {
      const bodyWallet = String(body.wallet).trim();
      if (bodyWallet && bodyWallet !== sessionWallet) {
        return { ok: false, res: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
      }
    }
  } catch {
    // ignore JSON parse errors; route may not use body or may read it as text/form
  }

  if (ownerWallet) {
    const owner = String(ownerWallet || "").trim();
    if (owner && owner !== sessionWallet) {
      return { ok: false, res: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
    }
  }

  return { ok: true, wallet: sessionWallet };
}

// In production, hide debug endpoints unless an internal token is provided.
// Uses existing X_MM_INTERNAL_TOKEN env and header.
export function guardDebugOrAdmin(req: Request) : NextResponse | null {
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) return null;

  if (isTrustedInternalRequest(req)) return null;

  return new NextResponse("Not found", { status: 404 });
}
