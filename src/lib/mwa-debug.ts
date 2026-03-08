"use client";

import { SolanaMobileWalletAdapterWalletName } from "@solana-mobile/wallet-adapter-mobile";

export type MwaDebugEvent = {
  ts: number;
  event: string;
  detail?: Record<string, unknown>;
};

declare global {
  interface Window {
    __mmMwaDebugInstalled?: boolean;
    __mmMwaDebugLog?: MwaDebugEvent[];
    __mmMwaLastError?: string;
    __mmMwaLastLocalWsUrl?: string;
    __mmMwaLastConnectStartAt?: number;
    __mmMwaLastConnectSource?: string;
  }
}

function now() {
  return Date.now();
}

export function isAndroidChromeOrPwaStandalone(): boolean {
  try {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const uaL = ua.toLowerCase();
    const isAndroid = uaL.includes("android");
    if (!isAndroid) return false;
    const isWebView =
      uaL.includes("; wv)") ||
      (uaL.includes("version/") && uaL.includes("chrome") && uaL.includes("wv"));
    const isJupiter = /jupiter/i.test(ua);
    if (isWebView || isJupiter) return false;
    const isChromeLike =
      uaL.includes("chrome/") && !uaL.includes("edg/") && !uaL.includes("opr/");
    const isStandalone =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      (window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches ||
        window.matchMedia("(display-mode: minimal-ui)").matches);
    return Boolean(isStandalone || isChromeLike);
  } catch {
    return false;
  }
}

/**
 * Returns true ONLY if running as an installed PWA (standalone/fullscreen/minimal-ui).
 * This is distinct from isAndroidChromeOrPwaStandalone() which also returns true
 * for regular Chrome tabs. We need this distinction because Chrome's WebAPK shell
 * silently blocks custom URI scheme navigation (solana-wallet://) — a known
 * Chromium bug (crbug.com/1088090) that does NOT affect regular Chrome tabs.
 */
export function isPwaStandaloneMode(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches
    );
  } catch {
    return false;
  }
}

export function mwaLog(event: string, detail?: Record<string, unknown>) {
  try {
    if (typeof window === "undefined") return;
    const row: MwaDebugEvent = { ts: now(), event, detail };
    const buf = (window.__mmMwaDebugLog ||= []);
    buf.push(row);
    if (buf.length > 300) buf.splice(0, buf.length - 300);
    try {
      const json = JSON.stringify(buf.slice(-80));
      window.sessionStorage?.setItem("mm_mwa_debug_log", json);
    } catch {}
    try {
      console.info(`[MWA] ${event}`, detail || {});
    } catch {}
  } catch {}
}

export const MWA_WALLET_NAME_FALLBACK = "Mobile Wallet Adapter";

export function resetMwaDebugState() {
  try {
    if (typeof window === "undefined") return;
    window.__mmMwaLastError = undefined;
    window.__mmMwaLastLocalWsUrl = undefined;
    window.__mmMwaLastConnectStartAt = undefined;
    window.__mmMwaLastConnectSource = undefined;
  } catch {}
}

export function isNamedMwaWallet(name: unknown): boolean {
  const value = String(name || "").trim().toLowerCase();
  const exact = String(
    (SolanaMobileWalletAdapterWalletName as unknown as string) || MWA_WALLET_NAME_FALLBACK
  )
    .trim()
    .toLowerCase();
  return (
    value === exact ||
    value === "mobile wallet adapter" ||
    value.includes("mobile wallet adapter") ||
    value.includes("solana mobile")
  );
}

export function getMwaWalletEntry(wallets: unknown): { name: string; adapter: any; readyState?: unknown } | null {
  try {
    if (!Array.isArray(wallets)) return null;
    const hit = wallets.find((w: any) => {
      const n = String(w?.adapter?.name || w?.name || "");
      return isNamedMwaWallet(n);
    }) as any;
    if (hit?.adapter?.name) {
      return {
        name: String(hit.adapter.name),
        adapter: hit.adapter,
        readyState: hit?.readyState ?? hit?.adapter?.readyState,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function getWalletAdapterName(walletLike: unknown): string {
  try {
    const adapter = (walletLike as any)?.wallet?.adapter || (walletLike as any)?.adapter || walletLike;
    return String(adapter?.name || "");
  } catch {
    return "";
  }
}

export function isUsingMwaWallet(walletLike: unknown): boolean {
  return isNamedMwaWallet(getWalletAdapterName(walletLike));
}

export function installMwaDebugHooks() {
  try {
    if (typeof window === "undefined") return;
    if (window.__mmMwaDebugInstalled) return;
    window.__mmMwaDebugInstalled = true;

    mwaLog("debug_hooks_install", {
      ua: navigator.userAgent,
      href: window.location.href,
      hidden: document.hidden,
      androidChromePwa: isAndroidChromeOrPwaStandalone(),
    });

    const onVisibility = () => mwaLog("visibilitychange", { hidden: document.hidden });
    const onPageShow = (ev: PageTransitionEvent) => mwaLog("pageshow", { persisted: ev?.persisted });
    const onPageHide = () => mwaLog("pagehide", { hidden: document.hidden });
    const onFocus = () => mwaLog("focus", { hidden: document.hidden });
    const onBlur = () => mwaLog("blur", { hidden: document.hidden });
    document.addEventListener("visibilitychange", onVisibility as any);
    window.addEventListener("pageshow", onPageShow as any);
    window.addEventListener("pagehide", onPageHide as any);
    window.addEventListener("focus", onFocus as any);
    window.addEventListener("blur", onBlur as any);

    window.addEventListener("error", (ev) => {
      const msg = String((ev as ErrorEvent)?.message || "");
      if (/localhost:\d+\/solana-wallet/i.test(msg) || /mobile wallet adapter/i.test(msg)) {
        window.__mmMwaLastError = msg;
        mwaLog("window_error", {
          message: msg,
          filename: (ev as ErrorEvent)?.filename,
          lineno: (ev as ErrorEvent)?.lineno,
        });
      }
    });

    window.addEventListener("unhandledrejection", (ev) => {
      const reason = (ev as PromiseRejectionEvent)?.reason;
      const msg = String((reason && (reason.message || reason)) || "");
      if (/localhost:\d+\/solana-wallet/i.test(msg) || /mobile wallet adapter/i.test(msg)) {
        window.__mmMwaLastError = msg;
        mwaLog("unhandledrejection", { message: msg });
      }
    });

    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket === "function") {
      class LoggedWebSocket extends NativeWebSocket {
        __mmUrl: string;
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url as any, protocols as any);
          this.__mmUrl = String(url);
          if (/^ws:\/\/localhost:\d+\/solana-wallet/i.test(this.__mmUrl)) {
            window.__mmMwaLastLocalWsUrl = this.__mmUrl;
            mwaLog("local_ws_open_attempt", { url: this.__mmUrl });
            this.addEventListener("open", () => mwaLog("local_ws_open", { url: this.__mmUrl }));
            this.addEventListener("error", () =>
              mwaLog("local_ws_error", { url: this.__mmUrl, readyState: this.readyState })
            );
            this.addEventListener("close", (ev) =>
              mwaLog("local_ws_close", {
                url: this.__mmUrl,
                code: ev.code,
                reason: ev.reason,
                wasClean: ev.wasClean,
              })
            );
          }
        }
      }
      (window as any).WebSocket = LoggedWebSocket as any;
    }
  } catch {}
}
