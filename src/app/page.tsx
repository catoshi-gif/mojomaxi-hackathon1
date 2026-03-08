// filepath: src/app/page.tsx
"use client";

import Image from "next/image";
import * as React from "react";
import CardCornerArt from "@/components/CardCornerArt";
import { usePollingGate } from "@/lib/useActivityGate";
import HeroScene from "@/components/HeroScene";
import {
  usePrefersReducedMotion,
  useDocumentVisible,
  useInViewOnce,
  useInViewNow,
  useRafTween,
  easeOutCubic,
} from "@/lib/hooks/useAnimationHooks";


type AnyObj = Record<string, any>;

type HomeWeekPoint = { date: string; running: number; vol24h: number };


function Reveal({
  children,
  className = "",
  delayMs = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delayMs?: number;
}) {
  const { ref, seen } = useInViewOnce<HTMLDivElement>({ rootMargin: "0px 0px -12% 0px", threshold: 0.14 });
  const reduced = usePrefersReducedMotion();

  return (
    <div
      ref={ref}
      className={[
        className,
        "will-change-transform will-change-opacity",
        reduced
          ? ""
          : seen
            ? "opacity-100 translate-y-0"
            : "opacity-0 translate-y-6",
        reduced ? "" : "transition duration-700 ease-out",
      ].join(" ")}
      style={reduced ? undefined : { transitionDelay: `${Math.max(0, delayMs)}ms` }}
    >
      {children}
    </div>
  );
}

export default function Page() {
  const { shouldPoll } = usePollingGate({ idleMs: 60_000 });
  const [runningVaults, setRunningVaults] = React.useState<number | null>(null);
  const [vol24h, setVol24h] = React.useState<number | null>(null);
  const [weekSeries, setWeekSeries] = React.useState<HomeWeekPoint[] | null>(null);

  const { ref: statsRef, seen: statsInView } = useInViewOnce<HTMLDivElement>({
    // require a small scroll before the stats animate in (even on tall viewports)
    rootMargin: "0px 0px -55% 0px",
    threshold: 0.08,
  });

  // Animated (count-up) display values for hero stats (purely UI; no extra polling)
  const runningVaultsAnim = useRafTween(runningVaults ?? 0, {
    durationMs: 900,
    enabled: statsInView && runningVaults !== null,
  });
  const vol24hAnim = useRafTween(vol24h ?? 0, {
    durationMs: 900,
    enabled: statsInView && vol24h !== null,
  });

const reduced = usePrefersReducedMotion();

// Refs for scroll-driven GPU-friendly transforms (avoid rerender-on-scroll)
const bloomNearRef = React.useRef<HTMLDivElement | null>(null);
const bloomDeepRef = React.useRef<HTMLDivElement | null>(null);
const haloRef = React.useRef<HTMLDivElement | null>(null);
const missionRef = React.useRef<HTMLElement | null>(null);
const auroraRef = React.useRef<HTMLHeadingElement | null>(null);

// Scroll-driven transforms (only update styles; no React state)
React.useEffect(() => {
  if (reduced) return;

  let raf = 0;
  let ticking = false;
  let latestY = window.scrollY || 0;

  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

  const apply = () => {
    const y = latestY;

    // Background blooms: subtle parallax during scroll
    const mmT = clamp01(y / 900);
    const g2x = -mmT * 14;
    const g2y = mmT * 10;
    const g3x = mmT * 16;
    const g3y = -mmT * 12;

    if (bloomNearRef.current) {
      bloomNearRef.current.style.transform = `translate3d(${g2x.toFixed(2)}px, ${g2y.toFixed(2)}px, 0)`;
      bloomNearRef.current.style.willChange = "transform";
    }
    if (bloomDeepRef.current) {
      bloomDeepRef.current.style.transform = `translate3d(${g3x.toFixed(2)}px, ${g3y.toFixed(2)}px, 0)`;
      bloomDeepRef.current.style.willChange = "transform";
    }

    // Mission halo: animate only as the user scrolls through the section
    if (missionRef.current && haloRef.current) {
      const rect = missionRef.current.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      // Progress from when section starts entering viewport until it leaves
      const p = clamp01((vh - rect.top) / (vh + rect.height));
      const hx = (p - 0.5) * 18; // -9..+9
      const hy = (0.5 - p) * 14; // +7..-7
      const hs = 1 + p * 0.06; // 1..1.06
      haloRef.current.style.transform = `translate3d(${hx.toFixed(2)}px, ${hy.toFixed(2)}px, 0) scale(${hs.toFixed(4)})`;
      haloRef.current.style.willChange = "transform";
    }

    // Bottom aurora title: scroll-driven gradient drift (no infinite animation)
    if (auroraRef.current) {
      const rect = auroraRef.current.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const p = clamp01((vh - rect.top) / (vh + rect.height));
      // Move background position as you scroll (0% -> 200%)
      const bx = (p * 200).toFixed(1);
      const by = ((1 - p) * 200).toFixed(1);
      auroraRef.current.style.backgroundPosition = `${bx}% ${by}%`;
      auroraRef.current.style.willChange = "background-position";
    }
  };

  const onScroll = () => {
    latestY = window.scrollY || 0;
    if (ticking) return;
    ticking = true;
    raf = requestAnimationFrame(() => {
      ticking = false;
      apply();
    });
  };

  // Initial apply + listeners
  apply();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);

  return () => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    cancelAnimationFrame(raf);
  };
}, [reduced]);

  const fmtUsd = (n?: number | null) => {
    if (!(typeof n === "number" && Number.isFinite(n))) return "—";
    return n >= 1000
      ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  };

  // Poll stats and volume (kept lightweight)
  React.useEffect(() => {
    let cancelled = false;
    let timer: any = null;

    async function loadStats() {
      try {
        const r = await fetch("/api/vaults/stats", { cache: "default" });
        const j = (await r.json().catch(() => null)) as AnyObj | null;
        if (!cancelled && j?.ok) setRunningVaults(Number(j.running || 0));
      } catch {
        // ignore
      }
    }

    async function loadVol() {
      try {
        const r = await fetch("/api/events/volume24h", { cache: "default" });
        const j = (await r.json().catch(() => null)) as AnyObj | null;
        if (!cancelled && j?.ok) setVol24h(Number(j.volumeUsd || 0));
      } catch {
       // ignore
      }
    }

    async function tick() {
      await Promise.allSettled([loadStats(), loadVol()]);
    }

    tick();
    if (shouldPoll) timer = setInterval(tick, 30000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [shouldPoll]);


  // Fetch 7d series (at most one Redis read; daily writes are gated server-side)
  React.useEffect(() => {
    let cancelled = false;
    let timer: any = null;

    async function tick() {
      try {
        const r = await fetch("/api/metrics/home-week", { cache: "default" });
        const j = await r.json();
        if (cancelled) return;
        if (j && j.ok && Array.isArray(j.series)) {
          setWeekSeries(
            j.series
              .map((x: any) => ({
                date: String(x.date || ""),
                running: Number(x.running || 0),
                vol24h: Number(x.vol24h || 0),
              }))
              .filter((x: any) => x.date)
          );
        }
      } catch {
        // noop
      }
    }

    tick();
    // If the tab stays open overnight, refresh occasionally.
    if (shouldPoll) timer = setInterval(tick, 6 * 60 * 60 * 1000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [shouldPoll]);

  return (
    <main className="mm-full-bleed relative isolate sm:-mt-24 min-h-[100svh] w-full overflow-hidden bg-[#0A0A0A] text-slate-100">
{/* full-bleed background gradients (design direction: black base with magenta bloom) */}
<div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
  {/* subtle left haze */}
  <div className="absolute -left-[22rem] top-[-20rem] h-[680px] w-[680px] rounded-full bg-[radial-gradient(circle_at_center,_rgba(253,27,119,0.10),_transparent_70%)] blur-3xl" />
  {/* right magenta bloom */}
  <div
    className="absolute -right-[20rem] top-[-12rem] h-[860px] w-[860px] rounded-full bg-[radial-gradient(circle_at_center,_rgba(253,27,119,0.30),_transparent_66%)] opacity-95 blur-3xl"
    ref={bloomNearRef}
  />
  {/* deeper purple underbloom */}
  <div
    className="absolute -right-[28rem] bottom-[-26rem] h-[1020px] w-[1020px] rounded-full bg-[radial-gradient(circle_at_center,_rgba(227,27,253,0.18),_transparent_72%)] opacity-85 blur-3xl"
    ref={bloomDeepRef}
  />
  {/* vignette */}
  <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_transparent_20%,_rgba(0,0,0,0.74)_78%)]" />
</div>
{/* main content container */}
      <div className="relative mx-auto flex min-h-[100svh] w-full max-w-6xl flex-col px-4 pb-20 pt-20 sm:px-6 sm:pt-20 lg:px-8 lg:pb-24 lg:pt-24">
        {/* HERO */}
        {/* HERO */}
        <section className="relative w-full">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-4 lg:gap-0 lg:grid-cols-2">
            {/* Left: messaging + CTA */}
            <div className="relative z-10 space-y-6 text-center lg:text-left lg:pr-0">
              <h1 className="text-balance text-[clamp(2.05rem,4.0vw,3.3rem)] font-semibold leading-[1.08] tracking-[-0.018em]">
                <span className="block lg:whitespace-nowrap">Onchain automation,</span>
                <span className="mt-2 block">without compromise.</span>
              </h1>

              <p className="mx-auto max-w-[32rem] lg:max-w-[30rem] text-pretty text-[1.0rem] leading-[1.7] text-slate-300/70 lg:mx-0">
                Build non-custodial rebalancing baskets and trigger trades with TradingView webhooks on Solana.
              </p>

              <div className="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
                <a
                  href="/app"
                  className="inline-flex h-9 items-center justify-center rounded-lg bg-[#FD1B77] px-5 text-[0.95rem] font-medium text-white shadow-[0_18px_60px_rgba(253,27,119,0.30)] transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99]"
                >
                  Launch App
                </a>
                <a
                  href="/help"
                  className="inline-flex h-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-5 text-[0.95rem] font-medium text-[#E31BFD]/90 shadow-[0_14px_46px_rgba(0,0,0,0.45)] transition-colors hover:bg-white/[0.06]"
                >
                  Read Docs
                </a>
              </div>
            </div>

            {/* Right: animated hero art */}
            <div className="relative z-0 mx-auto w-full max-w-[520px] sm:max-w-[560px] lg:mx-0 lg:ml-auto lg:max-w-[620px] lg:-translate-x-16 lg:-translate-y-6 lg:scale-[0.92]">
              <HeroScene />
            </div>
          </div>
        </section>

        {/* STATS + SIGNAL PANEL (restored) */}
        <section className="mt-10 w-full">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-start gap-6">
            {/* Left: metrics (24h + 7d) */}
            <Reveal className="w-full" delayMs={60}>
              <div ref={statsRef} className="flex w-full justify-center">
                <div className="w-full max-w-3xl">
                  
                <div className="grid w-full grid-cols-2 gap-3">
                  <StatCard
                    title="Running Vaults"
                    value={statsInView && runningVaults !== null ? String(Math.round(runningVaultsAnim)) : "—"}
                  />
                  <StatCard
                    title="24H Volume"
                    value={statsInView && vol24h !== null ? fmtUsd(vol24hAnim) : "—"}
                  />
                  <StatChartCard
                    series={weekSeries}
                    liveRunning={runningVaults}
                    liveVol24h={vol24h}
                    animate={statsInView}
                  />
                </div>
                <p className="mt-2 text-center text-xs text-slate-400/90">
                  * Stats reflect mojomaxi execution telemetry and may differ from onchain explorers.
                </p>
              </div>
              </div>
            </Reveal>

            {/* Right: signal + 4 cards */}
            <Reveal delayMs={140}>
              <div className="w-full">
                <div className="relative rounded-3xl border border-white/10 bg-white/[0.03] p-5 shadow-[0_24px_120px_rgba(15,23,42,0.95)] backdrop-blur-xl">
                  <div className="mb-4 flex flex-col items-center gap-2 text-center sm:flex-row sm:items-center sm:justify-between sm:text-left">
                    <p className="text-[0.7rem] font-medium uppercase tracking-[0.18em] text-slate-400">
                      built on Solana
                    </p>
                    <div className="flex items-center gap-3 text-xs text-slate-300">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        Running
                      </span>
                    </div>
                  </div>

                  <div className="mt-3">
                    <SignalPath />
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <BubbleV
                      iconSrc="/brand/solana-96.png"
                      iconSrcRight="/brand/jupiter-96.png"
                      dual
                      label="Solana Native • Jupiter Routing"
                      cornerVariant="jupiter"
                      cornerOpacity={0.16}
                      cornerMode="subtle"
                    />
                    <BubbleV
                      chart
                      label="Webhooks or Baskets • Your Onchain Automation Layer"
                      cornerVariant="radar"
                      cornerOpacity={0.16}
                      cornerMode="subtle"
                    />
                    <BubbleV
                      lock
                      label="No Account Required • Up To 6 Bots Per Wallet"
                      cornerVariant="lock"
                      cornerOpacity={0.16}
                      cornerMode="subtle"
                    />
                    <BubbleV
                      clock
                      label="24/7 Execution (0.25% Swap Fee)"
                      cornerVariant="clock"
                      cornerOpacity={0.16}
                      cornerMode="subtle"
                    />
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>



        {/* WHY TRADERS CHOOSE MOJOMAXI */}
        <section className="mm-cv-auto mt-20 border-t border-white/5 pt-12">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="text-center sm:text-left">
              <h2 className="mt-2 text-balance text-2xl font-semibold sm:text-3xl">
                <span className="bg-gradient-to-r from-emerald-400 to-cyan-300 bg-clip-text text-transparent">
                  Why Traders Choose mojomaxi
                </span>
              </h2>
            </div>
            <p className="max-w-md text-sm text-slate-300 text-center sm:text-left mx-auto sm:mx-0">
              Automation without compromise. Designed for onchain power users, desks, DAOs, and curious beginners.
            </p>
          </div>

          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-2">
            {FEATURES.map((f, i) => (
              <Reveal key={i} delayMs={i * 90}>
                <div
                className="group relative overflow-hidden flex flex-col items-center text-center rounded-3xl border border-white/10 bg-white/[0.045] p-7 shadow-[0_24px_120px_rgba(15,23,42,0.92)] backdrop-blur-xl transition-transform hover:-translate-y-1 hover:border-emerald-400/70"
              >
                <CardCornerArt
                  variant={i === 0 ? "anchor" : i === 1 ? "balance" : i === 2 ? "hooks" : "pro"}
                  opacity={0.42}
                  mode="pop"
                  animateOnView
                  rootMargin="0px 0px -12% 0px"
                  className="mix-blend-screen"
                />
                <div className="relative z-10">
                {f.iconSrc ? (
                  <FeatureBadge src={f.iconSrc} alt={f.title} />
                ) : (
                  <GradientEmoji kind={f.emoji} />
                )}
                </div>
                <div className="relative z-10 mt-4 text-lg font-semibold text-slate-100">{f.title}</div>
                <div className="relative z-10 mt-2 text-base font-medium leading-relaxed text-slate-300/90">{f.copy}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* SAMPLE BOT SECTION */}
        <section className="mm-cv-auto mt-20 rounded-[28px] border border-white/10 bg-white/[0.03] px-4 py-6 shadow-[0_24px_120px_rgba(15,23,42,0.95)] backdrop-blur-xl sm:px-6 sm:py-8 lg:px-8">
          <div className="flex flex-col gap-4 text-center sm:flex-row sm:items-center sm:justify-between sm:text-left">
            <div>
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.26em] text-cyan-300/80">
                Sample Bot
              </p>
              <h3 className="mt-2 text-lg font-semibold bg-gradient-to-r from-pink-500 to-violet-500 bg-clip-text text-transparent sm:text-xl">
                Automated Portfolio Rebalancing
              </h3>
            </div>
          </div>

          <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-black/40">
            <Image
              src="/brand/rebalancebot.webp"
              alt="mojomaxi rebalance bot panel"
              width={1920}
              height={980}
              className="h-auto w-full"
              loading="lazy"
            />
          </div>

          <div className="mt-5 grid gap-4 text-sm text-slate-300 text-center sm:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] sm:items-start sm:text-left">
            <div>
              <div className="font-semibold  text-emerald-200">
                Setup Is as Easy as 1-2-3
              </div>
            </div>
            <p className="leading-relaxed">
              Select your tokens and let the bot rebalance on a cadence of your choice.
            </p>
          </div>
        </section>

        {/* MISSION SECTION */}
        <section ref={missionRef} className="mm-cv-auto mt-20">
          <Reveal className="grid items-center gap-10 rounded-[28px] border border-white/10 bg-gradient-to-br from-slate-900/90 via-slate-950/90 to-slate-900/90 px-6 py-10 shadow-[0_24px_120px_rgba(15,23,42,1)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:px-10">

            {/* Text with neon rule */}
            <div className="relative space-y-6 text-center">
              <span
                aria-hidden
                className="absolute -left-4 top-0 h-full w-px rounded-full bg-gradient-to-b from-purple-500 via-fuchsia-500 to-pink-500 opacity-80"
              />
              <div className="space-y-2">
                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.26em] text-purple-200/80">
                  Our Mission
                </p>
                <h2 className="text-[clamp(2rem,4.1vw,2.6rem)] font-extrabold tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-300 bg-clip-text text-transparent">
                  Making automated trading accessible to all.
                </h2>
                <div className="h-[3px] w-28 rounded-full bg-gradient-to-r from-emerald-400/70 to-cyan-300/70 mx-auto" />
              </div>

              <p className="text-sm leading-relaxed text-slate-200">
                We aim to build a flywheel of trust and a growing community of users who are
                passionate about participating in the Solana ecosystem.
              </p>

              <ul className="space-y-3 text-sm text-slate-200">
                {["Enterprise-Grade Tooling Made Easy and Transparent", "Community-Led Testing + Iteration"].map((t, i) => (
                  <li
                    key={i}
                    className="flex items-start justify-center gap-3 lg:justify-start"
                  >
                    <span className="mt-[6px] inline-block h-[12px] w-[12px] rounded-full bg-gradient-to-r from-purple-500 to-fuchsia-500 shadow-[0_0_14px_rgba(168,85,247,0.75)]" />
                    <span className="leading-relaxed">{t}</span>
                  </li>
                ))}
              </ul>

              <p className="text-sm leading-relaxed text-slate-200">
                We believe that if trading is fun and sustainable, we can spark a global onboarding
                movement.
              </p>
            </div>

            {/* Logo with drifting halo */}
            <div className="relative flex items-center justify-center">
              <div
                aria-hidden
                ref={haloRef}
                className="halo absolute -inset-10 -z-10 rounded-[40px] bg-gradient-to-b from-fuchsia-500/30 via-pink-500/20 to-transparent blur-3xl"
              />
              <Image
                src="/brand/mojoinverted.svg"
                alt="mojomaxi logo"
                width={560}
                height={560}
                className="h-auto w-full max-w-[252px] md:max-w-[294px] opacity-95"
                sizes="(max-width: 768px) 70vw, 294px"
                loading="lazy"
              />
            </div>
          </Reveal>
</section>

        {/* SOCIAL CTAS */}
        
        {/* COMMUNITY */}
        <section className="mm-cv-auto mt-16 rounded-[28px] border border-white/10 bg-white/[0.03] px-6 py-6 shadow-[0_24px_120px_rgba(15,23,42,0.95)] backdrop-blur-xl">
          <div className="flex flex-col gap-3 text-center sm:flex-row sm:items-center sm:justify-between sm:text-left">
            <div>
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.26em] text-cyan-300/80">
                Community
              </p>
              <div className="mt-2 text-sm text-slate-300">
                Updates, Education, Vibes and Vaults — Follow Along.
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-8 sm:justify-end">
<SocialGlowButton
            href="https://x.com/yomojomaxi"
            src="/assets/xmojo.webp"
            alt="Follow Mojomaxi on X"
            ariaLabel="Follow Mojomaxi on X"
          />
          <SocialGlowButton
            href="https://discord.gg/PEhUAvp5wF"
            src="/assets/discomojo.webp"
            alt="Join Our Discord"
            ariaLabel="Join Our Discord"
          />
              <SocialGlowButton
            href="https://www.youtube.com/@mojomaxi"
            src="/assets/ytmojo.webp"
            alt="Subscribe to Mojomaxi on YouTube"
            ariaLabel="Subscribe to Mojomaxi on YouTube"
          />
            </div>
          </div>
        </section>

        
        {/* --- Animated gradient callout (bottom) --- */}
        <section className="mx-auto w-full max-w-6xl px-6 pb-8 text-center">
          <h2 ref={auroraRef} className="text-aurora text-[clamp(1.8rem,5.8vw,3.2rem)] font-extrabold tracking-tight">
            Maximize Your Onchain Mojo
          </h2>
          <style jsx global>{`
            .mm-cv-auto {
              content-visibility: auto;
              contain: layout paint style;
              contain-intrinsic-size: 900px;
            }

            .text-aurora {
              background-image: linear-gradient(90deg, #ec4899, #a855f7, #22c55e, #ec4899);
              background-size: 300% 300%;
              background-position: 0% 50%;
              -webkit-background-clip: text;
              background-clip: text;
              color: transparent;
              text-shadow:
                0 0 24px rgba(236, 72, 153, 0.25),
                0 0 32px rgba(139, 92, 246, 0.15);
            }
            @media (prefers-reduced-motion: reduce) {
              .text-aurora {
                text-shadow: none;
              }
            }
          `}</style>
        </section>

{/* FOOTER + DISCLAIMERS */}
        <footer className="mm-cv-auto mt-10 text-center text-xs text-slate-300/80/90">
          <div>© {new Date().getFullYear()} mojomaxi, all rights reserved.</div>
          <DisclaimerBubble title="Disclaimers">
<div>
              Non-custodial vaults: Mojomaxi never holds user assets. Funds stay in program-derived
              vault accounts with no private keys (“keyless PDAs”), restricted by onchain logic.
              Neither Mojomaxi nor the relayer can withdraw; only the user-controlled vault admin
              may withdraw to their canonical ATA as enforced by the program.
            </div>
            <div>
              Infrastructure-only & independence: Mojomaxi is infrastructure-only software. It does
              not provide trading advice, financial recommendations, signals, or investment
              strategies. Members of the Mojomaxi community or team may independently create
              educational content, tools, or TradingView indicators; these are not official
              Mojomaxi products, are not endorsed by the protocol, and are not investment advice.
              Users are responsible for their own trading decisions.
            </div>
            <div>
              Execution & permissions: Swaps are executed by an allow-listed relayer validated
              through the Config PDA. Vault PDAs authorize movements under strict constraints — the
              relayer cannot redirect, access, or withdraw assets.
            </div>
            <div>
              Routing & dependencies: Routing is provided by Jupiter at execution time
              (“best-available routing”). Performance depends on Solana, Jupiter, RPC providers,
              and other network infrastructure.
            </div>
            <div>
              Privacy & transparency: No accounts or signups — everything is wallet-based. Activity
              is public onchain (pseudonymous, not anonymous). The Config PDA, authority, and
              relayer set can be independently verified via our open-source scripts.
            </div>
            <div>
              Risk notice: Onchain automation carries market risk, smart-contract risk, and
              possible loss of funds. Contracts are unaudited. Mojomaxi provides software tools only
              and is not a broker-dealer, adviser, or exchange.
            </div>
          </DisclaimerBubble>
        </footer>
      </div>
    </main>
  );
}


function SignalPath() {
  const reduced = usePrefersReducedMotion();
  const docVisible = useDocumentVisible();
  const { ref, inView } = useInViewNow<HTMLDivElement>({ rootMargin: "120px 0px 120px 0px", threshold: 0.01 });
  return (
    <div ref={ref} className="relative">
      <svg viewBox="0 0 220 70" width="100%" height="70" className="relative block">
        <defs>
          <linearGradient id="mmSig" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(52,211,153,0.9)" />
            <stop offset="50%" stopColor="rgba(34,211,238,0.9)" />
            <stop offset="100%" stopColor="rgba(167,139,250,0.9)" />
          </linearGradient>
        </defs>

        <circle cx="22" cy="35" r="7" fill="rgba(34,211,238,0.95)" />
        <circle cx="112" cy="35" r="7" fill="rgba(52,211,153,0.95)" />
        <circle cx="198" cy="35" r="7" fill="rgba(167,139,250,0.95)" />

        <path
          d="M 22 35 C 55 10, 80 10, 112 35 C 145 60, 168 60, 198 35"
          stroke="url(#mmSig)"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />

        {!reduced && inView && docVisible ? (
          <circle r="4.5" fill="rgba(255,255,255,0.95)">
            <animateMotion
              dur="2.6s"
              repeatCount="indefinite"
              path="M 22 35 C 55 10, 80 10, 112 35 C 145 60, 168 60, 198 35"
              keySplines="0.42 0 0.58 1"
              keyTimes="0;1"
              calcMode="spline"
            />
          </circle>
        ) : null}

        <text x="22" y="62" textAnchor="middle" fontSize="10" fill="rgba(148,163,184,0.85)">
          signal
        </text>
        <text x="112" y="62" textAnchor="middle" fontSize="10" fill="rgba(148,163,184,0.85)">
          vault
        </text>
        <text x="198" y="62" textAnchor="middle" fontSize="10" fill="rgba(148,163,184,0.85)">
          swap
        </text>
      </svg>
    </div>
  );
}

function BubbleV({
  iconSrc,
  iconSrcRight,
  label,
  lock = false,
  clock = false,
  dual = false,
  chart = false,
  cornerVariant,
  cornerOpacity,
  cornerMode,
}: {
  iconSrc?: string;
  iconSrcRight?: string;
  label: string;
  lock?: boolean;
  clock?: boolean;
  dual?: boolean;
  chart?: boolean;
  cornerVariant?: Parameters<typeof CardCornerArt>[0]["variant"];
  cornerOpacity?: number;
  cornerMode?: "subtle" | "pop";
}) {
  return (
    <div className="group relative overflow-hidden flex flex-col items-center gap-2 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.055] via-white/[0.035] to-white/[0.02] px-4 py-5 text-center backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_18px_60px_rgba(15,23,42,0.55)] transition-colors hover:border-emerald-400/80 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_22px_80px_rgba(15,23,42,0.65)] hover:bg-emerald-500/5 before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(600px_circle_at_20%_10%,rgba(236,72,153,0.16),transparent_45%),radial-gradient(520px_circle_at_80%_0%,rgba(34,211,238,0.14),transparent_45%),radial-gradient(520px_circle_at_50%_120%,rgba(52,211,153,0.10),transparent_55%)] before:opacity-70 after:pointer-events-none after:absolute after:inset-0 after:rounded-2xl after:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      {cornerVariant ? (
        <CardCornerArt
          variant={cornerVariant}
          opacity={typeof cornerOpacity === "number" ? cornerOpacity : 0.12}
          mode={cornerMode ?? "subtle"}
          animateOnView
          rootMargin="0px 0px -18% 0px"
          className="mix-blend-screen"
        />
      ) : null}
      {lock ? (
        <svg viewBox="0 0 24 24" width={48} height={48} className="text-white/80">
          <defs>
            <linearGradient id="grad" x1="0" x2="1">
              <stop stopColor="#FD1B77" />
              <stop offset="1" stopColor="#E31BFD" />
            </linearGradient>
          </defs>
          <circle
            cx="12"
            cy="12"
            r="11"
            fill="rgba(255,255,255,0.04)"
            stroke="url(#grad)"
            strokeWidth="1"
          />
          <path
            d="M7 10V8a5 5 0 1110 0v2"
            stroke="url(#grad)"
            strokeWidth="1.5"
            fill="none"
          />
          <rect
            x="4"
            y="10"
            width="16"
            height="10"
            rx="2.5"
            fill="rgba(255,255,255,0.03)"
            stroke="url(#grad)"
            strokeWidth="1"
          />
          <circle cx="12" cy="15" r="1.5" fill="url(#grad)" />
        </svg>
      ) : clock ? (
        <svg viewBox="0 0 24 24" width={48} height={48} className="text-white/80">
          <defs>
            <linearGradient id="grad-clock" x1="0" x2="1">
              <stop stopColor="#FD1B77" />
              <stop offset="1" stopColor="#E31BFD" />
            </linearGradient>
          </defs>
          <circle
            cx="12"
            cy="12"
            r="11"
            fill="rgba(255,255,255,0.04)"
            stroke="url(#grad-clock)"
            strokeWidth="1"
          />
          <path
            d="M12 6v6l4 2"
            stroke="url(#grad-clock)"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : chart ? (
        <svg viewBox="0 0 24 24" width={48} height={48}>
          <defs>
            <linearGradient id="grad-chart" x1="0" x2="1">
              <stop stopColor="#FD1B77" />
              <stop offset="1" stopColor="#E31BFD" />
            </linearGradient>
          </defs>
          <circle
            cx="12"
            cy="12"
            r="11"
            fill="rgba(255,255,255,0.04)"
            stroke="url(#grad-chart)"
            strokeWidth="1"
          />
          <rect
            x="7"
            y="10"
            width="2.5"
            height="6"
            rx="0.8"
            fill="rgba(255,255,255,0.03)"
            stroke="url(#grad-chart)"
            strokeWidth="1.2"
          />
          <rect
            x="11"
            y="8"
            width="2.5"
            height="8"
            rx="0.8"
            fill="rgba(255,255,255,0.03)"
            stroke="url(#grad-chart)"
            strokeWidth="1.2"
          />
          <rect
            x="15"
            y="6"
            width="2.5"
            height="10"
            rx="0.8"
            fill="rgba(255,255,255,0.03)"
            stroke="url(#grad-chart)"
            strokeWidth="1.2"
          />
        </svg>
      ) : dual && iconSrc && iconSrcRight ? (
        <span className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white/5 px-2 py-1">
          <Image
            src={iconSrc}
            alt={label}
            width={38}
            height={38}
            className="h-10 w-10 object-contain"
          />
          <Image
            src={iconSrcRight}
            alt={label}
            width={38}
            height={38}
            className="h-10 w-10 object-contain"
          />
        </span>
      ) : (
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-white/5 p-1">
          <Image
            src={iconSrc!}
            alt={label}
            width={40}
            height={40}
            className="h-10 w-10 object-contain"
          />
        </span>
      )}
      <div className="text-base font-semibold text-slate-100">{label}</div>
    </div>
  );
}


function StatChartCard({
  series,
  liveRunning,
  liveVol24h,
  animate,
}: {
  series: HomeWeekPoint[] | null;
  liveRunning: number | null;
  liveVol24h: number | null;
  animate: boolean;
}) {
  const [mode, setMode] = React.useState<"running" | "volume">("volume");
  const [selectedIdx, setSelectedIdx] = React.useState<number | null>(null);

  const reduced = usePrefersReducedMotion();

  const points = Array.isArray(series) ? series.slice(-7) : [];
  const seriesValues = points.map((p) => (mode === "running" ? p.running : p.vol24h));

  // "Live" value (from lightweight polling used by the headline stats).
  // This renders a dot for today's in-progress value without writing extra DB rows.
  const liveRaw = mode === "running" ? liveRunning : liveVol24h;
  const live = typeof liveRaw === "number" && Number.isFinite(liveRaw) ? liveRaw : NaN;

  const fmt = (n: number) => {
    if (!Number.isFinite(n)) return "—";
    if (mode === "running") return String(Math.round(n));
    return n >= 1000
      ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  };

  // Scale using both the stored series AND the live dot (so the dot never clips).
  const scaleValues = Number.isFinite(live) ? [...seriesValues, live] : seriesValues;
  const min = scaleValues.length ? Math.min(...scaleValues) : 0;
  const max = scaleValues.length ? Math.max(...scaleValues) : 0;

  const W = 520;
  const H = 120;
  const P = 10;
  const baseY = H - P;

  // Chart scaling helpers (also used for the live dot positioning)
  const spanRaw = max - min;
  const span = spanRaw === 0 ? 1 : Math.max(1e-9, spanRaw);
  const pad = spanRaw === 0 ? 0.5 : 0;


  // Animate the line drawing from the baseline (0 -> full path).
  const [drawP, setDrawP] = React.useState(1);

  React.useEffect(() => {
    if (!animate) {
      setDrawP(reduced ? 1 : 0);
      return;
    }
    if (reduced) {
      setDrawP(1);
      return;
    }
    setDrawP(0);
    let raf = 0;
    const start = performance.now();
    const dur = 900;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      setDrawP(easeOutCubic(t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, mode, points.length, min, max, reduced]);

  const chart = React.useMemo(() => {
    if (seriesValues.length < 2) return { path: "", pts: [] as Array<{ x: number; y: number }> };

    const stepX = (W - P * 2) / (seriesValues.length - 1);
    const pts = seriesValues.map((v, i) => {
      const x = P + i * stepX;
      const targetY = P + (H - P * 2) * (1 - (v - (min - pad)) / (span + pad * 2));
      const y = baseY - (baseY - targetY) * drawP;
      return { x, y };
    });
    const path = "M " + pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L ");
    return { path, pts };
  }, [seriesValues, min, max, drawP]);

  const latestSeries = seriesValues.length ? seriesValues[seriesValues.length - 1] : NaN;
  const displayLatest = Number.isFinite(live) ? live : latestSeries;

  const sum7 = seriesValues.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const avg7 = seriesValues.length ? sum7 / seriesValues.length : NaN;

  const headerMainTarget = mode === "volume" ? sum7 : displayLatest;
  const headerMain = useRafTween(Number.isFinite(headerMainTarget) ? headerMainTarget : 0, {
    durationMs: 900,
    enabled: animate && (mode === "volume" ? seriesValues.length > 0 : true) && Number.isFinite(headerMainTarget),
  });

  const base = seriesValues.length ? seriesValues[0] : NaN;
  const deltaTarget =
    seriesValues.length >= 2 && Number.isFinite(headerMainTarget) && Number.isFinite(base)
      ? headerMainTarget - base
      : NaN;
  const delta = useRafTween(Number.isFinite(deltaTarget) ? deltaTarget : 0, {
    durationMs: 900,
    enabled: animate && Number.isFinite(deltaTarget),
  });

  const deltaPct =
    seriesValues.length >= 2 && Number.isFinite(base) && base !== 0 && Number.isFinite(deltaTarget)
      ? (deltaTarget / base) * 100
      : NaN;

  const safeSelected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < points.length
      ? selectedIdx
      : points.length
        ? points.length - 1
        : null;

  const selectedPoint = safeSelected !== null ? points[safeSelected] : null;
  const selectedValue =
    selectedPoint && mode === "running"
      ? Number(selectedPoint.running || 0)
      : selectedPoint
        ? Number(selectedPoint.vol24h || 0)
        : NaN;

  const liveYTarget =
    Number.isFinite(displayLatest)
      ? P + (H - P * 2) * (1 - (displayLatest - (min - pad)) / (span + pad * 2))
      : baseY;
  const liveY = baseY - (baseY - liveYTarget) * drawP;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-4 backdrop-blur-xl col-span-2">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-emerald-400/0 via-emerald-400/60 to-emerald-400/0"
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.65rem] uppercase tracking-[0.16em] text-slate-300/80">
            7d trend
          </div>

          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <div className="text-lg font-semibold bg-gradient-to-r from-emerald-400 via-cyan-300 to-violet-400 bg-clip-text text-transparent">
              {animate ? fmt(headerMain) : "—"}
            </div>

            <div className="text-xs text-slate-300/80">
              {mode === "volume" ? (
                animate && seriesValues.length ? (
                  <>avg/day {fmt(avg7)}</>
                ) : (
                  "—"
                )
              ) : animate && Number.isFinite(deltaTarget) ? (
                <>
                  {`${deltaTarget >= 0 ? "+" : ""}${mode === "running" ? Math.round(delta) : fmt(delta)}`}
                  {Number.isFinite(deltaPct)
                    ? ` (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`
                    : ""}
                </>
              ) : (
                "—"
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1">
          <button
            type="button"
            onClick={() => {
              setMode("running");
              setSelectedIdx(null);
            }}
            className={[
              "px-2 py-1 text-[0.65rem] uppercase tracking-[0.14em] rounded-full transition",
              mode === "running"
                ? "bg-white/10 text-slate-100"
                : "text-slate-300/80 hover:text-slate-200",
            ].join(" ")}
          >
            vaults
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("volume");
              setSelectedIdx(null);
            }}
            className={[
              "px-2 py-1 text-[0.65rem] uppercase tracking-[0.14em] rounded-full transition",
              mode === "volume"
                ? "bg-white/10 text-slate-100"
                : "text-slate-300/80 hover:text-slate-200",
            ].join(" ")}
          >
            volume
          </button>
        </div>
      </div>

      <div className="mt-3">
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="7 day trend line chart"
          className="block overflow-visible"
        >
          <defs>
            <linearGradient id="mmLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(52,211,153,0.9)" />
              <stop offset="50%" stopColor="rgba(34,211,238,0.9)" />
              <stop offset="100%" stopColor="rgba(167,139,250,0.9)" />
            </linearGradient>
            <linearGradient id="mmFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(34,211,238,0.16)" />
              <stop offset="100%" stopColor="rgba(34,211,238,0)" />
            </linearGradient>
          </defs>

          <path
            d={`M ${P} ${H - P} H ${W - P}`}
            stroke="rgba(148,163,184,0.18)"
            strokeWidth="1"
            fill="none"
          />
          <path
            d={`M ${P} ${P} H ${W - P}`}
            stroke="rgba(148,163,184,0.10)"
            strokeWidth="1"
            fill="none"
          />
          <path
            d={`M ${P} ${(H / 2).toFixed(2)} H ${W - P}`}
            stroke="rgba(148,163,184,0.08)"
            strokeWidth="1"
            fill="none"
          />

          {chart.path ? (
            <>
              <path d={`${chart.path} L ${W - P} ${H - P} L ${P} ${H - P} Z`} fill="url(#mmFill)" />
              <path
                d={chart.path}
                stroke="url(#mmLine)"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />

              {chart.pts.map((p, i) => {
                const isSel = safeSelected === i;
                return (
                  <g key={i} style={{ cursor: "pointer" }} onClick={() => setSelectedIdx(i)}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={isSel ? 4.2 : 3.2}
                      fill={isSel ? "rgba(34,211,238,0.95)" : "rgba(148,163,184,0.55)"}
                    />
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={isSel ? 9 : 7}
                      fill={isSel ? "rgba(34,211,238,0.14)" : "rgba(148,163,184,0.06)"}
                    />
                  </g>
                );
              })}

              {Number.isFinite(displayLatest) ? (
                <>
                  <circle cx={W - P} cy={liveY} r="8" fill="rgba(34,211,238,0.18)" />
                  <circle cx={W - P} cy={liveY} r="4.5" fill="rgba(34,211,238,0.95)" />
                </>
              ) : null}
            </>
          ) : (
            <>
              {Number.isFinite(displayLatest) ? (
                <>
                  <circle cx={W - P} cy={liveY} r="8" fill="rgba(34,211,238,0.18)" />
                  <circle cx={W - P} cy={liveY} r="4.5" fill="rgba(34,211,238,0.95)" />
                </>
              ) : (
                <text x={P} y={H / 2} fill="rgba(148,163,184,0.7)" fontSize="14">
                  Collecting data…
                </text>
              )}
            </>
          )}
        </svg>

        <div className="mt-2 flex items-center justify-between text-[0.65rem] uppercase tracking-[0.16em] text-slate-500">
          <span>{points.length ? points[0].date : "—"}</span>
          <span>7D</span>
          <span>{points.length ? points[points.length - 1].date : "—"}</span>
        </div>

        <div className="mt-2 text-[0.7rem] text-slate-300/80">
          {selectedPoint ? (
            <span>
              {selectedPoint.date} •{" "}
              <span className="text-slate-100/90">{fmt(selectedValue)}</span>
            </span>
          ) : (
            <span>—</span>
          )}
        </div>
      </div>
    </div>
  );
}

function DisclaimerBubble({
  title = "disclaimers",
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const reduced = usePrefersReducedMotion();

  return (
    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-left backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="text-[0.65rem] uppercase tracking-[0.16em] text-slate-300/80">
            {title}
          </div>
          <div className="mt-1 text-xs text-slate-300">
            {open ? "Click to Collapse" : "Read Important Risk + Execution Disclosures"}
          </div>
        </div>
        <span
          aria-hidden
          className={[
            "inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-slate-200",
            reduced ? "" : "transition-transform duration-300",
            open ? "rotate-180" : "rotate-0",
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div
        className={[
          "grid transition-[grid-template-rows] duration-500 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        ].join(" ")}
      >
        <div className="overflow-hidden">
          <div className="mt-4 space-y-2 text-[11px] leading-relaxed text-slate-300/80">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-4 backdrop-blur-xl">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-emerald-400/0 via-emerald-400/60 to-emerald-400/0"
      />
      <div className="text-[0.65rem] uppercase tracking-[0.16em] text-slate-300/80">
        {title}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums leading-none bg-gradient-to-r from-emerald-400 via-cyan-300 to-violet-400 bg-clip-text text-transparent">
        {value}
      </div>
    </div>
  );
}

function GradientEmoji({ kind }: { kind: string }) {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-violet-500 text-white shadow-[0_0_18px_rgba(236,72,153,0.35)]">
      <span className="text-lg">{kind}</span>
    </div>
  );
}

/** Consistent image badge with subtle glow */
function FeatureBadge({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="relative h-24 w-24">
      <div
        aria-hidden
        className="absolute inset-0 rounded-full bg-gradient-to-br from-purple-500/35 to-fuchsia-500/25 blur-xl"
      />
      <div className="relative inline-flex h-24 w-24 items-center justify-center rounded-full bg-white/5 ring-1 ring-white/10">
        <Image
          src={src}
          alt={alt}
          width={113}
          height={113}
          className="h-20 w-20 object-contain"
        />
      </div>
    </div>
  );
}

/** 80x80 branded social button with subtle purple glow */
function SocialGlowButton({
  href,
  src,
  alt,
  ariaLabel,
}: {
  href: string;
  src: string;
  alt: string;
  ariaLabel: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      className="relative inline-flex h-20 w-20 items-center justify-center transition-transform hover:scale-105 active:scale-95"
    >
      {/* subtle glow (kept), no shape enclosure */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-2xl bg-gradient-to-br from-purple-500/40 to-fuchsia-500/30 blur-xl"
      />
      <span className="relative z-10 inline-flex items-center justify-center">
        <Image
          src={src}
          alt={alt}
          width={80}
          height={80}
          className="h-20 w-20 object-contain"
          priority={false}
        />
      </span>
    </a>
  );
}



const FEATURES = [
  {
    emoji: "🛡️",
    iconSrc: "/brand/anchor.webp",
    title: "Isolated Vaults per Bot",
    copy:
      "Each strategy runs in its own vault PDA for clean isolation and safer automation.",
  },
  {
    emoji: "⚖️",
    iconSrc: "/brand/scale.webp",
    title: "Stay Balanced Automatically",
    copy:
      "Choose your tokens + cadence; mojomaxi rebalances toward equal $ value over time.",
  },
  {
    emoji: "📡",
    iconSrc: "/brand/hook.webp",
    title: "Bring Your Own Signals",
    copy:
      "TradingView alerts in → Jupiter-routed swaps out. You control the vault and withdrawals.",
  },
  {
    emoji: "🥇",
    iconSrc: "/brand/mojopro-128.webp",
    title: "Mojo Pro Upgrades",
    copy:
      "More tokens per basket, Token-2022 support, and richer analytics as we keep shipping.",
  },
];
