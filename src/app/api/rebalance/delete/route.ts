
import { NextResponse } from "next/server";
import { getSessionWalletFromRequest } from "@/lib/auth/session.server";
import { deleteRebalanceSetAndEvents } from "@/lib/rebalance-store";

export async function DELETE(req: Request) {
  try {

    const sessionWallet = await getSessionWalletFromRequest(req as any);
    if (!sessionWallet) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const wallet = sessionWallet;

    if (!wallet) return NextResponse.json({ ok: false, error: "missing wallet" }, { status: 400 });
    const body = await req.json().catch(() => ({}));
    const setId = String(body?.setId || "");
    if (!setId) return NextResponse.json({ ok: false, error: "missing setId" }, { status: 400 });

    const out = await deleteRebalanceSetAndEvents(wallet, setId);
    return NextResponse.json({ ok: true, ...out });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
