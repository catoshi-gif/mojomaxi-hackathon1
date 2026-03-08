// filepath: src/app/api/turnstile/verify/route.ts
import { NextResponse } from "next/server";

/**
 * POST /api/turnstile/verify
 * Body: { token: string }
 * 
 * Verifies a Cloudflare Turnstile token server-side.
 * Requires env var: TURNSTILE_SECRET_KEY
 */
export async function POST(req: Request) {
  try {
    const { token } = await req.json().catch(() => ({ token: "" }));
    if (!token || typeof token !== "string") {
      return NextResponse.json({ success: false, error: "missing token" }, { status: 400 });
    }
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
      return NextResponse.json({ success: false, error: "TURNSTILE_SECRET_KEY not set" }, { status: 500 });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

    const form = new URLSearchParams();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);

    const cfRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });

    const data = await cfRes.json().catch(() => ({}));
    const success = !!data?.success;

    return NextResponse.json({ success, data });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || "unknown error" }, { status: 500 });
  }
}
