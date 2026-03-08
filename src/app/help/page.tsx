// filepath: src/app/help/page.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * /help — docs hub.
 * - High-level overview of mojomaxi bots + safety.
 * - Links out to focused sub-pages (TradingView, Rebalance, Architecture, FAQ, Transparency).
 * - Reuses the same gradients / glass aesthetic as the original single-page docs.
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

function SecondaryLinkButton({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  // Matches Button variant="secondary" visual style (without requiring asChild support).
  return (
    <Link
      href={href}
      className={[
        "inline-flex items-center justify-center gap-2",
        "rounded-2xl border",
        "px-3.5 min-h-[44px] h-9 sm:h-10 text-sm font-medium",
        "transition duration-200",
        "active:translate-y-[0.5px]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/40",
        "border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

function LegalCard() {
  return (
    <Card className="border-white/10 bg-white/5">
      <CardHeader>
        <CardTitle>Legal</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <SecondaryLinkButton href="/privacy">Privacy</SecondaryLinkButton>
        <SecondaryLinkButton href="/terms">Terms</SecondaryLinkButton>
        <SecondaryLinkButton href="/transparency">Transparency</SecondaryLinkButton>
      </CardContent>
    </Card>
  );
}

export default function HelpHubPage() {
  const router = useRouter();

  return (
    <main className="mm-full-bleed relative isolate min-h-[100svh] w-full overflow-hidden bg-[#0A0A0A] text-slate-100">
      {/* full-bleed background gradients (match homepage) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-64 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,_rgba(45,212,191,0.45),_transparent_65%)] opacity-80" />
        <div className="absolute -bottom-40 left-[-10rem] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle_at_center,_rgba(236,72,153,0.45),_transparent_70%)] opacity-80" />
        <div className="absolute -bottom-56 right-[-12rem] h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle_at_center,_rgba(56,189,248,0.5),_transparent_70%)] opacity-80" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(148,163,184,0.18),transparent_60%)] opacity-40" />
      </div>

      {/* subtle center line (Solana-style) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-emerald-400/0 via-emerald-400/25 to-transparent"
      />

      <div className="relative mx-auto flex min-h-[100svh] w-full max-w-6xl flex-col space-y-12 px-4 pb-20 pt-24 sm:px-6 lg:px-8 lg:pb-24 lg:pt-28">
        {/* HERO */}
        <section className="grid items-center gap-10 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="space-y-5 text-center md:text-left">
            <GradientH1>Help &amp; Docs</GradientH1>
            <p className="text-sm text-slate-300 sm:text-base">
              Effortlessly automate your portfolio with custom TradingView webhooks and Rebalancing Baskets, backed by secure, keyless, non-custodial anchor vaults on Solana.
            </p>

            {/* Quick nav to sub-pages */}
            <nav className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-slate-200 sm:justify-start sm:text-sm">
              <span className="mr-1 rounded-full border border-white/10 px-3 py-1 text-[0.7rem] uppercase tracking-[0.18em] text-white/60">
                Go to
              </span>
              <Link
                href="/help/tradingview"
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 hover:border-emerald-400/80 hover:bg-emerald-500/10"
              >
                TradingView Webhooks Bot
              </Link>
              <Link
                href="/help/rebalance"
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 hover:border-emerald-400/80 hover:bg-emerald-500/10"
              >
                Rebalance Basket Bot
              </Link>
              <Link
                href="/help/architecture"
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 hover:border-emerald-400/80 hover:bg-emerald-500/10"
              >
                Vault Architecture &amp; Safety
              </Link>
              <Link
                href="/help/faq"
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 hover:border-emerald-400/80 hover:bg-emerald-500/10"
              >
                FAQ
              </Link>
            </nav>

            {/* Seeker/store compliance links */}
            <div className="pt-2 md:max-w-md">
              <LegalCard />
            </div>
          </div>

          <div className="relative">
            <div className="absolute inset-0 -z-10 rounded-3xl bg-gradient-to-b from-fuchsia-500/20 via-sky-400/10 to-emerald-400/10 blur-2xl" />
            <div className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_0_0_1px_rgba(255,255,255,.05)_inset]">
              <div className="flex items-center gap-3">
                <div className="relative h-10 w-10 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                  <Image src="/icon-192.png" alt="mojomaxi" fill className="object-cover" />
                </div>
                <div>
                  <div className="text-sm font-semibold">mojomaxi</div>
                  <div className="text-xs text-white/60">Docs hub · safety · support</div>
                </div>
              </div>

              <div className="mt-5 grid gap-2">
                <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                  <div className="text-xs uppercase tracking-widest text-white/60">Fast path</div>
                  <div className="mt-1 text-sm font-medium text-slate-100">Get a bot running in 2 minutes</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => router.push("/webhooks")}
                      className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-100 hover:border-emerald-400/40 hover:bg-emerald-500/15"
                    >
                      TradingView Webhooks
                    </button>
                    <button
                      onClick={() => router.push("/rebalance")}
                      className="rounded-2xl border border-fuchsia-400/20 bg-fuchsia-500/10 px-3 py-2 text-xs font-semibold text-fuchsia-100 hover:border-fuchsia-400/40 hover:bg-fuchsia-500/15"
                    >
                      Rebalance Baskets
                    </button>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                  <div className="text-xs uppercase tracking-widest text-white/60">Need help?</div>
                  <div className="mt-1 text-sm font-medium text-slate-100">Read the FAQ and transparency notes</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link
                      href="/help/faq"
                      className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 hover:bg-white/10"
                    >
                      FAQ
                    </Link>
                    <Link
                      href="/transparency"
                      className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 hover:bg-white/10"
                    >
                      Transparency
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* MAIN CARDS */}
        <section className="grid gap-6 md:grid-cols-2">
          <Card className="border-white/10 bg-white/5">
            <CardHeader>
              <CardTitle>TradingView Webhooks Bot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-200">
              <p>
                Configure TradingView alerts to automatically execute swaps via your non-custodial vault. You stay in control — Mojomaxi routes trades only when your webhook fires.
              </p>
              <div>
                <Link
                  href="/help/tradingview"
                  className="inline-flex items-center gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-100 hover:border-emerald-400/40 hover:bg-emerald-500/15"
                >
                  Read docs →
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5">
            <CardHeader>
              <CardTitle>Rebalance Basket Bot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-200">
              <p>
                Maintain target portfolio allocations across multiple tokens. Mojomaxi computes the delta and executes the minimum required swaps to rebalance.
              </p>
              <div>
                <Link
                  href="/help/rebalance"
                  className="inline-flex items-center gap-2 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-500/10 px-3 py-2 text-xs font-semibold text-fuchsia-100 hover:border-fuchsia-400/40 hover:bg-fuchsia-500/15"
                >
                  Read docs →
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5">
            <CardHeader>
              <CardTitle>Vault Architecture</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-200">
              <p>
                Learn how Mojomaxi vaults work, how swaps are signed, and why your funds remain non-custodial.
              </p>
              <div>
                <Link
                  href="/help/architecture"
                  className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 hover:bg-white/10"
                >
                  Read docs →
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5">
            <CardHeader>
              <CardTitle>Transparency</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-200">
              <p>
                Fees, trust assumptions, and operational notes — the things you should know before running automated strategies.
              </p>
              <div>
                <Link
                  href="/transparency"
                  className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 hover:bg-white/10"
                >
                  Read →
                </Link>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* FOOTER */}
        <footer className="pt-6 text-center text-xs text-white/45">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/privacy" className="hover:text-white/70">Privacy</Link>
            <span className="text-white/20">•</span>
            <Link href="/terms" className="hover:text-white/70">Terms</Link>
            <span className="text-white/20">•</span>
            <Link href="/transparency" className="hover:text-white/70">Transparency</Link>
          </div>
          <div className="mt-2">© {new Date().getFullYear()} mojomaxi</div>
        </footer>
      </div>
    </main>
  );
}
