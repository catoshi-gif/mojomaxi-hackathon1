// filepath: src/app/api/help/contact/route.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minimal email sender with zero new dependencies.
 * Supports:
 *  - RESEND (preferred): set RESEND_API_KEY
 *  - SENDGRID: set SENDGRID_API_KEY
 * Env (optional):
 *  - HELP_CONTACT_EMAIL_TO (default: "yomojomaxi@gmail.com")
 *  - HELP_CONTACT_FROM (default for Resend: "onboarding@resend.dev")
 */

type AnyObj = Record<string, any>;

function json(status: number, body: AnyObj) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sanitize(s: any, max = 2000): string {
  const t = String(s == null ? "" : s);
  return t.replace(/\u0000/g, "").slice(0, max);
}

function inferSiteOrigin(req: NextRequest): string | null {
  const host = (req.headers.get("host") || "").trim();
  if (!host) return null;
  const proto = (req.headers.get("x-forwarded-proto") || "https").split(",")[0].trim() || "https";
  return `${proto}://${host}`;
}

function getAllowedOrigin(req: NextRequest): string | null {
  const origin = (req.headers.get("origin") || "").trim();
  if (!origin) return null;

  // Allow same-origin
  const self = inferSiteOrigin(req);
  try {
    const o = new URL(origin);
    if (self) {
      const s = new URL(self);
      if (o.host === s.host) return origin;
    }

    // Allow configured site URL (useful for www/non-www + preview domains)
    const site =
      (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || process.env.MM_SITE_URL || "").trim();
    if (site) {
      const su = new URL(site);
      if (o.host === su.host) return origin;
    }
  } catch {
    // ignore invalid origin
  }
  return null;
}

function getClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  if (first) return first;
  const xrip = req.headers.get("x-real-ip");
  return xrip ? xrip.trim() : null;
}

function hasInternalBypass(req: Request): boolean {
  // Mirrors the "internal token" pattern used elsewhere (rpc + rebalance routes).
  const keys = [
    "X_MM_INTERNAL_TOKEN",
    "MM_INTERNAL_TOKEN",
    "MOJOMAXI_INTERNAL_TOKEN",
    "INTERNAL_SHARED_SECRET",
    "INTERNAL_GATEWAY_SECRET",
    "INTERNAL_FETCH_TOKEN",
  ] as const;

  let expected = "";
  for (const k of keys) {
    const v = (process.env as any)?.[k];
    if (typeof v === "string" && v.trim()) { expected = v.trim(); break; }
  }
  if (!expected) return false;

  const auth = (req.headers.get("authorization") || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerToken = (req.headers.get("x-mm-internal-token") || "").trim();

  return (bearer && bearer === expected) || (headerToken && headerToken === expected);
}

function isEmail(s: string): boolean {
  // intentionally simple (we only need to reject obvious garbage)
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

async function sendViaResend(params: {
  to: string;
  from?: string;
  subject: string;
  text: string;
  html: string;
}): Promise<Response> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY missing");
  const from = params.from || process.env.HELP_CONTACT_FROM || "onboarding@resend.dev";
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: params.to, subject: params.subject, text: params.text, html: params.html }),
  });
}

async function sendViaSendgrid(params: {
  to: string;
  from?: string;
  subject: string;
  text: string;
  html: string;
}): Promise<Response> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error("SENDGRID_API_KEY missing");
  const from = params.from || process.env.HELP_CONTACT_FROM || "no-reply@mojomaxi.com";
  return fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: params.to }] }],
      from: { email: from },
      subject: params.subject,
      content: [{ type: "text/plain", value: params.text }, { type: "text/html", value: params.html }],
    }),
  });
}

export async function OPTIONS(req: NextRequest) {
  const origin = getAllowedOrigin(req);
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin || "null",
      "vary": "origin",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const j = (await req.json().catch(() => ({}))) as AnyObj;

    // Basic origin check: this endpoint is intended to be called by the Mojomaxi UI.
    // (Still allows the request when no Origin header is present, e.g. curl.)
    const allowedOrigin = getAllowedOrigin(req);
    const originHeader = (req.headers.get("origin") || "").trim();
    if (originHeader && !allowedOrigin) {
      return json(403, { ok: false, error: "forbidden" });
    }

    // Rate limit (fail-open if Redis is unavailable)
    if (!hasInternalBypass(req)) {
      try {
        const windowSec = 60;
        const limit = Number(process.env.MM_CONTACT_LIMIT_PER_MIN || 20);
        const ip = getClientIp(req) || "unknown";
        const slot = Math.floor(Date.now() / 1000 / windowSec);
        const key = `mm:ratelimit:contact:${ip}:${slot}`;
        const n = await (redis as any).incr(key);
        if (n === 1) await (redis as any).expire(key, windowSec);
        if (n > limit) {
          return new NextResponse(JSON.stringify({ ok: false, error: "rate_limited" }), {
            status: 429,
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          });
        }
      } catch {
        // ignore
      }
    }

    const name = sanitize(j.name, 100);
    const email = sanitize(j.email, 200);
    const topic = sanitize(j.topic, 200);
    const wallet = sanitize(j.wallet, 256); // case sensitive
    const setId = sanitize(j.setId, 256);
    const message = sanitize(j.message, 5000);

    // Honeypot for basic spam bots (UI does not send this field).
    const hp = sanitize((j as any).company, 200);
    if (hp) return json(200, { ok: true });

    if (email && !isEmail(email)) {
      return json(400, { ok: false, error: "invalid_email" });
    }
    if (!message || message.trim().length < 5) {
      return json(400, { ok: false, error: "missing_message" });
    }

    if (!message || message.length < 5) {
      return json(400, { ok: false, error: "bad_request", detail: "message is required" });
    }

    const to = process.env.HELP_CONTACT_EMAIL_TO || "yomojomaxi@gmail.com";
    const subject = `[mojomaxi help] ${topic || "New message"}`;
    const text =
`Name:   ${name || "-"}
Email:  ${email || "-"}
Wallet: ${wallet || "-"}
Set ID: ${setId || "-"}

Message:
${message}`;
    const html =
`<div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.4">
  <h2 style="margin:0 0 12px 0">mojomaxi • help message</h2>
  <table style="border-collapse:collapse;width:100%;max-width:640px">
    <tr><td style="padding:4px 0;color:#999">Name</td><td>${name || "-"}</td></tr>
    <tr><td style="padding:4px 0;color:#999">Email</td><td>${email || "-"}</td></tr>
    <tr><td style="padding:4px 0;color:#999">Wallet</td><td style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">${wallet || "-"}</td></tr>
    <tr><td style="padding:4px 0;color:#999">Set ID</td><td style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">${setId || "-"}</td></tr>
  </table>
  <div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee; white-space:pre-wrap">${(message || "").replace(/[<>]/g, (m)=> m === "<" ? "&lt;" : "&gt;")}</div>
</div>`;

    // Try providers in order: Resend → Sendgrid → fail with helpful message
    let sent = false;
    let lastErr: any = null;

    const tryResend = async () => {
      if (process.env.RESEND_API_KEY) {
        const r = await sendViaResend({ to, subject, text, html });
        if (r.ok) return true;
        lastErr = await r.text().catch(() => r.statusText);
        return false;
      }
      return false;
    };

    const trySendgrid = async () => {
      if (process.env.SENDGRID_API_KEY) {
        const r = await sendViaSendgrid({ to, subject, text, html });
        if (r.ok) return true;
        lastErr = await r.text().catch(() => r.statusText);
        return false;
      }
      return false;
    };

    if (!sent) sent = await tryResend();
    if (!sent) sent = await trySendgrid();

    if (!sent) {
      return json(501, { ok: false, error: "not_configured", detail: "No email provider configured (RESEND_API_KEY or SENDGRID_API_KEY)." });
    }

    return json(200, { ok: true });
  } catch (e: any) {
    return json(500, { ok: false, error: "server_error", detail: String(e?.message || e) });
  }
}
