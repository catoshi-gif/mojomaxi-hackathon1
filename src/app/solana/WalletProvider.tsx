// filepath: src/app/solana/WalletProvider.tsx
"use client";

import React, { useEffect, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as AdapterWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  LedgerWalletAdapter,
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";
import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
} from "@solana-mobile/wallet-adapter-mobile";

// NEW (recommended by Solana Mobile for mobile web):
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  registerMwa,
} from "@solana-mobile/wallet-standard-mobile";

/**
 * Wallet provider for Mojomaxi.
 *
 * Key goal (Seeker / Android Chrome / installed PWA):
 * - ONLY show "Mobile Wallet Adapter" in the wallet selection modal.
 * - Phantom/Solflare desktop adapters can show up in the modal and then route users
 *   to web pages on Android Chrome, which feels broken/confusing.
 *
 * Why registerMwa?
 * - Solana Mobile now recommends using Mobile Wallet Standard to register MWA for web apps.
 * - This can improve compatibility on Android Chrome/PWA in some edge cases.
 * - IMPORTANT: must be invoked client-side (non-SSR). This file is already "use client".
 *
 * Note:
 * - We keep the legacy SolanaMobileWalletAdapter as a fallback adapter for wallet-adapter UI.
 *   registerMwa() registers a Wallet Standard wallet; some stacks auto-surface it.
 */
const DEFAULT_RPC =
  (process.env.NEXT_PUBLIC_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL.trim()) ||
  (process.env.NEXT_PUBLIC_SOLANA_RPC_URL && process.env.NEXT_PUBLIC_SOLANA_RPC_URL.trim()) ||
  clusterApiUrl("mainnet-beta");

const APP_NAME = "mojomaxi";
const APP_ICON_PATH = "/icon-192.png";

function getAppIdentity(): { name: string; uri: string; icon: string } {
  const envUrl = (process.env.NEXT_PUBLIC_SITE_URL || "").trim();
  const uri =
    envUrl ||
    (typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://www.mojomaxi.com");

  // `icon` should be a *relative* path that resolves against `uri`.
  return { name: APP_NAME, uri, icon: APP_ICON_PATH };
}

function openMwaWalletList(): void {
  try {
    window.location.href = "https://wallets.solanamobile.com/";
  } catch {
    // no-op
  }
}

/**
 * Detect native Android Chrome or installed PWA mode.
 * We intentionally exclude in-app dapp browsers / WebViews (Jupiter, etc).
 */
function isAndroidChromeOrPwaStandalone(): boolean {
  try {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const uaL = ua.toLowerCase();

    const isAndroid = uaL.includes("android");
    if (!isAndroid) return false;

    // WebViews commonly include "; wv)".
    const isWebView =
      uaL.includes("; wv)") ||
      (uaL.includes("version/") && uaL.includes("chrome") && uaL.includes("wv"));

    // Jupiter dapp browser etc.
    const isJupiter = /jupiter/i.test(ua);

    if (isWebView) return false;
    if (isJupiter) return false;

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

declare global {
  interface Window {
    __mmMwaRegistered?: boolean;
  }
}

export default function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => DEFAULT_RPC, []);

  // Register Mobile Wallet Standard (MWA) wallet option (Android Chrome/PWA only).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isAndroidChromeOrPwaStandalone()) return;

    // Avoid double-registering in React strict mode / HMR.
    if (window.__mmMwaRegistered) return;
    window.__mmMwaRegistered = true;

    try {
      registerMwa({
        appIdentity: getAppIdentity(),
        authorizationCache: createDefaultAuthorizationCache(),
        chains: ["solana:mainnet", "solana:devnet"],
        chainSelector: createDefaultChainSelector(),
        onWalletNotFound: async (...args: unknown[]) => {
          try {
            alert(
              "No Mobile Wallet Adapter-compatible wallet was found. Install Phantom, Solflare, Backpack, or another MWA wallet, then try again."
            );
          } catch {}

          // TypeScript in Next build is strict about spreading unknown[] into a non-rest function.
          // The default handler expects the mobile wallet adapter instance as the first argument.
          try {
            const handler = createDefaultWalletNotFoundHandler();
            const arg0 = (args as any[])?.[0];
            await (handler as any)(arg0);
          } catch {
            openMwaWalletList();
          }
        },
      });
    } catch (e) {
      console.warn("[WalletProvider] registerMwa failed:", e);
    }
  }, []);

  const wallets = useMemo(() => {
    const mobile = new SolanaMobileWalletAdapter({
      addressSelector: createDefaultAddressSelector(),
      appIdentity: getAppIdentity(),
      authorizationResultCache: createDefaultAuthorizationResultCache(),
      cluster: WalletAdapterNetwork.Mainnet,

      // IMPORTANT: onWalletNotFound must be async and return Promise<void>.
      onWalletNotFound: async () => {
        try {
          alert(
            "No Mobile Wallet Adapter-compatible wallet was found. Install Phantom, Solflare, Backpack, or another MWA wallet, then try again."
          );
        } catch {}
        openMwaWalletList();
      },
    });

    // Seeker / Android Chrome / PWA: ONLY show MWA in the modal.
    if (isAndroidChromeOrPwaStandalone()) {
      return [mobile];
    }

    // Default (desktop, iOS, in-app dapp browsers, etc.)
    return [
      mobile,
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter({ network: WalletAdapterNetwork.Mainnet }),
      new LedgerWalletAdapter(),
    ];
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <AdapterWalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </AdapterWalletProvider>
    </ConnectionProvider>
  );
}
