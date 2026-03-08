// filepath: src/app/api/webhooks/prefs/route.ts
// Update label/prefs for a webhook set, with immutability guard once a vault exists.
//
// Sacred goals:
// - Do NOT change UI/UX contracts.
// - Persist webhook helper token selections so they survive refresh.
// - Keep token immutability once a vault exists (409 on attempted changes).
//
// Key implementation detail:
// - Redis hashes store string values. Storing nested `prefs` objects in a HASH is unreliable.
// - Therefore, we persist canonical mints as TOP-LEVEL string fields (mintA/mintB/mintIn/mintOut/tokenA/tokenB)
//   and a JSON string copy `prefsJson`.
// - The read path (/api/webhooks/for/[wallet]) should build the prefs object from these string-safe fields.

import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import type { NextRequest } from "next/server";
import {
  enforceWebhookImmutability,
  normalizeWebhookMintsFromDoc,
  getVaultForSetId,
  pinVaultMints,
} from "@/lib/immutability.guard";
import { requireOwnerSession } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


type AnyObj = Record<string, any>;

const K = {
  setDoc: (setId: string) => `mm:set:${setId}`,
  idIndex: (id: string) => `mm:id:${id}`,
};

function cleanStr(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
}

function stripPrefixToken(id: string): string {
  const m = String(id || "").match(/^(?:buy|sell)[_-](.+)$/i);
  return m ? m[1] : String(id || "");
}

function buildCanonicalMints(doc: AnyObj, merged: AnyObj): { mintIn?: string; mintOut?: string; mintA?: string; mintB?: string } {
  // merged wins, then doc fallbacks
  const mintIn = cleanStr(merged.mintIn) || cleanStr(merged.mintA) || cleanStr(merged.tokenA) || cleanStr(doc.mintIn) || cleanStr(doc.mintA) || cleanStr(doc.tokenA);
  const mintOut = cleanStr(merged.mintOut) || cleanStr(merged.mintB) || cleanStr(merged.tokenB) || cleanStr(doc.mintOut) || cleanStr(doc.mintB) || cleanStr(doc.tokenB);
  const mintA = mintIn;
  const mintB = mintOut;
  return { mintIn, mintOut, mintA, mintB };
}

export async function POST(req: NextRequest) {
  const owner = await requireOwnerSession(req as any);
  if (!(owner as any)?.ok) {
    // requireOwnerSession returns a union; the forbidden branch carries `res`.
    const r = (owner as any)?.res;
    return r || NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const body: AnyObj = await req.json().catch(() => ({} as AnyObj));
    const setId = String(body?.setId || body?.id || "").trim();
    if (!setId) return NextResponse.json({ ok: false, error: "missing setId" }, { status: 400 });

    const patchPrefs: AnyObj =
      body?.prefs && typeof body.prefs === "object"
        ? (body.prefs as AnyObj)
        : ({ label: body?.label, mintIn: body?.mintIn, mintOut: body?.mintOut } as AnyObj);

    // Load existing set doc (HASH)
    const doc: AnyObj = (await redis.hgetall<AnyObj>(K.setDoc(setId)).catch(() => ({} as AnyObj))) || {};
    const current = normalizeWebhookMintsFromDoc(doc || {});

    // Attempted mints for immutability check
    const attempted = {
      mintIn: cleanStr(patchPrefs.mintIn) || current.mintIn || undefined,
      mintOut: cleanStr(patchPrefs.mintOut) || current.mintOut || undefined,
      mintA: undefined as string | undefined,
      mintB: undefined as string | undefined,
    };

    const guard = await enforceWebhookImmutability({ setId, incoming: attempted });
    if (!guard.ok) {
      return NextResponse.json(
        { ok: false, error: guard.reason || "immutable_mints", canonical: guard.canonical, vault: guard.vault },
        { status: guard.status || 409 }
      );
    }

    // Merge label + prefs fields (we only care about mintIn/mintOut here)
    const merged: AnyObj = {};
    // If prior prefsJson exists, merge it first so we don't drop other keys.
    try {
      const raw = cleanStr(doc.prefsJson);
      if (raw && (raw.startsWith("{") || raw.startsWith("["))) {
        const j = JSON.parse(raw);
        if (j && typeof j === "object") Object.assign(merged, j);
      }
    } catch {}

    // Apply existing doc.prefs if it happens to be a proper object
    if (doc.prefs && typeof doc.prefs === "object") {
      Object.assign(merged, doc.prefs as AnyObj);
    }

    // Apply patch
    for (const [k, v] of Object.entries(patchPrefs || {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && !v.trim()) continue;
      merged[k] = v;
    }

    // Normalize mint aliases inside merged
    if (typeof merged.mintA === "string" && !merged.mintIn) merged.mintIn = merged.mintA;
    if (typeof merged.mintB === "string" && !merged.mintOut) merged.mintOut = merged.mintB;
    if (typeof merged.mintIn === "string" && !merged.mintA) merged.mintA = merged.mintIn;
    if (typeof merged.mintOut === "string" && !merged.mintB) merged.mintB = merged.mintOut;

    const canon = buildCanonicalMints(doc, merged);

    // Build the next doc update (string-safe fields only)
    const next: AnyObj = { ...doc };
    next.setId = String(next.setId || setId);

    if (typeof patchPrefs.label === "string") next.label = patchPrefs.label;

    // ✅ Canonical string-safe mint fields
    if (canon.mintA) next.mintA = canon.mintA;
    if (canon.mintB) next.mintB = canon.mintB;
    if (canon.mintIn) next.mintIn = canon.mintIn;
    if (canon.mintOut) next.mintOut = canon.mintOut;
    if (canon.mintA) next.tokenA = canon.mintA;
    if (canon.mintB) next.tokenB = canon.mintB;

    // Best-effort metadata passthrough (don’t break existing behavior)
    if (body?.tokenMeta && typeof body.tokenMeta === "object") next.tokenMeta = body.tokenMeta;

    // ✅ Canonical prefs JSON
    try { next.prefsJson = JSON.stringify(merged); } catch {}

    // We intentionally do NOT persist a nested prefs object into the HASH (unreliable),
    // but we keep it in the response for UI convenience.
    // If some older code wrote prefs as a string/object, leave it untouched in the hash.
    // (We also avoid setting next.prefs here.)

    // Persist set hash
    await redis.hset(K.setDoc(setId), next as any);

    // Best-effort: pin vault mints once vault exists
    if (guard?.vault && guard?.canonical) {
      try {
        // pinVaultMints expects a typed payload including type + setId.
        await pinVaultMints(guard.vault, { type: "webhook", setId, ...(guard.canonical as any) } as any);
      } catch {}

    }

    // Ensure id indexes exist (back-compat for prefixed IDs)
    const buyId = cleanStr(next.buyId);
    const sellId = cleanStr(next.sellId);
    const buyRaw = buyId ? stripPrefixToken(buyId) : undefined;
    const sellRaw = sellId ? stripPrefixToken(sellId) : undefined;

    const p = (redis as any).pipeline();
    if (buyId) p.hset(K.idIndex(buyId), { setId, kind: "buy" } as any);
    if (buyRaw && buyRaw !== buyId) p.hset(K.idIndex(buyRaw), { setId, kind: "buy" } as any);
    if (sellId) p.hset(K.idIndex(sellId), { setId, kind: "sell" } as any);
    if (sellRaw && sellRaw !== sellId) p.hset(K.idIndex(sellRaw), { setId, kind: "sell" } as any);
    try { await p.exec(); } catch {}

    // Response: keep UI contract (prefs object)
    const clean: AnyObj = { ...next };
    clean.prefs = {
      ...(typeof merged === "object" && merged ? merged : {}),
      ...(canon.mintA ? { mintA: canon.mintA } : {}),
      ...(canon.mintB ? { mintB: canon.mintB } : {}),
      ...(canon.mintIn ? { mintIn: canon.mintIn } : {}),
      ...(canon.mintOut ? { mintOut: canon.mintOut } : {}),
    };

    return NextResponse.json({ ok: true, set: clean });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "internal_error" }, { status: 500 });
  }
}
