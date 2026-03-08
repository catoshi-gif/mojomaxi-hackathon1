// filepath: src/app/help/rebalance/page.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Rebalance Basket Bot — dedicated docs page.
 * - Contains full content from original /help rebalance section + shared tips card.
 * - Preserves lightbox, gradients, and tone.
 * - Adds a hero video walkthrough embed.
 */

function GradientH1({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
      <span className="bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-300 bg-clip-text text-transparent">
        {children}
      </span>
    </h1>
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
      <h2 className="text-2xl font-semibold sm:text-3xl">
        <span className="bg-gradient-to-r from-pink-500 via-fuchsia-500 to-pink-400 bg-clip-text text-transparent">
          {title}
        </span>
      </h2>
    </div>
  );
}

export default function RebalanceDocsPage() {
  const [lightbox, setLightbox] = React.useState<null | { src: string; alt: string; caption?: string }>(null);

  const rebalanceCaption = "Rebalance basket bot setup — select tokens, create vault, pick cadence, start bot";

  React.useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = original;
    };
  }, [lightbox]);

  return (
    <main className="mm-full-bleed relative isolate min-h-[100svh] w-full overflow-hidden bg-[#0A0A0A] text-slate-100">
      {/* background gradients */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-64 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(45,212,191,0.45),transparent_65%)] opacity-80" />
        <div className="absolute -bottom-40 left-[-10rem] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle_at_center,rgba(236,72,153,0.45),transparent_70%)] opacity-80" />
        <div className="absolute -bottom-56 right-[-12rem] h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.5),transparent_70%)] opacity-80" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(148,163,184,0.18),transparent_60%)] opacity-40" />
      </div>

      {/* center line */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-emerald-400/0 via-emerald-400/25 to-transparent"
      />

      <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-24 sm:px-6 lg:px-8 lg:pb-24 lg:pt-28 space-y-10">
        {/* breadcrumb */}
        <div className="text-sm text-white/60">
          <Link href="/help" className="underline underline-offset-4">
            help
          </Link>{" "}
          / rebalance basket bot
        </div>

        {/* HERO + VIDEO */}
        <section className="space-y-4">
          <GradientH1>Rebalance Basket Bot</GradientH1>
          <p className="text-sm text-slate-300 sm:text-base max-w-3xl">
            Build a custom basket of <strong>2–6 tokens</strong> (SOL enforced as token 1 for routing purposes) (select up to 20 tokens with an active Mojo Pro subscription), pick a cadence (
            <strong>2h</strong>, <strong>6h</strong>, <strong>12h</strong>, or <strong>24h</strong>), (1h enabled with pro) and let mojomaxi
            aim to keep positions roughly equal in <strong>USD value</strong> (within a ~$5 price target across all pairs). a keyless anchor vault (PDA) holds funds; our relayer funds all gas fees. you can pause or withdraw at any time, and every rebalance is visible in{" "}
            <strong>Activity</strong>.
          </p>

          {/* Video walkthrough */}
          <Card className="mt-4 border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
            <CardContent className="pt-4">
              <div className="mb-3 text-xs uppercase tracking-[0.16em] text-white/60">
                Video walkthrough with Seb Monty
              </div>
              <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-white/10 bg-black/70">
                <iframe
                  src="https://www.youtube.com/embed/SeDk3EIE5r0"
                  title="Rebalance Basket Bot walkthrough by Seb Monty"
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              </div>
              <p className="mt-3 text-xs text-white/60">
                full walkthrough on creating a rebalance set, funding the vault, and understanding cadence-based swaps.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* MAIN DOCS CARD */}
        <section className="space-y-4">
          <SectionHeading kicker="docs" title="how it works & setup" />
          <Card className="border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
            <CardContent className="space-y-6 pt-6">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {/* how it works & setup */}
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                    Steps to get started
                  </h3>
                  <ol className="list-decimal space-y-2 pl-6 text-sm text-white/80">
                    <li>
                      go to{" "}
                      <Link href="/app" className="underline underline-offset-4">
                        /app
                      </Link>{" "}
                      and connect your wallet.
                    </li>
                    <li>
                      create a <strong>Rebalance Basket</strong>, choose <strong>2–6</strong> SPL token mints (up to 20 with Mojo Pro + enables Token2022 mints),
                      and pick a cadence (2/6/12/24h) (1h cadence with Mojo Pro).
                    </li>
                    <li>
                      create the <strong>Vault</strong> for that set (one vault per set). at least $100 worth of SOL must be deposited into the vault
                      our relayer pays all gas fees and our 0.25% per swap fee allows for this.
                    </li>
                    <li>
                      *deposit only via the mojomaxi dashboard do not try to manually send tokens to a vault address!
                    </li>
                    <li>
                      click <strong>Start</strong>. on each cadence tick, the bot uses Jupiter swaps to move holdings
                      back toward equal USD weights across your tokens (within a $5 margin only if a swap is at least $5 to keep all balanced).
                    </li>
                    <li>
                      click <strong>Stop</strong> to stop the bot from rebalancing.
                    </li>
                    <li>
                      use <strong>Withdraw all</strong> to send the vault&apos;s full balance back to your wallet
                      when you&apos;re done. (unwrap SOL via the dropdown menu in the upper right if you receive WSOL)
                    </li>
                  </ol>
                </div>

                {/* Screenshot + cadence note */}
                <div className="space-y-4">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-6">
                    <button
                      type="button"
                      onClick={() =>
                        setLightbox({
                          src: "/assets/rebalancebot.webp",
                          alt: "Rebalance basket bot setup — select tokens, create vault, pick cadence, start bot",
                          caption: rebalanceCaption,
                        })
                      }
                      className="group relative aspect-[16/9] w-full overflow-hidden rounded-lg border border-white/10 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
                    >
                      <Image
                        src="/assets/rebalancebot.webp"
                        alt="Rebalance basket bot setup — select tokens, create vault, pick cadence, start bot"
                        fill
                        className="object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                        sizes="(min-width: 1024px) 1024px, 100vw"
                      />
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                      <div className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70">
                        Click to expand
                      </div>
                    </button>
                    <div className="mt-2 text-center text-xs text-white/50">
                      {rebalanceCaption}
                    </div>
                  </div>
                  <p className="text-xs text-white/70">
                    cadence is approximate; allow a few minutes after the scheduled time for on-chain
                    conditions, cron-job, site traffic, to process your scheduled rebalance. Rebalances will skip if the full balance of the vault does not allow for at least a single $5 target swap to occur. It will keep checking at each cadence time until all conditions are met befor the next rebalance. 
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* shared tips card (applies to both bots) */}
          <Card className="border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">
                Tips, limits &amp; notes (applies to both bots)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-white/80">
              <ul className="list-disc space-y-2 pl-6">
                <li>
                  Vaults are <strong>permissionless with self-custody withdrawals</strong>. You never deposit into a
                  centralized or hosted exchange wallet; only the vault admin (ie: YOU) can withdraw, and only to your wallet’s
                  canonical ATAs for the mints configured in that set.
                </li>
                <li>
                  Always deposit via the mojomaxi dashboard. Manual transfers directly to a vault address may not be
                  recognized by the program and might not be recoverable. Withdrawals only return assets held in the
                  vault’s program-owned token accounts for your selected mints.
                </li>
                <li>
                  Swaps are executed via <strong>Jupiter</strong> using best-available routing based on current markets and our strict vault security conditions.
                  Some tokens may have limited route liquidity; in those cases, pathing is best-effort.
                </li>
                <li>
                  a small platform fee of <strong>0.25% (25 bps)</strong> is taken on token swaps only and directed to
                  our treasury wallet{" "}
                  <span className="font-mono text-[12px]">
                    5mEqxr6McBRL5DGE9dJ2Td3viwhAmRpe4V7pqGTPMtvr
                  </span>
                  .
                </li>
                <li>
                  your vault does not pay SOL gas fees, all gas fees are covered by
                  our relayer{" "}
                  <span className="font-mono text-[12px]">
                    6sHBrwXdSSAyHHCtqxqTSYA6uovGjxuRfLnfESDxdeBZ
                  </span>
                  . the gas fees we pay are made sustainable via our 0.25% treasury swap fee.
                </li>
                <li>
                  the <strong>Activity</strong> panel shows rebalances, deposits, and withdrawals so you can
                  track everything on-chain.
                </li>
                <li>
                  <strong>Supported tokens:</strong> SPL (Token Program) only for free accounts. Token-2022 extensions are supported with an active Mojo Pro account subscription ($20 per month).
                </li>
              </ul>
            </CardContent>
          </Card>
        </section>

        {/* support footer */}
        <div className="text-sm text-white/60">
          For help with a specific set or feedback, open a ticket in discord with your wallet, Set ID, and a brief
          description of what you&apos;re seeing. (Our moderators will never message you, never share sensitive information like seed phrases with anyone ever)
        </div>
      </div>

      {/* Lightbox modal for screenshots */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.alt}
        >
          <div
            className="relative w-full max-w-5xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightbox(null)}
              className="absolute right-3 top-3 z-10 rounded-full border border-white/30 bg-black/70 px-3 py-1 text-xs text-white/80 hover:bg-black"
            >
              Close ✕
            </button>
            <div className="relative w-full aspect-[16/9] max-h-[80vh] overflow-hidden rounded-xl border border-white/20 bg-black/80">
              <Image
                src={lightbox.src}
                alt={lightbox.alt}
                fill
                className="object-contain"
                sizes="100vw"
                priority
              />
            </div>
            {lightbox.caption && (
              <div className="mt-3 text-center text-xs text-white/70">
                {lightbox.caption} — press <span className="font-mono">Esc</span> or click outside to close
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
