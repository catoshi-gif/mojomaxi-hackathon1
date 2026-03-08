// filepath: src/app/_components/PwaBootstrap.tsx
"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    __mmPwaStandalone?: boolean;
  }
}

type IdleCapableWindow = Window & {
  requestIdleCallback?: (cb: IdleRequestCallback) => number;
};

function detectInAppDappBrowser(): boolean {
  try {
    const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "") || "";
    const uaL = ua.toLowerCase();

    const isJupiter = /jupiter/i.test(ua);
    const isAndroidWebView = /android/.test(uaL) && /; wv\)/.test(uaL);
    const isIOS = /iphone|ipad|ipod/i.test(ua);

    let forceSw = false;
    try {
      forceSw =
        typeof window !== "undefined" &&
        localStorage.getItem("mm_force_sw") === "1";
    } catch {}

    if (forceSw) return false;
    if (isJupiter) return true;
    if (isAndroidWebView) return true;
    if (isIOS) return false;

    return false;
  } catch {
    return false;
  }
}

function detectStandaloneMode(): boolean {
  try {
    if (typeof window === "undefined") return false;

    const mediaStandalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      window.matchMedia?.("(display-mode: fullscreen)")?.matches ||
      window.matchMedia?.("(display-mode: minimal-ui)")?.matches ||
      false;

    const iosStandalone =
      typeof navigator !== "undefined" &&
      "standalone" in navigator &&
      !!(navigator as Navigator & { standalone?: boolean }).standalone;

    return mediaStandalone || iosStandalone;
  } catch {
    return false;
  }
}

export default function PwaBootstrap() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    window.__mmPwaStandalone = detectStandaloneMode();

    if (!("serviceWorker" in navigator)) return;

    const isInApp = detectInAppDappBrowser();

    if (isInApp) {
      void (async () => {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) {
            try {
              await r.unregister();
            } catch {}
          }
        } catch {}
      })();
      return;
    }

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        reg.update().catch(() => {});
      } catch {
        // Never let SW registration break the app.
      }
    };

    const onPageReady = () => {
      const win = window as IdleCapableWindow;

      if (typeof win.requestIdleCallback === "function") {
        win.requestIdleCallback(() => {
          void register();
        });
      } else {
        setTimeout(() => {
          void register();
        }, 1);
      }
    };

    if (document.readyState === "complete") {
      onPageReady();
    } else {
      window.addEventListener("load", onPageReady, { once: true });
    }

    return () => {
      window.removeEventListener("load", onPageReady);
    };
  }, []);

  return null;
}
