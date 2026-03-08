// src/app/api/sets/[setId]/delete/route.ts
// Orchestrates a safe delete of a webhook set and its associated vault (if any).
// Adds an in-process fallback to bypass Cloudflare/WAF when internal HTTP calls are blocked.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Jsonish = Record<string, any>;

async function tryJson(res: Response): Promise<Jsonish> {
  try { return await res.json(); } catch { return {}; }
}

async function tryInProcessDelete(setId: string, secret: string) {
  // Dynamically import the internal deleter route and invoke it without a network hop.
  // This keeps the *exact same* deletion semantics while bypassing Cloudflare/WAF.
  try {
    // Import the route module that implements /api/webhooks/delete/[setId]
    // NOTE: keep specifier static so Next bundler includes it.
    const mod: any = await import("@/app/api/webhooks/delete/[setId]/route");

    // Build a Request compatible with the route’s handler.
    const url = `http://internal.local/api/webhooks/delete/${encodeURIComponent(setId)}${secret ? `?secret=${encodeURIComponent(secret)}` : ""}`;
    const req = new Request(url, {
      method: "DELETE",
      headers: secret ? new Headers({ "x-webhook-secret": secret, "content-type": "application/json" }) : new Headers({ "content-type": "application/json" }),
    });

    // Prefer DELETE handler; fall back to POST if necessary.
    const handler = typeof mod?.DELETE === "function" ? mod.DELETE : (typeof mod?.POST === "function" ? mod.POST : null);
    if (!handler) {
      return { ok: false, error: "deleter_handler_missing" };
    }

    const res: Response = await handler(req as any, { params: { setId } });
    const data = await tryJson(res);
    return { ok: Boolean(res.ok && (data?.ok !== false)), status: res.status, data };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function POST(req: NextRequest, { params }: any) {
  const setId = (params?.setId || "").trim();
  if (!setId) return NextResponse.json({ ok: false, error: "missing_setId" }, { status: 400 });

  const base = req.nextUrl?.origin || (() => { const u = new URL(req.url); return `${u.protocol}//${u.host}`; })();
  const secret = process.env.WEBHOOK_SECRET || "";

  // 1) Try to close the vault (best effort; ignore failures)
  try {
    await fetch(`${base}/api/vaults/close/${encodeURIComponent(setId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "user_delete_set" }),
      cache: "no-store",
    });
  } catch { /* ignore */ }

  // 2) Attempt to scrub all records via internal HTTP (might be blocked by Cloudflare/WAF)
  const delUrl = `${base}/api/webhooks/delete/${encodeURIComponent(setId)}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-webhook-secret"] = secret;

  const attempts: Array<{ url: string; init: RequestInit }> = [
    { url: delUrl, init: { method: "DELETE", headers, cache: "no-store" } },
    { url: delUrl, init: { method: "POST",  headers, cache: "no-store" } },
  ];

  if (secret) {
    const qp = `?secret=${encodeURIComponent(secret)}`;
    attempts.push(
      { url: delUrl + qp, init: { method: "DELETE", headers, cache: "no-store" } },
      { url: delUrl + qp, init: { method: "POST",  headers, cache: "no-store" } },
    );
  }

  let lastError: Jsonish | null = null;
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, a.init);
      const data = await tryJson(res);
      if (res.ok && data?.ok !== false) {
        return NextResponse.json({ ok: true, deleted: { setId }, via: "http" });
      }
      lastError = data || { status: res.status, statusText: res.statusText };
    } catch (e: any) {
      lastError = { error: String(e?.message || e) };
    }
  }

  // 3) FINAL FALLBACK: perform the deletion in-process (no network; bypasses Cloudflare/WAF)
  const direct = await tryInProcessDelete(setId, secret);
  if (direct.ok) {
    return NextResponse.json({ ok: true, deleted: { setId }, via: "in-process" });
  }

  // Still failed — surface useful diagnostic info
  return NextResponse.json(
    { ok: false, error: direct.error || lastError?.error || "delete_failed", detail: { http: lastError, direct } },
    { status: 500 },
  );
}
