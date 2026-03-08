// src/app/api/webhooks/delete/[setId]/route.ts
// Hard-delete a webhook set and all associated keys/indexes in Upstash Redis.
// - Accepts canonical or legacy ids (with or without 'set_' prefix)
// - Removes: mm:set:{id}*, reverse id indexes mm:id:*, wallet↔set memberships, and prunes wallet recent activity for this set
// - Idempotent: Safe to call multiple times; missing keys are ignored

import type { NextRequest } from "next/server";
import { redis } from "@/lib/redis";
import { getSessionWalletFromRequest } from "@/lib/auth/session.server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


type AnyObj = Record<string, any>;

function canonSetId(raw: string): string {
  const s = String(raw || "").trim();
  const m = s.match(/^set[_-]([a-z0-9-]+)$/i);
  return m ? m[1] : s;
}
function stripPrefixToken(t: string): string {
  const m = (t || "").trim().match(/^(buy|sell)[-_]?(.+)$/i);
  return m ? m[2] : (t || "").trim();
}

async function readSetDocAny(setId: string): Promise<AnyObj | null> {
  const keys = [
    `mm:set:${setId}`,
    `mm:set:set_${setId}`, // legacy
  ];
  for (const k of keys) {
    try {
      const h = await redis.hgetall<AnyObj>(k as any);
      if (h && Object.keys(h).length) return h;
    } catch {}
    try {
      const v = await redis.get<string>(k as any);
      if (v && typeof v === "string" && v.trim().startsWith("{")) {
        try {
          const j = JSON.parse(v) as AnyObj;
          if (j && typeof j === "object") return j;
        } catch {}
      }
    } catch {}
  }
  return null;
}

async function deleteReverseIndex(buyId?: string | null, sellId?: string | null): Promise<void> {
  const rawBuy = stripPrefixToken(String(buyId || ""));
  const rawSell = stripPrefixToken(String(sellId || ""));
  const candidates = [
    `mm:id:${String(buyId || "")}`,
    `mm:id:${rawBuy}`,
    `mm:id:${String(sellId || "")}`,
    `mm:id:${rawSell}`,
  ].filter(Boolean);
  if (candidates.length) {
    try { await (redis as any).del(...candidates); } catch {}
  }
}

async function deleteAllSetKeys(setId: string): Promise<number> {
  let cursor = "0";
  const toDelete: string[] = [];
  do {
    const res = await redis.scan(cursor, { match: `mm:set:${setId}*`, count: 200 }) as [string, string[]];
    const next = res?.[0] || "0";
    const keys = res?.[1] || [];
    for (const k of keys) toDelete.push(k);
    cursor = next;
  } while (cursor !== "0");
  // also remove legacy prefix keys
  try {
    const legacy = await redis.scan("0", { match: `mm:set:set_${setId}*`, count: 200 }) as [string, string[]];
    for (const k of (legacy?.[1] || [])) toDelete.push(k);
  } catch {}
  if (toDelete.length) {
    try { await (redis as any).del(...toDelete); } catch {}
  }
  return toDelete.length;
}

async function removeWalletMembership(wallet: string, setId: string): Promise<void> {
  // modern wallet set index
  try { await redis.srem(`mm:wallet:${wallet}:sets`, setId); } catch {}
  // legacy list index
  try { await redis.lrem(`mm:wh:sets:${wallet}:list`, 0, setId); } catch {}
  try { await redis.lrem(`mm:wh:sets:${wallet}:list`, 0, `set_${setId}`); } catch {}
}

async function pruneWalletRecentList(wallet: string, setId: string): Promise<number> {
  const key = `mm:wallet:${wallet.toLowerCase()}:recent`;
  let removed = 0;
  try {
    const rows = (await redis.lrange(key as any, 0, -1)) as string[];
    if (Array.isArray(rows) && rows.length) {
      const kept: string[] = [];
      for (const r of rows) {
        try {
          const j = JSON.parse(r);
          if (j && j.setId && String(j.setId) === setId) { removed++; continue; }
        } catch {}
        kept.push(r);
      }
      if (removed > 0) {
        try { await redis.del(key as any); } catch {}
        if (kept.length) {
          // rebuild preserving order (head-first)
          for (let i = kept.length - 1; i >= 0; i--) {
            try { await redis.lpush(key as any, kept[i]); } catch {}
          }
        }
      }
    }
  } catch {}
  return removed;
}

async function handleDelete(req: NextRequest, setIdRaw?: string) {
  try {
    const setId = canonSetId(String(setIdRaw || ""));
    if (!setId) return NextResponse.json({ ok: false, error: "missing_setId" }, { status: 400 });

    // Enforce wallet-session ownership: only the wallet that owns this set may delete it.
    const sessionWallet = await getSessionWalletFromRequest(req);
    if (!sessionWallet) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }


    const doc = await readSetDocAny(setId);
    if (!doc) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const wallet = String(doc.wallet || "");
    if (!wallet || wallet.trim() !== sessionWallet.trim()) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
    }
    const buyId  = String(doc.buyId  || "");
    const sellId = String(doc.sellId || "");

    await removeWalletMembership(wallet, setId);
    await deleteReverseIndex(buyId, sellId);
    const deleted = await deleteAllSetKeys(setId);
    const pruned = wallet ? await pruneWalletRecentList(wallet, setId) : 0;

    return NextResponse.json({ ok: true, deleted, pruned, setId });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: any) {
  return handleDelete(req, ctx?.params?.setId);
}
export async function POST(req: NextRequest, ctx: any) {
  return handleDelete(req, ctx?.params?.setId);
}

export async function GET(req: NextRequest, ctx: any) {
  const base = (() => { const u = new URL(req.url); return `${u.protocol}//${u.host}`; })();
  return NextResponse.json({
    ok: true,
    info: "Use DELETE (or POST) with admin secret to remove a set.",
    example: {
      delete: `${base}/api/webhooks/delete/${ctx?.params?.setId ?? "<setId>"}?secret=YOUR_SECRET`,
      header: "x-webhook-secret: YOUR_SECRET",
    },
  });
}
