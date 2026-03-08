// filepath: src/app/api/sets/[setId]/deletable/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function base(req: NextRequest): string {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "";
  if (envUrl) return envUrl.replace(/\/+$/, "");
  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

type AnyObj = Record<string, any>;

export async function GET(req: NextRequest, { params }: any) {
  const setId = (params?.setId || "").trim();
  if (!setId) return NextResponse.json({ ok: false, error: "missing_setId" }, { status: 400 });

  const b = base(req);

  try {
    // 1) status + vault address
    const stR = await fetch(`${b}/api/vaults/status/${encodeURIComponent(setId)}`, { cache: "no-store" });
    const st = (await stR.json().catch(() => ({}))) as AnyObj;
    const status = String(st?.status || "").trim().toLowerCase();
    const vault = (st?.vault || st?.vaultId || "").toString().trim();

    if (!vault) {
      return NextResponse.json({ ok: true, deletable: true, reason: "no_vault", status, vault: null });
    }

    // 2) sum vault token balances via debug endpoint(s)
    const totals = { a: 0, b: 0, any: 0 };
    let ok = false;

    // Preferred
    try {
      const tR = await fetch(`${b}/api/vaults/debug/token-accounts/${encodeURIComponent(setId)}`, { cache: "no-store" });
      if (tR.ok) {
        const tJ = (await tR.json()) as AnyObj;
        const items: AnyObj[] = Array.isArray(tJ?.items) ? tJ.items : Array.isArray(tJ) ? tJ : [];
        let sum = 0;
        for (const it of items) {
          const ui = Number(it?.uiAmount || it?.ui || 0);
          if (isFinite(ui)) sum += ui;
        }
        totals.any = sum;
        ok = true;
      }
    } catch {}

    if (!ok) {
      // Fallback scan
      try {
        const sR = await fetch(`${b}/api/vaults/debug/scan-atas/${encodeURIComponent(setId)}`, { cache: "no-store" });
        if (sR.ok) {
          const sJ = (await sR.json()) as AnyObj;
          const accounts: AnyObj[] = Array.isArray(sJ?.accounts) ? sJ.accounts : [];
          let sum = 0;
          for (const a of accounts) {
            const ui = Number(a?.uiAmount || a?.ui || 0);
            if (isFinite(ui)) sum += ui;
          }
          totals.any = sum;
          ok = true;
        }
      } catch {}
    }

    if (!ok) {
      return NextResponse.json({ ok: true, deletable: false, reason: "error", status, vault, totals });
    }

    const zero = totals.any === 0;
    const deletable = status === "stopped" && zero;
    const reason = !zero ? "nonzero" : status !== "stopped" ? "running" : "stopped_and_zero";
    return NextResponse.json({ ok: true, deletable, reason, status, vault, totals });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 500 });
  }
}

