// filepath: src/components/security/HumanCheckGate.tsx
"use client";

import * as React from "react";

/**
 * HumanCheckGate
 * --------------
 * - Default: Renders Turnstile in *invisible* mode and verifies via /api/turnstile/verify.
 * - On iOS/Safari or transient failures: soft-retry and then fall back to *visible* mode (user tap).
 * - Never throws during resume; all errors are handled with retry / visible fallback.
 * - TTL stored in localStorage key "mm_turnstile_ok_ts"; when valid, gate short-circuits and calls onPassed.
 *
 * ✨ Requested UX tweak:
 *   The Turnstile widget now sits on its own line **below** the status text so the text never gets squished.
 *   We also prevent vertical single-character wraps on small screens.
 */

type Props = {
  /** Preferred callback: fired once human verification succeeds. */
  onPassed?: (ttlMs?: number) => void;
  /** Back-compat: some callers still pass `onVerified`; treated the same as `onPassed`. */
  onVerified?: (ttlMs?: number) => void;

  /** Optional Turnstile site key; defaults to NEXT_PUBLIC_TURNSTILE_SITE_KEY */
  siteKey?: string;
  /** Suggest a TTL (ms) for the caller to cache the OK flag (defaults 6h). */
  ttlMs?: number;
  /** Optional wrapper className for the gate card. */
  className?: string;
  /** Force the fallback visible widget immediately (used during manual testing) */
  forceVisible?: boolean;
};

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: any) => any;
      reset: (id: any) => void;
      remove: (id: any) => void;
    };
  }
}

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6;
const LS_KEY = "mm_turnstile_ok_ts";

export default function HumanCheckGate({
  onPassed,
  onVerified,
  siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY as string,
  ttlMs = DEFAULT_TTL_MS,
  className,
  forceVisible = false,
}: Props) {
  // Helpers
  const _onPassed = React.useCallback(
    (ms?: number) => {
      try {
        (onPassed || onVerified)?.(ms);
      } catch {}
    },
    [onPassed, onVerified]
  );

  // Internal state
  const [status, setStatus] = React.useState<"idle" | "loading" | "verifying" | "ok" | "error">("idle");
  const [visibleMode, setVisibleMode] = React.useState<boolean>(!!forceVisible);
  const [message, setMessage] = React.useState<string>("Checking you’re human…");

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const widgetIdRef = React.useRef<any>(null);
  const retriesRef = React.useRef<number>(0);
  const destroyedRef = React.useRef<boolean>(false);

  // Short-circuit if TTL OK
  React.useEffect(() => {
    try {
      const ts = Number(localStorage.getItem(LS_KEY) || "0");
      if (ts > Date.now()) {
        setStatus("ok");
        _onPassed(ttlMs);
        return;
      }
    } catch {}
  }, [_onPassed, ttlMs]);

  // Visibility helper
  const whenVisible = React.useCallback(async () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") return;
    await new Promise<void>((resolve) => {
      const onVis = () => {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", onVis);
          resolve();
        }
      };
      document.addEventListener("visibilitychange", onVis, { once: true });
    });
  }, []);

  // Ensure CF script present
  const ensureScript = React.useCallback(async (): Promise<void> => {
    if (destroyedRef.current) return;
    if (typeof window === "undefined") return;
    if (window.turnstile) return;

    const EXISTING_ID = "cf-turnstile-script";
    const src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

    if (!document.getElementById(EXISTING_ID)) {
      const s = document.createElement("script");
      s.id = EXISTING_ID;
      s.src = src;
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }

    // Wait up to ~5s for window.turnstile
    const started = Date.now();
    while (!window.turnstile && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }, []);

  // Common error path: soft retries → visible fallback → error status with manual retry
  const onChallengeError = React.useCallback((err?: Error) => {
    if (destroyedRef.current) return;
    retriesRef.current += 1;

    if (retriesRef.current <= 2) {
      // Soft retry quickly
      const backoff = 300 * retriesRef.current;
      setMessage("Checking again…");
      setTimeout(() => {
        if (!destroyedRef.current) renderWidget();
      }, backoff);
      return;
    }

    // Fallback to visible (user tap) after a couple attempts
    setVisibleMode(true);
    setStatus("error");
    setMessage("We couldn’t verify you. Tap to retry.");
    // Immediately re-render in visible mode so the widget is present for user
    setTimeout(() => { if (!destroyedRef.current) renderWidget(); }, 0);
  }, []);

  // Verify with our API
  const verifyToken = React.useCallback(async (token: string) => {
    if (destroyedRef.current) return;
    setStatus("verifying");
    setMessage("Verifying…");
    try {
      const res = await fetch("/api/turnstile/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error("verify-http-" + res.status);
      const data = await res.json();
      if (data?.success) {
        setStatus("ok");
        try {
          localStorage.setItem(LS_KEY, String(Date.now() + ttlMs));
        } catch {}
        _onPassed(ttlMs);
      } else {
        throw new Error("verify-failed");
      }
    } catch (e: any) {
      console.warn("[HumanCheckGate] verify error:", e?.message || e);
      onChallengeError(e instanceof Error ? e : new Error("verify-error"));
    }
  }, [_onPassed, onChallengeError, ttlMs]);

  // Render or reset the widget
  const renderWidget = React.useCallback(async () => {
    if (destroyedRef.current) return;
    await whenVisible();
    if (destroyedRef.current) return;

    setStatus("loading");
    setMessage(visibleMode ? "Loading challenge…" : "Preparing human check…");

    await ensureScript();

    if (destroyedRef.current) return;

    if (!window.turnstile) {
      // Script not ready yet — retry soon, but *never* throw
      return void setTimeout(() => {
        if (!destroyedRef.current) renderWidget();
      }, 800);
    }

    const el = containerRef.current;
    if (!el) return;

    try {
      // If already rendered once, reset it rather than re-render
      if (widgetIdRef.current) {
        try { window.turnstile!.remove(widgetIdRef.current); } catch {}
        widgetIdRef.current = null;
      }

      widgetIdRef.current = window.turnstile!.render(el, {
        sitekey: siteKey,
        theme: "auto",
        size: visibleMode ? "normal" : "invisible",
        retry: "auto",
        "retry-interval": 800,
        callback: (token: string) => verifyToken(token),
        "error-callback": () => onChallengeError(new Error("challenge-error")),
        "timeout-callback": () => onChallengeError(new Error("challenge-timeout")),
        "expired-callback": () => onChallengeError(new Error("challenge-expired")),
      });

      // If invisible, immediately execute; visible waits for user tap
      if (!visibleMode) {
        // Turnstile executes automatically in invisible mode after render.
        setMessage("Checking you’re human…");
      } else {
        setMessage("Please verify to continue.");
      }
    } catch (e: any) {
      console.warn("[HumanCheckGate] render error:", e?.message || e);
      onChallengeError(e instanceof Error ? e : new Error("render-error"));
    }
  }, [ensureScript, onChallengeError, siteKey, verifyToken, visibleMode, whenVisible]);

  React.useEffect(() => {
    renderWidget();
    return () => {
      destroyedRef.current = true;
      try {
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetry = React.useCallback(() => {
    retriesRef.current = 0;
    setStatus("idle");
    // Preserve whatever visible mode we're in; if error happened we likely switched to visible
    setMessage("Checking you’re human…");
    renderWidget();
  }, [renderWidget]);

  return (
    <div className={className}>
      <div className="mx-auto max-w-sm rounded-2xl border border-white/10 bg-zinc-900/60 p-4 text-sm text-white/80 shadow-lg backdrop-blur">
        {/* Responsive layout: stack on mobile, side-by-side on larger screens */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
          <div className="whitespace-normal break-words leading-snug">{message}</div>
          {status === "error" && (
            <button
              onClick={handleRetry}
              className="mt-2 inline-flex rounded-xl border border-white/10 px-3 py-1 text-xs hover:bg-white/5"
            >
              Retry
            </button>
          )}
        </div>

          {/* On mobile this drops below the text; on >=sm it sits to the right */}
          <div className="mt-2 sm:mt-0 sm:ml-3">
            <div
              ref={containerRef}
              className={visibleMode ? "block w-full max-w-[360px]" : "inline-block h-[40px] w-[80px] opacity-0"}
              aria-hidden={status === "ok" ? "true" : "false"}
            />
          </div>
        </div>

        <div className="mt-2 text-[10px] text-white/40">
          {visibleMode
            ? "Using Cloudflare Turnstile"
            : "Auto check enabled — no action usually required"}
        </div>
      </div>
    </div>
  );
}
