// filepath: src/app/help/mojo-pro/page.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { usePollingGate } from "@/lib/useActivityGate";
import Image from "next/image";

// ----------------- Shared helpers / types (mirrors SubscribeModalRoot) -----------------

type Status = {
  active: boolean;
  expiresAt: number;
  creditedUsd?: number;
  totalPaidUsd?: number;
};

type PreparedTx = {
  b64: string;
  amountUsd: number;
  wallet: string;
  createdAt: number;
};

type UsdcState = {
  loading: boolean;
  ui: number | null;
  atoms: string | null;
  decimals: number | null;
  tokenProgram: string | null;
  fetchedAt: number | null;
};

const PREPARE_REFRESH_MS = 25_000;
const PREPARE_STALE_MS = 50_000;

const TOKEN_2022_PROGRAM_ID_STR = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DEFAULT_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SUB_USDC_MINT =
  process.env.NEXT_PUBLIC_SUBS_USDC_MINT || DEFAULT_USDC_MINT;

const STRATEGY_ID = "mojo-pro-sol";

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
      typeof navigator !== "undefined" && navigator.userAgent
        ? navigator.userAgent
        : "";
    const isIOS =
      /iPhone|iPad|iPod/.test(ua) ||
      !!(navigator as any)?.standalone ||
      (/Macintosh/.test(ua) && (navigator as any)?.maxTouchPoints > 1);
    if (isIOS) return true;
    const ok =
      typeof window !== "undefined" &&
      typeof (window as any).confirm === "function"
        ? (window as any).confirm(message)
        : true;
    return typeof ok === "boolean" ? ok : true;
  } catch {
    return true;
  }
}

// ----------------- Typography helpers -----------------

function GradientH1({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
      <span className="bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-300 bg-clip-text text-transparent">
        {children}
      </span>
    </h1>
  );
}

function GradientH2Pink({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xl font-semibold sm:text-3xl">
      <span className="bg-gradient-to-r from-pink-500 via-fuchsia-500 to-pink-400 bg-clip-text text-transparent">
        {children}
      </span>
    </h2>
  );
}

function SectionHeading({ title, kicker }: { title: string; kicker?: string }) {
  return (
    <div className="mb-4 text-center md:text-left">
      {kicker ? (
        <div className="mb-1 text-xs uppercase tracking-widest text-white/50">
          {kicker}
        </div>
      ) : null}
      <GradientH2Pink>{title}</GradientH2Pink>
    </div>
  );
}

// ----------------- Page -----------------

export default function MojoProHelpPage() {
  const router = useRouter();
  const { shouldPoll } = usePollingGate({ idleMs: 60_000 });
  const { publicKey, sendTransaction, signTransaction, wallet: walletCtx } =
    useWallet();
  const { connection } = useConnection();
  const walletAddr = useMemo(
    () => (publicKey ? publicKey.toBase58() : ""),
    [publicKey]
  );

  const [amountUsd, setAmountUsd] = useState<string>("20");
  const [status, setStatus] = useState<Status | null>(null);
  const [prepared, setPrepared] = useState<PreparedTx | null>(null);
  const [usdc, setUsdc] = useState<UsdcState>({
    loading: false,
    ui: null,
    atoms: null,
    decimals: null,
    tokenProgram: null,
    fetchedAt: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const prefetchAbortRef = useRef<AbortController | null>(null);
  const payPressedRef = useRef(false);

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
        `/api/subs/${STRATEGY_ID}/status?wallet=${encodeURIComponent(
          walletAddr
        )}`,
        { cache: "no-store" }
      );
      const j = await r.json();
      if (j?.ok) setStatus(j.status);
    } catch {
      // ignore
    }
  }, [walletAddr]);

  const prefetchIntent = useCallback(
    async (signal?: AbortSignal) => {
      if (!walletAddr) return;
      const amt = Number(amountUsd);
      if (!(amt > 0)) return;
      try {
        const r = await fetch(`/api/subs/${STRATEGY_ID}/intent`, {
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
    [walletAddr, amountUsd]
  );

  const refreshUsdc = useCallback(async () => {
    if (!walletAddr || !connection || !publicKey) return;
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
  }, [walletAddr, connection, publicKey]);

  // Prefetch tx + balance periodically while user is on this page with a connected wallet
  useEffect(() => {
    if (!walletAddr) {
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
    void fetchStatus();

    const id =
      shouldPoll && walletAddr
        ? window.setInterval(() => {
            void prefetchIntent(ctrl.signal);
            void refreshUsdc();
            void fetchStatus();
          }, PREPARE_REFRESH_MS)
        : undefined;

    return () => {
      if (id) window.clearInterval(id);
      ctrl.abort();
      if (prefetchAbortRef.current === ctrl) prefetchAbortRef.current = null;
    };
  }, [
    walletAddr,
    amountUsd,
    prefetchIntent,
    refreshUsdc,
    fetchStatus,
    shouldPoll,
  ]);

  const handleSubscribe = useCallback(async () => {
    if (!walletAddr) {
      setError("connect your wallet first");
      return;
    }
    const amt = Number(amountUsd);
    if (!(amt > 0)) return;
    const days = Math.floor(amt / 20) * 30;

    const proceed = safeConfirm(
      `are you sure you would like to deposit ${amt.toFixed(
        0
      )} USDC for ${days} days of mojo pro?
payments are non-refundable.`
    );
    if (!proceed) return;

    const dec = usdc.decimals ?? 6;
    const needAtoms = BigInt(Math.floor(amt * Math.pow(10, dec)));
    const haveAtoms = BigInt(usdc.atoms ?? "0");
    const fresh =
      typeof usdc.fetchedAt === "number" &&
      Date.now() - usdc.fetchedAt < PREPARE_STALE_MS;

    if (!fresh) {
      setError("checking USDC balance… please tap pay again");
      void refreshUsdc();
      return;
    }
    if (haveAtoms < needAtoms) {
      const haveUi = (usdc.ui ?? 0).toFixed(2);
      const needUi = amt.toFixed(0);
      setError(`insufficient USDC: need ${needUi}, wallet has ${haveUi}`);
      return;
    }

    const now = Date.now();
    const effective =
      prepared &&
      prepared.wallet === walletAddr &&
      prepared.amountUsd === amt &&
      now - prepared.createdAt < PREPARE_STALE_MS
        ? prepared
        : null;

    if (!effective) {
      setError("preparing transaction… please tap pay again");
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
          console.warn(
            "[MojoPro inline] signAndSendTransaction failed, trying sendTransaction:",
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
            "[MojoPro inline] sendTransaction failed, trying signTransaction + sendRaw:",
            e
          );
        }
      }

      if (!sig) {
        if (!signTransaction)
          throw new Error(
            "wallet does not support signTransaction on this device"
          );
        const signed = await signTransaction(tx);
        sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });
      }

      void connection.confirmTransaction(sig, "confirmed").catch(() => {});
      const r2 = await fetch(`/api/subs/${STRATEGY_ID}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: walletAddr, tx: sig, amountUsd: amt }),
      });
      const j2 = await r2.json();
      if (!j2?.ok) throw new Error(j2?.error || "confirm_failed");

      await fetchStatus();
      alert("subscription updated successfully.");
      setPrepared(null);
      void prefetchIntent();
    } catch (e: any) {
      console.warn("[MojoPro inline] subscribe failed:", e);
      setError(e?.message || "subscribe_failed");
    } finally {
      setLoading(false);
    }
  }, [
    walletAddr,
    amountUsd,
    connection,
    fetchStatus,
    sendTransaction,
    signTransaction,
    walletCtx?.adapter,
    prepared,
    prefetchIntent,
    usdc,
    refreshUsdc,
  ]);

  const multiTriggerPay = useCallback(
    (e?: React.SyntheticEvent) => {
      if (
        e &&
        (e.type === "touchstart" ||
          e.type === "touchend" ||
          e.type === "pointerdown" ||
          e.type === "pointerup")
      ) {
        (e as any).preventDefault?.();
      }
      if (loading || payPressedRef.current) return;
      payPressedRef.current = true;
      Promise.resolve(handleSubscribe()).finally(() => {
        payPressedRef.current = false;
      });
    },
    [handleSubscribe, loading]
  );

  const totalPaidDisplay =
    typeof status?.totalPaidUsd === "number"
      ? `${status.totalPaidUsd.toFixed(2)} USDC`
      : "0.00 USDC";

  const statusLine = status?.active
    ? `active until ${fmtDate(status.expiresAt)}`
    : "not active";

  const daysTextVal =
    daysText && daysText.trim().length > 0 ? daysText.toLowerCase() : "";

  const daysPurchasePill =
    daysTextVal && daysTextVal.length > 0
      ? `this purchase adds ${daysTextVal}`
      : "";

  const currentAmountDisplay = useMemo(() => {
    const n = Number(amountUsd || "0");
    if (!Number.isFinite(n) || n <= 0) return "0";
    return n.toFixed(0);
  }, [amountUsd]);

  return (
    <main className="mm-full-bleed relative isolate min-h-[100svh] w-full overflow-hidden bg-[#0A0A0A] text-slate-100">
      {/* full-bleed background gradients (match docs + homepage) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-64 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,_rgba(45,212,191,0.45),_transparent_65%)] opacity-80" />
        <div className="absolute -bottom-40 left-[-10rem] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle_at_center,_rgba(236,72,153,0.45),_transparent_70%)] opacity-80" />
        <div className="absolute -bottom-56 right-[-12rem] h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle_at_center,_rgba(56,189,248,0.5),_transparent_70%)] opacity-80" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(148,163,184,0.18),transparent_60%)] opacity-40" />
      </div>

      {/* subtle center line */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-emerald-400/0 via-emerald-400/25 to-transparent"
      />

      <div className="relative mx-auto flex min-h-[100svh] w-full max-w-5xl flex-col space-y-10 px-4 pb-20 pt-24 sm:px-6 lg:px-8 lg:pb-24 lg:pt-28">
        {/* HERO */}
        <section className="space-y-5 text-center md:text-left">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-4">
              <GradientH1>mojo pro subscription</GradientH1>
              <p className="max-w-2xl text-sm text-slate-300 sm:text-base">
                Mojo Pro is the mojomaxi power tier — bigger baskets, faster cadences,
                P+L share cards, manual swaps, and support for more token types on Solana, all on
                top of the same keyless, non-custodial anchor vault architecture.
              </p>
            </div>
            <div className="flex flex-col items-center gap-2 text-xs text-slate-300 sm:items-end">
              <div className="rounded-full border border-white/15 bg-white/5 px-3 py-1">
                <span className="mr-1 text-[0.7rem] uppercase tracking-[0.18em] text-white/60">
                  docs hub
                </span>
                <Link
                  href="/help"
                  className="text-[0.75rem] font-medium text-emerald-300 hover:text-emerald-200"
                >
                  back to help &amp; docs
                </Link>
              </div>
              <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[0.7rem] uppercase tracking-[0.16em] text-emerald-100">
                advanced automation • same vault safety
              </div>
            </div>
          </div>
        </section>

        {/* SUMMARY + PRICING */}
        <section className="grid gap-5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <Card className="border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-slate-100">
                why subscribe to mojo pro?
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-200">
              <p>Mojo Pro unlocks the full automation toolkit:</p>
              <ul className="mt-3 grid gap-2 text-xs text-emerald-200 sm:grid-cols-2">
                <li className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 px-3 py-2">
                  portfolio-style P+L share cards
                </li>
                <li className="rounded-lg border border-sky-400/30 bg-sky-500/5 px-3 py-2">
                  xxl rebalance baskets (up to 20 tokens)
                </li>
                <li className="rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/5 px-3 py-2">
                  token2022 token support across all bots
                </li>
                <li className="rounded-lg border border-white/20 bg-white/5 px-3 py-2">
                  1hr rebalance cadence
                </li>
                                <li className="rounded-lg border border-white/20 bg-white/5 px-3 py-2">
                  manual swaps on webhooks bot
                </li>
              </ul>
              <div className="mt-8 flex w-full justify-center opacity-90">
  <div className="relative h-28 w-28">
    <Image
      src="/brand/mojopro-128.png"
      alt="Mojo Pro badge"
      fill
      sizes="112px"
      className="object-contain drop-shadow-lg"
      priority
    />
  </div>
</div>
            </CardContent>
          </Card>

          <Card className="border-emerald-400/40 bg-emerald-500/5 shadow-[0_22px_80px_rgba(16,185,129,0.5)] backdrop-blur-xl">
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-col gap-1 text-sm font-semibold text-emerald-100">
                <div className="flex items-center justify-between">
                  <span>mojo pro subscription</span>
                  <span className="rounded-full border border-emerald-400/40 bg-emerald-500/20 px-2 py-0.5 text-[0.65rem] uppercase tracking-[0.18em] text-emerald-100">
                    usdc-based
                  </span>
                </div>
                <div className="text-[0.7rem] font-normal uppercase tracking-[0.16em] text-emerald-200">
                  {walletAddr ? statusLine : "connect your wallet to see status"}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-100">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold text-emerald-300">
                  $20
                </span>
                <span className="text-xs uppercase tracking-[0.16em] text-emerald-200">
                  per 30 days of service (usdc)
                </span>
              </div>

              <div className="rounded-lg border border-emerald-400/30 bg-black/30 px-3 py-2 text-xs text-slate-200">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      className="h-7 rounded-lg border border-white/20 bg-black/60 px-2 text-xs text-white hover:border-emerald-300 hover:bg-emerald-500/20"
                      onClick={() => bumpAmount(-20)}
                      disabled={loading}
                    >
                      – 20
                    </Button>
                    <div className="rounded-lg border border-white/15 bg-black/60 px-3 py-1 font-mono text-sm text-emerald-200">
                      ${currentAmountDisplay}
                    </div>
                    <Button
                      size="sm"
                      className="h-7 rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-2 text-xs text-white hover:border-emerald-300 hover:bg-emerald-500/40"
                      onClick={() => bumpAmount(20)}
                      disabled={loading}
                    >
                      + 20
                    </Button>
                  </div>
                  <div className="text-[0.7rem] text-emerald-200 text-left sm:text-right">
                    {daysText
                      ? `${daysText} of mojo pro at ${currentAmountDisplay} USDC`
                      : "set amount in 20 USDC steps"}
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-2 text-[0.65rem] uppercase tracking-[0.16em]">
                  {walletAddr && (
                    <span className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-emerald-100">
                      {status?.active
                        ? `active · expires ${fmtDate(status.expiresAt)}`
                        : "not active"}
                    </span>
                  )}
                  {daysPurchasePill && (
                    <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 text-white/70">
                      {daysPurchasePill}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-200">
                <div className="flex items-center justify-between">
                  <span className="text-[0.7rem] uppercase tracking-[0.16em] text-white/60">
                    total paid (lifetime)
                  </span>
                  <span className="font-mono text-[0.75rem] text-emerald-200">
                    {totalPaidDisplay}
                  </span>
                </div>
                <p className="mt-1 text-[0.7rem] text-white/50">
                  Total USDC this wallet has sent to the subscription treasury.
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  className="flex-1 rounded-xl bg-emerald-500 text-white hover:bg-emerald-400 disabled:opacity-60"
                  disabled={!walletAddr || loading}
                  onClick={multiTriggerPay}
                  onTouchStart={multiTriggerPay}
                  onPointerDown={multiTriggerPay}
                  onTouchEnd={multiTriggerPay}
                  onPointerUp={multiTriggerPay}
                  style={{ touchAction: "manipulation" }}
                >
                  {loading
                    ? "processing…"
                    : walletAddr
                    ? "subscribe / extend (usdc)"
                    : "connect wallet to subscribe"}
                </Button>
              </div>

              {error && (
                <p className="mt-1 text-[0.7rem] text-red-400">{error}</p>
              )}

              <p className="text-[0.7rem] text-white/55">
                Subscriptions are paid in USDC from your connected wallet via a
                normal on-chain transfer.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* FEATURES GRID */}
        <section className="space-y-4">
          <SectionHeading kicker="what you unlock" title="mojo pro feature set" />
          <div className="grid gap-5 md:grid-cols-2">
            <Card className="border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-slate-100">
                  enhanced bot analytics &amp; token support
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-slate-200">
                <ul className="space-y-2 text-xs sm:text-sm">
                  <li>
                    <span className="font-semibold text-emerald-200">
                      all bots: P+L share card
                    </span>{" "}
                    — see portfolio-style performance cards across your bots
                    instead of raw event streams.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-200">
                      all bots: token2022 trades enabled
                    </span>{" "}
                    — opt into token2022-based flows (such as XStocks and Pump)
                    via the same mojomaxi vault wiring.
                  </li>
                                    <li>
                    <span className="font-semibold text-emerald-200">
                      webhooks: manual swaps
                    </span>{" "}
                    swap tokens with the click of a button in case you need to take the wheel for a bit or track P+L on your manual trades with ease.
                  </li>
                </ul>
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-slate-100">
                  rebalance &amp; community perks
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-slate-200">
                <ul className="space-y-2 text-xs sm:text-sm">
                  <li>
                    <span className="font-semibold text-emerald-200">
                      rebalance: up to 20 tokens
                    </span>{" "}
                    — express more diversified, multi-asset ideas inside a
                    single Rebalance Basket.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-200">
                      rebalance: 1 hour cadence
                    </span>{" "}
                    — run tighter, rule-based adjustments when the market moves
                    quickly.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-200">
                      community: aristocat discord role
                    </span>{" "}
                    — dedicated role, early feature discussions, and closer
                    feedback loops with the team.
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </main>
  );
}
