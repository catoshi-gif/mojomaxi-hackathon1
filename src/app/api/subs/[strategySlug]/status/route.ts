// filepath: src/app/api/subs/[strategySlug]/status/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getSubscription } from "@/lib/strategy.store";

function _etagForSub(status: any): string {
  const raw = JSON.stringify(status || {});
  const h = crypto.createHash("sha1").update(raw).digest("base64url");
  return `W/"${h}"`;
}

export async function GET(req: NextRequest, { params }: any) {
  try {
    const url = new URL(req.url);
    const wallet = String(url.searchParams.get("wallet") || "").trim();
    if (!wallet) return NextResponse.json({ ok:false, error:"wallet_required" }, { status:400 });

    const s = await getSubscription("mojo-pro", wallet);
    const now = Date.now();
    const active = !!s && s.expiresAt > now;
    const status = {
      active,
      expiresAt: s?.expiresAt || 0,
      creditedUsd: s?.creditedUsd || 0,
      totalPaidUsd: s?.totalPaidUsd || 0,
    };

    const etag = _etagForSub(status);
    const inm = req.headers.get("if-none-match");
    if (inm && inm === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
    }

    return NextResponse.json({ ok:true, status }, { headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
  } catch (e: any) {
    return NextResponse.json({ ok:false, error: e?.message || "internal_error" }, { status:500 });
  }
}
