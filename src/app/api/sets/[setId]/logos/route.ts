// filepath: src/app/api/sets/[setId]/logos/route.ts
/**
 * Per-set sticky token logo storage.
 * - GET  -> { ok, logos: { [mint]: url } }
 * - POST -> merge { logos } into existing map; accepts only http(s) URLs
 *
 * Node-only + dynamic to work on Vercel with Upstash.
 */
import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


type AnyObj = Record<string, any>;
const KEY = (id: string) => `mm:v1:set:${id}:logos`;

function cleanId(v: unknown): string {
  return String(v ?? "").trim();
}

function sanitizeLogos(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const obj = (input && typeof input === "object") ? (input as AnyObj) : {};
    for (const [mintRaw, urlRaw] of Object.entries(obj)) {
      const mint = cleanId(mintRaw);
      const url = String(urlRaw ?? "").trim();
      if (!mint) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      out[mint] = url;
    }
  } catch {}
  return out;
}

export async function GET(_req: NextRequest, ctx: any) {
  const setId = cleanId(ctx?.params?.setId);
  if (!setId) return NextResponse.json({ ok: false, error: "missing setId" }, { status: 400 });
  try {
    const cur = await redis.get<Record<string, string> | null>(KEY(setId));
    const logos: Record<string, string> = (cur && typeof cur === "object") ? (cur as any) : {};
    return NextResponse.json({ ok: true, logos }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "kv error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: any) {
  const setId = cleanId(ctx?.params?.setId);
  if (!setId) return NextResponse.json({ ok: false, error: "missing setId" }, { status: 400 });
  try {
    const body = await req.json().catch(() => ({} as AnyObj));
    const incoming = sanitizeLogos((body as AnyObj)?.logos ?? body);
    if (!Object.keys(incoming).length) {
      return NextResponse.json({ ok: true, updated: 0, logos: {} }, { status: 200 });
    }
    const key = KEY(setId);
    const cur = await redis.get<Record<string, string> | null>(key);
    const merged = { ...(cur || {}), ...incoming };
    await redis.set(key, merged); // sticky (no TTL)
    return NextResponse.json({ ok: true, updated: Object.keys(incoming).length, logos: merged }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "kv error" }, { status: 500 });
  }
}
