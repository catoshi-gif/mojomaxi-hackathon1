// FULL FILE REPLACEMENT: SubscribeModalRoot.tsx
// (UI facelift only: logic, copy, and overall layout preserved)

"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Button } from "@/components/ui/button";
import { usePollingGate } from "@/lib/useActivityGate";

declare global {
  interface Window {
    __mmOpenSubscribeModal?: (opts?: { strategyId?: string }) => void;
    solana?: any;
    solflare?: any;
  }
}

type Status = { active: boolean; expiresAt: number; creditedUsd?: number; totalPaidUsd?: number };

function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== "function") throw new Error("base64 not supported");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function fmtDate(ms: number) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}
/** iOS sometimes stubs window.confirm — treat non-boolean as proceed. */
function safeConfirm(message: string): boolean {
  try {
    const ua =
      typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "";
    const isIOS =
      /iPhone|iPad|iPod/.test(ua) ||
      !!(navigator as any)?.standalone ||
      (/Macintosh/.test(ua) && (navigator as any)?.maxTouchPoints > 1);
    if (isIOS) return true;
    const ok =
      typeof window !== "undefined" && typeof (window as any).confirm === "function"
        ? (window as any).confirm(message)
        : true;
    return typeof ok === "boolean" ? ok : true;
  } catch {
    return true;
  }
}

type PreparedTx = { b64: string; amountUsd: number; wallet: string; createdAt: number };
const PREPARE_REFRESH_MS = 25_000;
const PREPARE_STALE_MS = 50_000;

// Token-2022 id for USDC detection
const TOKEN_2022_PROGRAM_ID_STR = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// Default USDC (classic)
const DEFAULT_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SUB_USDC_MINT = process.env.NEXT_PUBLIC_SUBS_USDC_MINT || DEFAULT_USDC_MINT;

type UsdcState = {
  loading: boolean;
  ui: number | null;
  atoms: string | null;
  decimals: number | null;
  tokenProgram: string | null;
  fetchedAt: number | null;
};

export default function SubscribeModalRoot() {
  const { shouldPoll } = usePollingGate({ idleMs: 60_000 });
  const { publicKey, sendTransaction, signTransaction, wallet: walletCtx } = useWallet();
  const { connection } = useConnection();
  const walletAddr = useMemo(
    () => (publicKey ? publicKey.toBase58() : ""),
    [publicKey]
  );

  const [open, setOpen] = useState(false);
  const [strategyId, setStrategyId] = useState<string>("mojo-pro-sol");
  const [loading, setLoading] = useState(false);
  const [amountUsd, setAmountUsd] = useState<string>("20");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string>("");

  const [prepared, setPrepared] = useState<PreparedTx | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);

  const [usdc, setUsdc] = useState<UsdcState>({
    loading: false,
    ui: null,
    atoms: null,
    decimals: null,
    tokenProgram: null,
    fetchedAt: null,
  });

  // prevent page scroll while modal is open
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    const prevHtmlOverflow = (document.documentElement.style as any).overflow;
    document.body.style.overflow = "hidden";
    (document.documentElement.style as any).overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      (document.documentElement.style as any).overflow = prevHtmlOverflow || "";
    };
  }, [open]);

  const bumpAmount = useCallback((delta: number) => {
    setAmountUsd((prev) => {
      const curr = Number(prev) || 0;
      const base = Math.max(20, Math.round(curr / 20) * 20);
      let next = base + delta;
      if (next < 20) next = 20;
      return String(next);
    });
  }, []);
  const daysText = useMemo(() => {
    const amt = Number(amountUsd);
    if (!(amt > 0)) return "";
    return `~${Math.floor(amt / 20) * 30} days`;
  }, [amountUsd]);

  const fetchStatus = useCallback(async () => {
    if (!walletAddr) {
      setStatus(null);
      return;
    }
    try {
      const r = await fetch(
        `/api/subs/${strategyId}/status?wallet=${encodeURIComponent(walletAddr)}`,
        { cache: "no-store" }
      );
      const j = await r.json();
      if (j?.ok) setStatus(j.status);
    } catch {
      // ignore
    }
  }, [walletAddr, strategyId]);

  const prefetchIntent = useCallback(
    async (signal?: AbortSignal) => {
      if (!open || !walletAddr) return;
      const amt = Number(amountUsd);
      if (!(amt > 0)) return;
      try {
        const r = await fetch(`/api/subs/${strategyId}/intent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: walletAddr, amountUsd: amt }),
          signal,
        });
        const j = await r.json();
        if (j?.ok && j.txBase64) {
          setPrepared({
            b64: j.txBase64,
            amountUsd: amt,
            wallet: walletAddr,
            createdAt: Date.now(),
          });
        }
      } catch {
        /* ignore */
      }
    },
    [open, walletAddr, amountUsd, strategyId]
  );

  // USDC balance pre-check (background)
  const refreshUsdc = useCallback(async () => {
    if (!open || !walletAddr || !connection || !publicKey) return;
    setUsdc((s) => ({ ...s, loading: true }));
    try {
      const spl = await import("@solana/spl-token");
      const mint = new PublicKey(SUB_USDC_MINT);

      // detect token program for the USDC mint
      let ownerPk: PublicKey | null = null;
      for (const c of ["processed", "confirmed", "finalized"] as const) {
        try {
          const ai = await connection.getAccountInfo(mint, c);
          if (ai?.owner) {
            ownerPk = ai.owner;
            break;
          }
        } catch {
          // ignore
        }
      }
      const tokenProgramId =
        ownerPk && ownerPk.toBase58() === TOKEN_2022_PROGRAM_ID_STR
          ? new PublicKey(TOKEN_2022_PROGRAM_ID_STR)
          : spl.TOKEN_PROGRAM_ID;

      // derive ATA for the user with the correct token program
      const ata = spl.getAssociatedTokenAddressSync(
        mint,
        publicKey!,
        false,
        tokenProgramId,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const bal = await connection
        .getTokenAccountBalance(ata, "confirmed")
        .catch(() => null);
      const amount = bal?.value?.amount || "0";
      const decimals = Number(bal?.value?.decimals ?? 6);
      const ui = Number(amount) / Math.pow(10, decimals);

      setUsdc({
        loading: false,
        ui: Number.isFinite(ui) ? ui : 0,
        atoms: String(amount),
        decimals,
        tokenProgram: tokenProgramId.toBase58(),
        fetchedAt: Date.now(),
      });
    } catch {
      setUsdc({
        loading: false,
        ui: 0,
        atoms: "0",
        decimals: 6,
        tokenProgram: null,
        fetchedAt: Date.now(),
      });
    }
  }, [open, walletAddr, connection, publicKey]);

  // Prefetch tx + balance on open/amount change, refresh periodically
  useEffect(() => {
    if (!open || !walletAddr) {
      setPrepared(null);
      return;
    }
    if (prefetchAbortRef.current) {
      prefetchAbortRef.current.abort();
    }
    const ctrl = new AbortController();
    prefetchAbortRef.current = ctrl;
    void prefetchIntent(ctrl.signal);
    void refreshUsdc();
    const id = shouldPoll
      ? window.setInterval(() => {
          void prefetchIntent(ctrl.signal);
          void refreshUsdc();
        }, PREPARE_REFRESH_MS)
      : undefined;
    return () => {
      if (id) window.clearInterval(id);
      ctrl.abort();
      if (prefetchAbortRef.current === ctrl) prefetchAbortRef.current = null;
    };
  }, [open, walletAddr, amountUsd, strategyId, prefetchIntent, refreshUsdc, shouldPoll]);

  // expose opener
  useEffect(() => {
    window.__mmOpenSubscribeModal = (opts?: { strategyId?: string }) => {
      setStrategyId(opts?.strategyId || "mojo-pro-sol");
      setOpen(true);
      setAmountUsd("20");
      setError("");
      setPrepared(null);
      setTimeout(() => {
        void fetchStatus();
      }, 0);
    };
    return () => {
      if (window.__mmOpenSubscribeModal) delete window.__mmOpenSubscribeModal;
    };
  }, [fetchStatus]);

  useEffect(() => {
    if (open) void fetchStatus();
  }, [open, fetchStatus]);

  const onClose = useCallback(() => {
    if (loading) return;
    setOpen(false);
    setError("");
    setPrepared(null);
  }, [loading]);

  const handleSubscribe = useCallback(async () => {
    if (!walletAddr) {
      setError("Connect your wallet first.");
      return;
    }
    const amt = Number(amountUsd);
    if (!(amt > 0)) return;
    const days = Math.floor(amt / 20) * 30;

    // Confirm first (iOS-safe)
    const proceed = safeConfirm(
      `Are you sure you would like to deposit ${amt.toFixed(
        0
      )} USDC for ${days} days of Mojo Pro?\nPayments are non-refundable.`
    );
    if (!proceed) return;

    // USDC pre-check (cached)
    const dec = usdc.decimals ?? 6;
    const needAtoms = BigInt(Math.floor(amt * Math.pow(10, dec)));
    const haveAtoms = BigInt(usdc.atoms ? BigInt(usdc.atoms) : 0n);
    const fresh =
      typeof usdc.fetchedAt === "number" &&
      Date.now() - usdc.fetchedAt < PREPARE_STALE_MS;
    if (!fresh) {
      setError("Checking USDC balance… Please tap Pay again.");
      void refreshUsdc();
      return;
    }
    if (haveAtoms < needAtoms) {
      const haveUi = (usdc.ui ?? 0).toFixed(2);
      const needUi = amt.toFixed(0);
      setError(`Insufficient USDC: need ${needUi}, wallet has ${haveUi}.`);
      return;
    }

    // Use prepared (no awaits before wallet)
    const now = Date.now();
    const effective =
      prepared &&
      prepared.wallet === walletAddr &&
      prepared.amountUsd === amt &&
      now - prepared.createdAt < PREPARE_STALE_MS
        ? prepared
        : null;

    if (!effective) {
      setError("Preparing transaction… Please tap Pay again.");
      void prefetchIntent();
      return;
    }

    setLoading(true);
    setError("");
    try {
      const tx = VersionedTransaction.deserialize(b64ToBytes(effective.b64));
      let sig: string | undefined;
      const adapterAny: any = walletCtx?.adapter as any;

      if (adapterAny?.signAndSendTransaction) {
        try {
          const res = await adapterAny.signAndSendTransaction(tx);
          sig =
            typeof res === "string"
              ? res
              : (res?.signature ?? res?.txid ?? res?.hash);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            "[SubscribeModal] signAndSendTransaction failed, trying sendTransaction:",
            e
          );
        }
      }
      if (!sig && typeof sendTransaction === "function") {
        try {
          sig = await sendTransaction(tx, connection, {
            skipPreflight: false,
          });
        } catch (e) {
          console.warn(
            "[SubscribeModal] sendTransaction failed, trying signTransaction + sendRaw:",
            e
          );
        }
      }
      if (!sig) {
        if (!signTransaction)
          throw new Error(
            "Wallet does not support signTransaction on this device"
          );
        const signed = await signTransaction(tx);
        sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });
      }

      void connection.confirmTransaction(sig, "confirmed").catch(() => {});
      const r2 = await fetch(`/api/subs/${strategyId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: walletAddr, tx: sig, amountUsd: amt }),
      });
      const j2 = await r2.json();
      if (!j2?.ok) throw new Error(j2?.error || "confirm_failed");

      await fetchStatus();
      alert("Subscription updated successfully.");
      setPrepared(null);
      void prefetchIntent();
    } catch (e: any) {
      console.warn("[SubscribeModal] subscribe failed:", e);
      setError(e?.message || "subscribe_failed");
    } finally {
      setLoading(false);
    }
  }, [
    walletAddr,
    amountUsd,
    connection,
    strategyId,
    fetchStatus,
    walletCtx?.adapter,
    sendTransaction,
    signTransaction,
    prepared,
    prefetchIntent,
    usdc,
    refreshUsdc,
  ]);

  const payPressedRef = useRef(false);
  const multiTriggerPay = useCallback(
    (e?: React.SyntheticEvent) => {
      if (e && (e.type === "touchstart" || e.type === "touchend"))
        (e as any).preventDefault?.();
      if (loading || payPressedRef.current) return;
      payPressedRef.current = true;
      Promise.resolve(handleSubscribe()).finally(() => {
        payPressedRef.current = false;
      });
    },
    [handleSubscribe, loading]
  );

  // esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-hidden">
      {/* Backdrop with subtle gradient + blur */}
      <div
        className="absolute inset-0 z-[110] bg-black/75 backdrop-blur-md"
        onClick={onClose}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(34,197,235,0.2),transparent_60%),radial-gradient(circle_at_bottom,_rgba(236,72,153,0.25),transparent_65%)]"
        />
      </div>

      {/* Modal panel (scrolls internally) */}
      <div className="absolute inset-0 flex items-center justify-center p-4 sm:p-6">
        <div
          role="dialog"
          aria-modal="true"
          className="relative z-[120] w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-gradient-to-br from-slate-950/95 via-slate-950/95 to-slate-900/95 p-4 shadow-[0_24px_120px_rgba(15,23,42,1)] sm:p-5"
          style={{ WebkitTransform: "translateZ(0)" }}
        >
          {/* Header */}
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[0.65rem] font-medium uppercase tracking-[0.17em] text-emerald-100/90">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]" />
                <span>Mojo Pro Subscription</span>
              </div>
              <div className="text-lg font-semibold sm:text-xl">
                Unlock advanced Mojomaxi features
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/40 text-sm text-slate-200 hover:bg-white/10 active:scale-95"
              style={{ touchAction: "manipulation" }}
            >
              ✕
            </button>
          </div>

          {/* Content grid
              - Mobile: single column flow
              - Desktop (md+): 1fr | auto (mascot column) */}
          <div className="grid gap-4 md:grid-cols-[minmax(0,1.35fr)_minmax(0,0.8fr)] md:gap-6">
            {/* Status (spans both columns on desktop) */}
            <div className="md:col-span-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 sm:px-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[0.65rem] uppercase tracking-[0.16em] text-slate-400">
                    Status
                  </div>
                  {status?.active ? (
                    <div className="text-sm">
                      Active until{" "}
                      <span className="font-mono text-slate-100">
                        {fmtDate(status.expiresAt)}
                      </span>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-100">Not active</div>
                  )}
                </div>
                <div className="text-[11px] font-mono text-slate-400">
                  Total paid:{" "}
                  <span className="text-slate-100">
                    {status?.totalPaidUsd ?? 0} USDC
                  </span>
                </div>
              </div>
            </div>

            {/* Left column (desktop); main content (mobile) */}
            <div className="min-w-0">
              <label className="mb-1 block text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                Subscribe / Extend (USDC)
              </label>

              <div className="mb-3 flex flex-wrap items-end gap-3">
                <div className="relative w-44 sm:w-48">
                  <input
                    type="number"
                    min={20}
                    step={20}
                    value={amountUsd}
                    onChange={(e) => setAmountUsd(e.target.value)}
                    className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 pr-12 text-sm text-slate-50 outline-none ring-0 transition focus:border-emerald-400/70 focus:bg-black/60"
                    readOnly
                    inputMode="none"
                    onWheel={(e) => e.currentTarget.blur()}
                  />

                  {/* Mobile-only "~30 days" directly below the input */}
                  <div className="mt-1 text-xs text-slate-400 sm:hidden">
                    {daysText}
                  </div>

                  {/* Desktop stepper (stacked, bigger targets) */}
                  <div className="absolute inset-y-1 right-1 hidden w-10 flex-col overflow-hidden rounded-md border border-white/20 bg-black/40 sm:flex">
                    <button
                      type="button"
                      aria-label="Increase amount"
                      onClick={() => bumpAmount(20)}
                      className="flex-1 text-[0.8rem] leading-none hover:bg-white/10 active:bg-white/15"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label="Decrease amount"
                      onClick={() => bumpAmount(-20)}
                      className="flex-1 text-[0.8rem] leading-none hover:bg-white/10 active:bg-white/15"
                    >
                      ▼
                    </button>
                  </div>

                  {/* Mobile stepper (bigger touch targets) */}
                  <div className="mt-2 flex gap-2 sm:hidden">
                    <button
                      type="button"
                      aria-label="Decrease amount"
                      onClick={() => bumpAmount(-20)}
                      className="h-10 min-w-[44px] flex-1 rounded-lg border border-white/15 bg-black/40 text-base active:translate-y-px"
                    >
                      –
                    </button>
                    <button
                      type="button"
                      aria-label="Increase amount"
                      onClick={() => bumpAmount(20)}
                      className="h-10 min-w-[44px] flex-1 rounded-lg border border-white/15 bg-black/40 text-base active:translate-y-px"
                    >
                      +
                    </button>
                  </div>
                </div>

                <Button
                  type="button"
                  onClick={multiTriggerPay}
                  onTouchStart={multiTriggerPay}
                  onPointerDown={multiTriggerPay}
                  onTouchEnd={multiTriggerPay}
                  onPointerUp={multiTriggerPay}
                  disabled={!walletAddr || loading}
                  style={{ touchAction: "manipulation" }}
                  className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-pink-500 via-violet-500 to-cyan-300 px-6 py-2.5 text-sm font-semibold text-white shadow-[0_18px_60px_rgba(8,47,73,0.85)] hover:shadow-[0_22px_80px_rgba(8,47,73,1)] disabled:opacity-60 disabled:shadow-none"
                >
                  {loading ? "Processing…" : "Pay"}
                </Button>

                {/* Desktop-only "~30 days" inline */}
                <div className="hidden text-xs text-slate-400 sm:block">
                  {daysText}
                </div>
              </div>

              {error && (
                <div className="mt-1 text-xs text-red-400">{error}</div>
              )}

              <div className="mt-3 text-[11px] leading-relaxed text-slate-400">
                Your wallet will send a USDC transfer to the Mojomaxi subscription
                treasury via a signed transaction.
              </div>

              {/* Desktop feature pills (left column). Hidden on mobile because we render a mobile row below. */}
              <div className="mt-4 hidden flex-wrap gap-2 md:flex">
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  All bots: P+L share card rendering
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  All bots: Token-2022 trades enabled
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  Webhooks: Manual mode
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  Rebalance: Up to 20 tokens
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  Rebalance: 1-hour cadence
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  Community: Aristocat role on Discord
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  More to come!
                </span>
              </div>
            </div>

            {/* Desktop mascot (sticky in its own column, slightly smaller) */}
            <div className="hidden self-start justify-self-end md:sticky md:top-4 md:block pointer-events-none select-none">
              <Image
                src="/brand/mojopro2.webp"
                alt="Mojo Pro badge"
                width={480}
                height={720}
                priority={false}
                className="h-auto w-[26vw] max-w-[260px] min-w-[200px] lg:max-w-[280px] object-contain"
                sizes="(max-width: 1024px) 26vw, 280px"
              />
            </div>

            {/* MOBILE BOTTOM ROW: feature pills (left) + mascot (right) */}
            <div className="grid grid-cols-[minmax(0,1.4fr)_auto] items-end gap-2 md:hidden mt-2">
              {/* pills left of mascot on the same row */}
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  P+L share cards
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  Token-2022 trades
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  20 tokens in a rebalance bot + 1-hour cadence
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  Manual swaps via Webhooks panel
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  Aristocat Discord role
                </span>
                <span className="rounded-full border border-fuchsia-500/25 bg-fuchsia-500/10 px-3 py-1 text-[11px] text-fuchsia-100">
                  More as we ship!
                </span>
              </div>
              {/* mascot anchored to bottom-right of panel on mobile, smaller */}
              <div className="justify-self-end pointer-events-none select-none">
                <Image
                  src="/brand/mojopro2.webp"
                  alt="Mojo Pro badge"
                  width={260}
                  height={400}
                  className="h-auto w-24 xs:w-28 sm:w-32 object-contain"
                  sizes="(max-width: 420px) 6.5rem, (max-width: 640px) 7.5rem, 8rem"
                  priority={false}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
