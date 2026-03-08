"use client";

import React, { useEffect, useRef, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { initWalletSession } from "@/lib/auth/initWalletSession";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

import { SolanaMobileWalletAdapter } from "@solana-mobile/wallet-adapter-mobile";

declare global {
  interface Window {
    __mmOpenSubscribeModal?: (opts?: { strategyId?: string }) => void;
    __mmDeferWalletSession?: boolean;
  }
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

// --- Jupiter desktop compatibility helper: sendTransaction -> signTransaction fallback ---
async function _mmSendWithJupiterFallback(
  sendFn: ((tx: any, conn: any, opts?: any) => Promise<string>) | undefined,
  signFn: ((tx: any) => Promise<any>) | undefined,
  tx: any,
  conn: any,
  opts?: any
): Promise<string> {
  if (typeof sendFn === "function") {
    try {
      return await sendFn(tx, conn, opts);
    } catch (e: any) {
      const msg = (e && (e.message || String(e))) || "";
      if (
        typeof signFn === "function" &&
        typeof msg === "string" &&
        msg.toUpperCase().includes("NOT IMPLEMENTED YET")
      ) {
        const signed = await signFn(tx);
        return await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      }
      throw e;
    }
  }
  if (typeof signFn === "function") {
    const signed = await signFn(tx);
    return await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  }
  throw new Error("Wallet adapter missing sendTransaction/signTransaction.");
}

// Helper: attempt to close (unwrap) the user's WSOL ATA into native SOL.
async function tryCloseUserWsolAta(conn: any, ownerPk: PublicKey, wallet: any): Promise<string | null> {
  try {
    const mintPk = new PublicKey(SOL_MINT);
    const userAta = getAssociatedTokenAddressSync(mintPk, ownerPk, false);
    try {
      const info = await conn.getAccountInfo(userAta, "processed");
      if (!info || String(info.owner) !== String(TOKEN_PROGRAM_ID)) {
        return null;
      }
    } catch {
      return null;
    }
    const tx = new Transaction();
    tx.add(createCloseAccountInstruction(userAta, ownerPk, ownerPk));
    let sig: string | null = null;
    if (wallet?.sendTransaction || wallet?.signTransaction) {
      sig = await _mmSendWithJupiterFallback(
        (wallet as any)?.sendTransaction as any,
        (wallet as any)?.signTransaction as any,
        tx,
        conn,
        { skipPreflight: false }
      );
    }
    if (sig) {
      void conn.confirmTransaction(sig, "confirmed").catch(() => {});
      return sig;
    }
    return null;
  } catch {
    return null;
  }
}

function isAndroidChromeOrPwaStandalone(): boolean {
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

function isUsingMwa(wallet: WalletContextState): boolean {
  try {
    const adapter = (wallet as any)?.wallet?.adapter;
    if (!adapter) return false;

    if (adapter instanceof SolanaMobileWalletAdapter) return true;

    const n = String(adapter?.name || "").toLowerCase();
    if (n.includes("mobile wallet adapter")) return true;

    return false;
  } catch {
    return false;
  }
}

function findMwaWalletName(wallet: WalletContextState): WalletName | null {
  try {
    const list = (wallet as any)?.wallets as Array<{ adapter: any }>;
    if (!Array.isArray(list)) return null;

    const hit = list.find((w) => w?.adapter instanceof SolanaMobileWalletAdapter);
    if (hit?.adapter?.name) return hit.adapter.name as WalletName;

    const hit2 = list.find((w) => {
      const n = String(w?.adapter?.name || "").toLowerCase();
      return n.includes("solana mobile") || n.includes("mobile wallet");
    });
    if (hit2?.adapter?.name) return hit2.adapter.name as WalletName;

    return null;
  } catch {
    return null;
  }
}

function getHereUrl(): string {
  try {
    if (typeof window === "undefined") return "https://www.mojomaxi.com";
    return window.location.href;
  } catch {
    return "https://www.mojomaxi.com";
  }
}

function getRefUrl(): string {
  try {
    if (typeof window === "undefined") return "https://www.mojomaxi.com";
    return window.location.origin || "https://www.mojomaxi.com";
  } catch {
    return "https://www.mojomaxi.com";
  }
}

function buildPhantomBrowseLink(url: string, ref: string): string {
  // Phantom docs: https://phantom.app/ul/browse/<url>?ref=<ref>
  return `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
}

function buildSolflareBrowseLink(url: string, ref: string): string {
  // Solflare docs: https://solflare.com/ul/v1/browse/<url>?ref=<ref>
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
}

function buildBackpackBrowseLink(url: string, ref: string): string {
  // Backpack docs: https://backpack.app/ul/v1/browse/<url>?ref=<ref>
  return `https://backpack.app/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
}

/**
 * Why we need a fallback UI:
 * On some Android Chrome/PWA builds (including Seeker), the MWA intent handoff can be blocked
 * or silently fail (screen dims, no wallet UI).
 *
 * If MWA fails, the only reliable "get users unblocked today" path is to open the dApp inside
 * the wallet's in-app browser (Phantom/Solflare browse deeplink), where injected providers work.
 */
export default function ConnectWallet() {
  const wallet: WalletContextState = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal?.() || { setVisible: undefined };

  const [menuOpen, setMenuOpen] = useState(false);
  const [hasWsol, setHasWsol] = useState<boolean | null>(null);
  const [checkingWsol, setCheckingWsol] = useState(false);
  const [unwrapBusy, setUnwrapBusy] = useState(false);

  const [mwaTrouble, setMwaTrouble] = useState<{ open: boolean; msg?: string } | null>(null);

  const [mwaAttempting, setMwaAttempting] = useState(false);

  const connected = !!wallet?.connected;
  const providerIcon = (wallet?.wallet?.adapter as any)?.icon as string | undefined;

  const handleUnwrapWsol = React.useCallback(async () => {
    if (!wallet?.publicKey) return;
    try {
      setUnwrapBusy(true);
      const sig = await tryCloseUserWsolAta(connection, wallet.publicKey, wallet);
      if (sig) setHasWsol(false);
    } catch (e) {
      console.warn("[ConnectWallet] WSOL unwrap failed:", e);
    } finally {
      setUnwrapBusy(false);
      setMenuOpen(false);
    }
  }, [connection, wallet]);

  // Lightweight WSOL balance check when the wallet dropdown is open.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        if (!wallet?.publicKey || !wallet.connected || !menuOpen) {
          setHasWsol(null);
          return;
        }
        setCheckingWsol(true);
        const mintPk = new PublicKey(SOL_MINT);
        const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false);
        const bal = await connection.getTokenAccountBalance(ata, "processed").catch(() => null);
        if (cancelled) return;
        const ui =
          bal && typeof (bal as any).value?.uiAmount === "number"
            ? (bal as any).value.uiAmount
            : Number((bal as any)?.value?.uiAmount ?? 0);
        setHasWsol(Number.isFinite(ui) && ui > 0.000001);
      } catch {
        if (!cancelled) setHasWsol(false);
      } finally {
        if (!cancelled) setCheckingWsol(false);
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [wallet?.publicKey, wallet?.connected, menuOpen, connection]);

  // Establish ephemeral wallet session after connect — but DO NOT auto-sign immediately for MWA on Android Chrome/PWA.
  React.useEffect(() => {
    try {
      const defer = typeof window !== "undefined" && (window as any).__mmDeferWalletSession;
      if (defer) return;
      if (!wallet.connected || !wallet.publicKey) return;

      if (isAndroidChromeOrPwaStandalone() && isUsingMwa(wallet)) return;

      const addr = wallet.publicKey.toBase58();
      const canMsg = typeof wallet.signMessage === "function";
      const canTx = typeof wallet.signTransaction === "function";
      const preferTx = !canMsg && canTx;

      if (preferTx) {
        initWalletSession({
          wallet: addr,
          signTransaction: wallet.signTransaction!,
        });
      } else if (canMsg) {
        initWalletSession(addr, (msg) => wallet.signMessage!(msg));
      }
    } catch {}
  }, [wallet.connected, wallet.publicKey, wallet.signMessage, wallet.signTransaction]);

  const handleSubscribe = React.useCallback(() => {
    setMenuOpen(false);
    try {
      window.__mmOpenSubscribeModal?.();
    } catch {}
  }, []);

  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  async function connectMwaFromGesture(): Promise<boolean> {
    if (!isAndroidChromeOrPwaStandalone()) return false;
    if (wallet.connected) return true;

    const mwaName = findMwaWalletName(wallet);
    if (!mwaName) {
      setMwaTrouble({ open: true, msg: "Mobile Wallet Adapter is not available in this build." });
      return false;
    }

    try {
      // Keep the UI responsive: do NOT await connect() on Android Chrome/PWA.
      // Some Chromium builds can effectively "pause" JS while resolving the intent,
      // which would prevent Promise.race timeouts from firing.
      setMwaAttempting(true);

      // Close Wallet Adapter modal if it was open (prevents the dim overlay from trapping taps).
      try {
        if (typeof setVisible === "function") setVisible(false);
      } catch {}

      // Prevent wallet-session signing from firing during connect handoff.
      if (typeof window !== "undefined") (window as any).__mmDeferWalletSession = true;

      if (typeof wallet.select === "function") wallet.select(mwaName);

      // Must be called inside the click handler stack (trusted gesture).
      const p = wallet.connect();

      // If the connect resolves, release the deferred session handshake shortly after.
      void p
        .then(() => {
          try {
            window.setTimeout(() => {
              try {
                (window as any).__mmDeferWalletSession = false;
              } catch {}
            }, 2000);
          } catch {}
          setMwaAttempting(false);
          setMwaTrouble(null);
        })
        .catch((e: any) => {
          try {
            (window as any).__mmDeferWalletSession = false;
          } catch {}
          setMwaAttempting(false);
          const msg = String(e?.message || e || "MWA connect failed.");
          setMwaTrouble({ open: true, msg });
        });

      // Watchdog: if no wallet UI appears, show a clear explanation + fallbacks.
      window.setTimeout(() => {
        try {
          if (!wallet.connected) {
            setMwaAttempting(false);
            setMwaTrouble({
              open: true,
              msg:
                "MWA did not open a wallet app. This is usually an Android intent / app-link routing issue on Chrome/PWA builds.",
            });
            try {
              (window as any).__mmDeferWalletSession = false;
            } catch {}
          }
        } catch {}
      }, 2500);

      return true;
    } catch (e: any) {
      try {
        (window as any).__mmDeferWalletSession = false;
      } catch {}
      setMwaAttempting(false);
      setMwaTrouble({ open: true, msg: String(e?.message || e || "MWA connect failed.") });
      return false;
    }
  }

  async function handleConnectClick() {
    // Android Chrome / installed PWA: open wallet in-app browser options.
    // MWA intent routing is unreliable on some Chromium builds (including Seeker).
    if (isAndroidChromeOrPwaStandalone()) {
      setMwaTrouble({
        open: true,
        msg:
          "On Android Chrome/PWA, connect by opening Mojomaxi inside a wallet\'s in-app browser. This is the most reliable flow on Seeker Chromium builds.",
      });
      return;
    }


    // If a wallet is already selected, connect immediately (user-initiated).
    if (wallet.wallet && !wallet.connecting && !wallet.connected) {
      try {
        await wallet.connect();
        return;
      } catch (e) {
        console.error("[ConnectWallet] connect error:", e);
      }
    }
    // Fallback: open wallet modal (desktop/iOS).

    if (typeof setVisible === "function") setVisible(true);
  }

  function handleClick() {
    if (!connected) {
      void handleConnectClick();
      return;
    }
    setMenuOpen((v) => !v);
  }

  async function handleDisconnect() {
    try {
      await wallet.disconnect();
    } catch (e) {
      console.error("[ConnectWallet] disconnect error:", e);
    } finally {
      setMenuOpen(false);
    }
  }

  function handleChangeWallet() {
    if (typeof setVisible === "function") setVisible(true);
    setMenuOpen(false);
  }

  function openInPhantom() {
    try {
      window.location.href = buildPhantomBrowseLink(getHereUrl(), getRefUrl());
    } catch {}
  }

  function openInSolflare() {
    try {
      window.location.href = buildSolflareBrowseLink(getHereUrl(), getRefUrl());
    } catch {}
  }

  function openInBackpack() {
    try {
      window.location.href = buildBackpackBrowseLink(getHereUrl(), getRefUrl());
    } catch {}
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__mmHeaderConnectWallet = () => {
      void handleConnectClick();
    };
    return () => {
      try {
        if ((window as any).__mmHeaderConnectWallet) delete (window as any).__mmHeaderConnectWallet;
      } catch {}
    };
  }, [wallet.wallet, wallet.connecting, wallet.connected, setVisible]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={handleClick}
        className={[
          "inline-flex h-10 items-center justify-center bg-[#FD1B77] text-sm font-semibold text-white shadow-sm transition",
          "hover:opacity-95 active:opacity-90",
          "rounded-full px-4",
        ].join(" ")}
        aria-label={connected ? "Wallet menu" : "Connect wallet"}
      >
        {connected ? (
          providerIcon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={providerIcon} alt="Wallet" className="h-5 w-5" />
          ) : (
            <span className="text-white">Wallet</span>
          )
        ) : (
          <span>Connect</span>
        )}
      </button>

      {/* MWA trouble fallback (Android Chrome/PWA only) */}
      {mwaTrouble?.open ? (
        <div className="absolute right-0 z-50 mt-2 w-[320px] rounded-xl border border-white/10 bg-[#121212] p-3 text-sm shadow-xl">
          <div className="font-semibold text-white">Wallet connection blocked</div>
          <div className="mt-1 text-xs text-white/70">
            {mwaTrouble.msg ||
              "Chrome/PWA blocked the wallet handoff. Use a wallet in-app browser as a fallback."}
          </div>

          <div className="mt-3 grid gap-2">
            <button
              type="button"
              onClick={openInPhantom}
              className="flex w-full items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-left hover:bg-white/10"
            >
              <img
                src="/brand/wallets/phantom.svg"
                alt="Phantom"
                className="h-6 w-6 rounded"
              />
              <span className="flex-1">
                <div className="text-sm">Phantom</div>
                <div className="text-[11px] text-white/60">Open Mojomaxi in Phantom</div>
              </span>
              <span className="text-[11px] text-white/50">→</span>
            </button>

            <button
              type="button"
              onClick={openInSolflare}
              className="flex w-full items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-left hover:bg-white/10"
            >
              <img
                src="/brand/wallets/solflare.svg"
                alt="Solflare"
                className="h-6 w-6 rounded"
              />
              <span className="flex-1">
                <div className="text-sm">Solflare</div>
                <div className="text-[11px] text-white/60">Open Mojomaxi in Solflare</div>
              </span>
              <span className="text-[11px] text-white/50">→</span>
            </button>

            <button
              type="button"
              onClick={openInBackpack}
              className="flex w-full items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-left hover:bg-white/10"
            >
              <img
                src="/brand/wallets/backpack.svg"
                alt="Backpack"
                className="h-6 w-6 rounded"
              />
              <span className="flex-1">
                <div className="text-sm">Backpack</div>
                <div className="text-[11px] text-white/60">Open Mojomaxi in Backpack</div>
              </span>
              <span className="text-[11px] text-white/50">→</span>
            </button>

            <button
              type="button"
              onClick={() => setMwaTrouble(null)}
              className="w-full rounded-lg px-3 py-2 text-left text-white/70 hover:bg-white/5"
            >
              Dismiss
            </button>
          </div>

          <div className="mt-2 text-[11px] text-white/50">
            Jupiter Mobile: use “Magic Scan” (QR) or open Mojomaxi inside Jupiter’s in-app browser.
          </div>
        </div>
      ) : null}

      {connected && menuOpen ? (
        <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-white/10 bg-[#121212] p-2 text-sm shadow-xl">
          <button
            type="button"
            onClick={handleSubscribe}
            className="w-full rounded-lg px-3 py-2 text-left hover:bg-white/5"
          >
            Subscribe
          </button>

          <button
            type="button"
            onClick={handleChangeWallet}
            className="w-full rounded-lg px-3 py-2 text-left hover:bg-white/5"
          >
            Change wallet
          </button>

          <div className="my-1 h-px bg-white/10" />

          <button
            type="button"
            onClick={() => void handleDisconnect()}
            className="w-full rounded-lg px-3 py-2 text-left hover:bg-white/5"
          >
            Disconnect
          </button>

          {hasWsol ? (
            <>
              <div className="my-1 h-px bg-white/10" />
              <button
                type="button"
                disabled={unwrapBusy || checkingWsol}
                onClick={() => void handleUnwrapWsol()}
                className="w-full rounded-lg px-3 py-2 text-left hover:bg-white/5 disabled:opacity-50"
              >
                {unwrapBusy ? "Unwrapping…" : "Unwrap WSOL → SOL"}
              </button>
            </>
          ) : null}

          {menuOpen && wallet?.publicKey ? (
            <div className="mt-2 px-3 pb-1 text-xs text-white/60">
              {checkingWsol ? "Checking WSOL…" : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
