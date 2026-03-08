// filepath: src/app/buy/[token]/route.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Robust origin inference (safe even if NEXT_PUBLIC_SITE_URL contains a path)
function inferOrigin(req: NextRequest): string {
  try {
    const u = new URL(req.url);
    if (u.origin && u.origin !== "null") return u.origin;
  } catch {}

  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL || "";
  if (envUrl) {
    try {
      const u = envUrl.startsWith("http") ? new URL(envUrl) : new URL(`https://${envUrl}`);
      return u.origin;
    } catch {}
  }

  // last resort: keep deterministic
  return "https://www.mojomaxi.com";
}

function forwardHeaders(tag: string): Record<string, string> {
  // Do NOT forward client IP headers; keep this wrapper minimal.
  return { "x-forwarded-from": tag };
}

function safeJsonParse(text: string): { ok: true; value: any } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function forwardPOST(req: NextRequest, token: string, tag: string): Promise<Response> {
  const origin = inferOrigin(req);
  const qs = new URL(req.url).search || "";
  const ingestUrl = `${origin}/api/ingest/${token}${qs}`;

  const bodyText = await req.text().catch(() => "");
  const contentType = req.headers.get("content-type") || "text/plain";

  const debug = (() => {
    try {
      const url = new URL(req.url);
      return url.searchParams.get("debug") === "1";
    } catch {
      return false;
    }
  })();

  try {
    const r = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": contentType,
        ...forwardHeaders(tag),
      },
      body: bodyText,
    });

    const text = await r.text();
    const parsed = safeJsonParse(text);

    // IMPORTANT: Always respond with JSON so callers (and `jq`) never choke.
    if (parsed.ok) {
      return NextResponse.json(parsed.value, { status: r.status });
    }

    // Upstream returned non-JSON (HTML/text). Wrap it so it's debuggable.
    return NextResponse.json(
      {
        ok: false,
        error: "upstream_non_json",
        upstreamStatus: r.status,
        upstreamContentType: r.headers.get("content-type") || null,
        body: debug ? text.slice(0, 4000) : undefined,
      },
      { status: 502 },
    );
  } catch (e: any) {
    // Fail closed with JSON so callers (and `jq`) don't choke on a non-JSON runtime error page.
    return NextResponse.json(
      {
        ok: false,
        error: "ingest_forward_failed",
        detail: debug ? String(e?.message || e) : "ingest_forward_failed",
      },
      { status: 502 },
    );
  }
}

// GET is a no-op (never forwards). Prevents scanners/link previews from triggering anything.
export async function GET() {
  return new NextResponse(null, { status: 204 });
}

export async function POST(req: NextRequest, ctx: any) {
  const token = String(ctx?.params?.token || "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing_token" }, { status: 400 });
  }
  return forwardPOST(req, token, "buy-pretty");
}
