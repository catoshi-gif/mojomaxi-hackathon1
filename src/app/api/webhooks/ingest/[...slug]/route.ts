// filepath: src/app/api/webhooks/ingest/[...slug]/route.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  return "https://www.mojomaxi.com";
}

function forwardHeaders(tag: string): Record<string, string> {
  return { "x-forwarded-from": tag };
}

function tokenFromSlug(slug: string[] | undefined): string | null {
  if (!slug || slug.length === 0) return null;
  const last = slug[slug.length - 1] || "";
  // Preserve your historical behavior: accept raw token OR extract trailing hex-ish id.
  const m = last.match(/([a-f0-9]{8,})$/i);
  return m ? m[1] : last;
}

async function forwardPOST(req: NextRequest, token: string): Promise<Response> {
  const origin = inferOrigin(req);
  const qs = new URL(req.url).search || "";
  const ingestUrl = `${origin}/api/ingest/${token}${qs}`;

  const bodyText = await req.text().catch(() => "");
  const contentType = req.headers.get("content-type") || "text/plain";

  const r = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...forwardHeaders("webhooks-ingest"),
    },
    body: bodyText,
  });

  const body = await r.text();
  return new NextResponse(body, { status: r.status, headers: r.headers });
}

export async function GET() {
  return new NextResponse(null, { status: 204 });
}

export async function POST(req: NextRequest, ctx: any) {
  const token = tokenFromSlug(ctx?.params?.slug);
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing_token" }, { status: 400 });
  }
  return forwardPOST(req, token);
}
