// BEGIN FULL FILE REPLACEMENT
// filepath: src/components/DisclaimerModal.tsx
"use client";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";

/**
 * DisclaimerModal (wallet-scoped)
 * - Shows ONLY when a wallet is connected (walletAddress provided).
 * - Acceptance is stored per wallet in localStorage.
 * - Will not render at all if walletAddress is falsy (so it won't appear on non-app pages or before connect).
 *
 * Usage (on your app page only):
 *   <DisclaimerModal walletAddress={publicKey?.toBase58()} />
 */
export default function DisclaimerModal({ walletAddress }: { walletAddress?: string }) {
  // Do not render at all until we actually have a wallet address.
  if (!walletAddress) return null;

  const storageKey = useMemo(
    () => `mojomaxi_disclaimer_accepted:${walletAddress}`,
    [walletAddress]
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Re-check whenever wallet changes
    const accepted = localStorage.getItem(storageKey);
    setOpen(!accepted);
  }, [storageKey]);

  function accept() {
    if (typeof window !== "undefined") {
      localStorage.setItem(storageKey, "true");
    }
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      className={clsx(
        "fixed inset-0 z-[9999] flex items-center justify-center",
        "bg-black/60 backdrop-blur-sm"
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Disclaimer"
    >
      {/* Panel */}
      <div
        className={clsx(
          "relative w-[min(94vw,560px)] rounded-2xl border border-white/10 bg-[#0A0A0A] p-6 text-white",
          "shadow-[0_0_0_1px_rgba(255,255,255,0.05)_inset,0_30px_80px_-20px_rgba(0,0,0,0.45)]"
        )}
      >
        {/* Halo */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-6 -z-10 rounded-[28px] bg-gradient-to-b from-fuchsia-500/15 via-pink-500/10 to-transparent blur-2xl"
        />

        {/* Header */}
        <div className="mb-3 flex items-center gap-2">
          <span
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-500 text-white shadow-[0_0_18px_rgba(236,72,153,0.35)]"
            aria-hidden
          >
            !
          </span>
          <h2 className="text-lg font-semibold lowercase bg-gradient-to-r from-pink-400 to-violet-400 bg-clip-text text-transparent">
            disclaimer
          </h2>
        </div>

        {/* Copy (bulleted for clarity) */}
        <div className="leading-relaxed text-white/80 text-sm">
          <p className="mb-2">
            <strong className="text-white/90">Before using Mojomaxi, please read:</strong>
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              Each swap includes a <span className="font-semibold">0.25% fee</span>. Network fees
              (<em>gas</em>) for swaps is paid for by our relayer.
            </li>
            <li>
              <span className="font-semibold">Deposit only through this app.</span> Sending tokens
              directly to a vault address or ATA outside the app can result in permanent loss of funds.
            </li>
            <li>
              Mojomaxi has <span className="font-semibold">not yet undergone a third-party audit</span>.
              Please use the app at your own discretion and risk.
            </li>
          </ul>
          <p className="mt-3 text-xs text-white/60">
            By clicking &ldquo;I understand and accept,&rdquo; you confirm you have read and agree to
            these terms to the fullest extent permitted by applicable law.
          </p>
        </div>

        {/* Accept */}
        <button
          onClick={accept}
          className={clsx(
            "mt-5 w-full rounded-xl px-4 py-2 text-sm font-medium lowercase text-white transition",
            "bg-gradient-to-r from-pink-500 to-violet-500 hover:opacity-90"
          )}
        >
          I understand and accept
        </button>

        {/* Fine print / accessibility note */}
        <div className="mt-2 text-center text-[11px] text-white/40">
          You’ll see this once per connected wallet.
        </div>
      </div>
    </div>
  );
}
// END FULL FILE REPLACEMENT
