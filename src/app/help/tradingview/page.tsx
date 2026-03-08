// filepath: src/app/help/tradingview/page.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * TradingView Webhooks Bot — dedicated docs page.
 * - Contains full content from original /help TradingView section.
 * - Preserves lightbox, gradients, and copy structure.
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

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md bg-white/10 px-2 py-1 font-mono text-[12px] text-white">
      {children}
    </code>
  );
}

function MonoBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-auto rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-white/90">
      {children}
    </pre>
  );
}

export default function TVDocsPage() {
  const [lightbox, setLightbox] = React.useState<null | { src: string; alt: string; caption?: string }>(null);

  const tvCaption = "webhooks bot setup — set, vault, deposit, alerts, start";

  React.useEffect(() => {
    if (!lightbox) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKeyDown);
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
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
          / tradingview webhooks bot
        </div>

        {/* HERO + INTRO + VIDEO */}
        <section className="space-y-4">
          <GradientH1>TradingView Webhooks Bot</GradientH1>
          <p className="text-sm text-slate-300 sm:text-base max-w-3xl">
            connect your TradingView alerts directly to a non-custodial vault on Solana. each Webhooks Set has its own
            program-derived keyless anchor vault permanently bound to the token pair you choose, swaps are executed via Jupiter&apos;s on-chain aggregator
            when your alerts fire. (you can manually execute swaps with a Mojo Pro subscription in the webhooks panel for added flexibility)
          </p>

          {/* Video walkthrough */}
          <Card className="mt-4 border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
            <CardContent className="pt-4">
              <div className="mb-3 text-xs uppercase tracking-[0.16em] text-white/60">
                Video walkthrough with Seb Monty
              </div>
              <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-white/10 bg-black/70">
                <iframe
                  src="https://www.youtube.com/embed/Qkl5z0er2Ek"
                  title="TradingView Webhooks Bot walkthrough by Seb Monty"
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              </div>
              <p className="mt-3 text-xs text-white/60">
                Step-by-step screen share on creating a set, wiring alerts, and watching swaps land in your vault.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* MAIN DOCS CARD */}
        <section className="space-y-4">
          <SectionHeading kicker="docs" title="how it works" />
          <Card className="border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
            <CardContent className="space-y-6 pt-6">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                {/* key mechanics */}
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                    key mechanics
                  </h3>
                  <ul className="list-disc space-y-2 pl-6 text-sm text-white/80">
                    <li>
                      each wallet can create up to <strong>six bots</strong>; every set has its own Anchor vault
                      PDA and is isolated with its own P+L tracking in the metrics panel so you know exactly how your strategies are performing.
                    </li>
                    <li>
                      each set is locked to a fixed <strong>Token A</strong> (asset to buy (usually a coin with volatility like SOL)) and{" "}
                      <strong>Token B</strong> (asset to sell/hold (usually a stablecoin like USDC)) pair for safety, once you create the vault tokens become immutable for security.
                    </li>
                    <li>
                      your unique <strong>BUY</strong> and <strong>SELL</strong> webhook URLs receive TradingView
                      alerts; mojomaxi validates the Set ID and issues CPI swaps via Jupiter routing.
                    </li>
                    <li>
                      our relayer signs the CPI and pays SOL gas fees; all funds stay in your vault the entire time, and all
                      events show up in the <strong>Activity</strong> panel. the relayer can only execute swaps in your vault, neither the relayer nor Jupiter can ever remove funds from your vault.
                    </li>
                  </ul>
                </div>

                {/* TradingView setup */}
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                    TradingView setup
                  </h3>
                  <ol className="list-decimal space-y-2 pl-6 text-sm text-white/80">
                    <li>
                      in TradingView, open your chart at your desired timeframe and click{" "}
                      <strong>Alerts. NOTE: we do not currently support timeframes under 1 Minute!</strong>
                    </li>
                    <li>
                      configure your alert: choose your indicator/condition, set trigger to{" "}
                      <strong>&quot;Once per bar close&quot;</strong>, set an expiration, and give the alert a
                      descriptive name (so you can easily find it in your TV alerts panel).
                    </li>
                    <li>
                      enable <strong>Webhook URL</strong> and paste the unique <strong>BUY</strong> or{" "}
                      <strong>SELL</strong> webhook URL from your mojomaxi Webhooks Set.
                    </li>
                    <li>
                      use the URLs from your set:
                      <div className="mt-2 space-y-1 pl-2">
                        <div>
                          <Code>https://www.mojomaxi.com/buy/&lt;your_set_token&gt;</Code>
                        </div>
                        <div>
                          <Code>https://www.mojomaxi.com/sell/&lt;your_set_token&gt;</Code>
                        </div>
                      </div>
                    </li>
                    <li>the alert message/body can be empty or you can put any additional info in there for your own notes.</li>
                    <li>
                      save the alert, wait for it to trigger, and confirm the event appears in your mojomaxi{" "}
                      <strong>Activity</strong> feed.
                    </li>
                    <li>
                      create a second alert for the opposite side. each Webhooks Set should have <strong>two</strong>{" "}
                      alerts in TradingView: one for the BUY Webhook URL and one for the SELL Webhook URL.
                    </li>
                  </ol>
                </div>
              </div>

              {/* example block */}
              <MonoBlock>
{`# example:
Wallet: MVxq8pn8assS3Zocog0sie0sau6oum3fzEwCsZixXC2
Set ID: 1bn09b28346a81dc7dc863e2e252925x
Vault:  FyPpCbsMCegwtncbwGGDMkP6E5jeHWK9XTGSFcce9cXp

Buy URL:  https://www.mojomaxi.com/buy/607f0xd4b6a18b02
Sell URL: https://www.mojomaxi.com/sell/507f04d4f6a18bw8
Notes:    BUY swaps Token B -> Token A, SELL swaps Token A -> Token B via Jupiter routing. (mojomaxi takes a small 0.25% swap fee on each swap`}
              </MonoBlock>

              <div className="grid gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                {/* Screenshot (click to expand) */}
                <div className="rounded-xl border border-white/10 bg-white/5 p-6">
                  <button
                    type="button"
                    onClick={() =>
                      setLightbox({
                        src: "/assets/tvwebhooksbot.webp",
                        alt: "TradingView webhooks bot setup — Create Set, create vault, deposit, connect alerts, start bot",
                        caption: tvCaption,
                      })
                    }
                    className="group relative aspect-[16/9] w-full overflow-hidden rounded-lg border border-white/10 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
                  >
                    <Image
                      src="/assets/tvwebhooksbot.webp"
                      alt="TradingView webhooks bot setup — Create Set, create vault, deposit, connect alerts, start bot"
                      fill
                      className="object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                      sizes="(min-width: 1024px) 1024px, 100vw"
                    />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                    <div className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70">
                      click to expand
                    </div>
                  </button>
                  <div className="mt-2 text-center text-xs text-white/50">{tvCaption}</div>
                </div>

                {/* In-app setup steps */}
                <div className="space-y-3 text-sm text-white/80">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                    mojomaxi setup
                  </h4>
                  <ol className="list-decimal space-y-2 pl-6">
                    <li>
                      go to{" "}
                      <Link href="/app" className="underline underline-offset-4">
                        /app
                      </Link>{" "}
                      and connect your wallet.
                    </li>
                    <li>
                      click <strong>Create Webhooks bot</strong> and choose <strong>Token A</strong> (asset you want to buy usually a coin with volatility) and{" "}
                      <strong>Token B</strong> (asset you hold/quote, usually a stablecoin).
                    </li>
                    <li>
                      create the <strong>Vault</strong> for that set (one vault per set). this locks the Token A/B pair
                      for that Webhooks Set.
                    </li>
                    <li>
                      deposit <strong>Token B</strong> into the vault via the inline vault panel.
                    </li>
                    <li>
                      copy your set&apos;s <strong>BUY</strong> and <strong>SELL</strong> webhook URLs into TradingView
                      alerts as described above. Create one alert for the BUY signal and one alert for the SELL signal.
                    </li>
                    <li>
                      click <strong>Start</strong> to run the bot (when bot is in a status of 'Running' mojomaxi is listening for your signals from TradingView. watch the <strong>Activity</strong> panel for swaps
                      when your alerts fire.
                    </li>
                    <li>
                      to stop the bot, click <strong>Stop</strong>. you can <strong>Withdraw</strong> whenever the vault has a
                      balance and the bot is not running.
                    </li>
                  </ol>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* support footer */}
        <div className="text-sm text-white/60">
          need help with a specific set or alert? open a support ticket in our Discord and include your wallet, Set ID,
          and a short description of what happened (we will never DM you and be sure never to share your seed phrase with anyone). We cannot ever access your funds but we can guide you on how to use the bots.
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
