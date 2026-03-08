// src/instrumentation.ts
// Registers once at boot. Server-only safe. No UI/UX changes.
// Adds 'x-mm-internal: 1' and optional 'x-mm-internal-token' to a narrow set of internal /api/* fetches.

import "@/lib/env.server";
import { getAllowedInternalHosts, getInternalSecret } from "@/lib/auth/internal";
import { logApiEvent } from "@/lib/observability";

export async function register() {
  try {
    const g: any = globalThis as any;
    if (g.__mmFetchPatched) return;
    const patchEnabled = String(process.env.MM_PATCH_INTERNAL_FETCH || "1").trim() !== "0";
    if (!patchEnabled) {
      logApiEvent("info", "instrumentation.fetch_patch_skipped", { reason: "env_disabled" });
      return;
    }

    g.__mmFetchPatched = true;
    const origFetch = g.fetch?.bind(globalThis) || fetch;

    function shouldPatchPath(pathname: string): boolean {
      if (!pathname) return false;
      const p = pathname.toLowerCase();
      const prefixes = [
        "/api/events/append",
        "/api/events/recent",
        "/api/rebalance/",
        "/api/vault/equity",
        "/api/vaults/execute-swap",
        "/api/share/resolve-set",
        "/api/cron",
      ];
      return prefixes.some((prefix) => p === prefix || p.startsWith(prefix));
    }

    g.fetch = async (input: any, init?: RequestInit) => {
      let urlStr = "";
      try {
        if (typeof input === "string") urlStr = input;
        else if (input instanceof URL) urlStr = input.toString();
        else if (typeof Request !== "undefined" && input instanceof Request) urlStr = input.url || "";
        else urlStr = String(input || "");
      } catch { urlStr = String(input || ""); }

      let isInternalApi = false;
      try {
        if (urlStr.startsWith("/api/")) {
          isInternalApi = shouldPatchPath(urlStr);
        } else if (urlStr.startsWith("http")) {
          const url = new URL(urlStr);
          const host = url.host.toLowerCase();
          const allowed = new Set(getAllowedInternalHosts());
          const hostIsOurs = allowed.has(host);
          if (hostIsOurs && url.pathname.startsWith("/api/")) {
            isInternalApi = shouldPatchPath(url.pathname);
          }
        }
      } catch {}

      if (isInternalApi) {
        const headers = new Headers(
          (init && (init as any).headers) ||
          ((typeof Request !== "undefined" && input instanceof Request) ? (input as Request).headers : undefined) ||
          {}
        );

        if (!headers.has("x-mm-internal")) headers.set("x-mm-internal", "1");
        const token = getInternalSecret();
        if (token && !headers.has("x-mm-internal-token")) headers.set("x-mm-internal-token", token);

        const nextInit: RequestInit = { ...(init || {}), headers };
        if (typeof Request !== "undefined" && input instanceof Request) {
          input = new Request(input, nextInit);
          return origFetch(input);
        }
        return origFetch(input, nextInit);
      }

      return origFetch(input, init);
    };

    logApiEvent("info", "instrumentation.fetch_patch_enabled", {
      allowedHosts: getAllowedInternalHosts(),
      mode: "narrow_internal_api_prefixes",
    });
  } catch {
    // never break the app if anything goes wrong patching
  }
}
