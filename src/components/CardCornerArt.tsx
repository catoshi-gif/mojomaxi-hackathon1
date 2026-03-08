
"use client";

import * as React from "react";

/**
 * CardCornerArt — FIX: restore animations + visible clock hands
 * ------------------------------------------------------------
 * Your last file had a malformed CSS template string which caused styles (and thus animations) not to apply.
 * This version rewrites the <style jsx> block cleanly (balanced braces) and keeps:
 * - Accelerated clock with hour + minute + second hands (high opacity)
 * - Heart centered (left shift)
 * - Seesaw physics (plank pivots on fulcrum; ball rolls on plank)
 * - Varied per-card palettes
 *
 * Perf-safe: transforms + opacity only.
 */

export type CardCornerArtVariant =
  | "jupiter"
  | "radar"
  | "lock"
  | "clock"
  | "solana"
  | "routing"
  | "signals"
  | "shield"
  | "anchor"
  | "balance"
  | "hooks"
  | "pro";

type Props = {
  variant: CardCornerArtVariant;
  className?: string;
  opacity?: number;
  mode?: "subtle" | "pop";
  animateOnView?: boolean;
  rootMargin?: string;
};

export default function CardCornerArt({
  variant,
  className = "",
  opacity = 0.22,
  mode = "subtle",
  animateOnView = true,
  rootMargin = "0px 0px -10% 0px",
}: Props) {
  const reduced = usePrefersReducedMotion();
  const { ref, inView } = useInView<HTMLDivElement>({
    enabled: animateOnView && !reduced,
    rootMargin,
    threshold: 0.12,
  });

  const run = !animateOnView || reduced ? true : inView;
  const o = clamp(opacity, 0, 1);

  const sizeClass =
    mode === "pop" ? "h-full w-full" : "h-[12.5rem] w-[12.5rem] sm:h-[13.25rem] sm:w-[13.25rem]";

  const uid = React.useId();
  const ids = {
    mask: `mmMask-${variant}-${uid}`,
    feather: `mmFeather-${variant}-${uid}`,
    gA: `mmA-${variant}-${uid}`,
    gB: `mmB-${variant}-${uid}`,
    gC: `mmC-${variant}-${uid}`,
    hi: `mmHi-${variant}-${uid}`,
    glow: `mmGlow-${variant}-${uid}`,
  };

  const preserve = mode === "pop" ? "xMidYMid slice" : "xMidYMid meet";

  return (
    <div
      ref={ref}
      aria-hidden
      className={[
        "pointer-events-none absolute inset-0",
        run ? "mm-run" : "mm-wait",
        mode === "pop" ? "mm-pop" : "mm-subtle",
        className,
      ].join(" ")}
      style={{ opacity: run ? o : 0, transition: "opacity 700ms ease-out" }}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div className={[sizeClass, "mix-blend-screen"].join(" ")}>
          <svg viewBox="0 0 260 260" className="h-full w-full" preserveAspectRatio={preserve}>
            <defs>
              <radialGradient id={ids.feather} cx="50%" cy="50%" r="64%">
                <stop offset="0%" stopColor="rgba(255,255,255,1)" />
                <stop offset="60%" stopColor="rgba(255,255,255,0.92)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </radialGradient>
              <mask id={ids.mask}>
                <rect x="0" y="0" width="260" height="260" fill={`url(#${ids.feather})`} />
              </mask>

              <linearGradient id={ids.gA} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={pick(variant, 0)} />
                <stop offset="55%" stopColor={pick(variant, 1)} />
                <stop offset="100%" stopColor={pick(variant, 2)} />
              </linearGradient>
              <linearGradient id={ids.gB} x1="1" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={pick(variant, 2)} />
                <stop offset="55%" stopColor={pick(variant, 1)} />
                <stop offset="100%" stopColor={pick(variant, 0)} />
              </linearGradient>
              <linearGradient id={ids.gC} x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor={pick(variant, 1)} />
                <stop offset="55%" stopColor={pick(variant, 2)} />
                <stop offset="100%" stopColor={pick(variant, 0)} />
              </linearGradient>

              <linearGradient id={ids.hi} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(255,255,255,0.26)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0.03)" />
              </linearGradient>

              <filter id={ids.glow} x="-35%" y="-35%" width="170%" height="170%">
                <feGaussianBlur stdDeviation="1.6" result="b" />
                <feColorMatrix
                  in="b"
                  type="matrix"
                  values="
                    1 0 0 0 0
                    0 1 0 0 0
                    0 0 1 0 0
                    0 0 0 0.68 0"
                  result="g"
                />
                <feMerge>
                  <feMergeNode in="g" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <g mask={`url(#${ids.mask})`} filter={`url(#${ids.glow})`}>
              <rect x="0" y="0" width="260" height="260" fill="rgba(255,255,255,0.012)" />

              {variant === "jupiter" ? (
                <YinYangArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "radar" ? (
                <RadarArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "lock" ? (
                <LockArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "clock" ? (
                <ClockArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "anchor" ? (
                <AnchorArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "balance" ? (
                <SeesawBalanceArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "hooks" ? (
                <HooksArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "pro" ? (
                <ProArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "routing" ? (
                <RoutingArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "signals" ? (
                <SignalsArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : variant === "shield" ? (
                <ShieldArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              ) : (
                <SolanaArt gA={ids.gA} gB={ids.gB} gC={ids.gC} hi={ids.hi} mode={mode} />
              )}
            </g>
          </svg>
        </div>
      </div>

      <style jsx>{`
        .mm-wait :global(.mm-anim) { animation-play-state: paused !important; }
        .mm-run  :global(.mm-anim) { animation-play-state: running; }

        :global(svg .mm-anim) {
          transform-box: fill-box;
          transform-origin: center;
        }

        /* Ensure clock hands rotate around clock center (130,140) reliably */
        :global(svg .mm-clock-hand) {
          transform-box: view-box;
          transform-origin: 130px 140px;
        }

        /* base */
        .mm-subtle :global(.mm-rot1) { animation: rot1S 28s linear infinite; }
        .mm-subtle :global(.mm-rot2) { animation: rot2S 40s linear infinite reverse; }
        .mm-subtle :global(.mm-rot3) { animation: rot3S 46s linear infinite; }
        .mm-subtle :global(.mm-float){ animation: floatS 14s ease-in-out infinite; }
        .mm-subtle :global(.mm-pulse){ animation: pulseS 8.8s ease-in-out infinite; }

        .mm-pop :global(.mm-rot1) { animation: rot1P 16s linear infinite; }
        .mm-pop :global(.mm-rot2) { animation: rot2P 22s linear infinite reverse; }
        .mm-pop :global(.mm-rot3) { animation: rot3P 26s linear infinite; }
        .mm-pop :global(.mm-float){ animation: floatP 10.5s ease-in-out infinite; }
        .mm-pop :global(.mm-pulse){ animation: pulseP 6.6s ease-in-out infinite; }

        /* radar */
        .mm-subtle :global(.mm-rippleA){ animation: rippleA 2.4s ease-out infinite; }
        .mm-subtle :global(.mm-rippleB){ animation: rippleB 2.4s ease-out infinite; }
        .mm-pop :global(.mm-rippleA){ animation-duration: 1.9s; }
        .mm-pop :global(.mm-rippleB){ animation-duration: 1.9s; }

        /* lock */
        .mm-subtle :global(.mm-shackle){ animation: lockS 4.6s ease-in-out infinite; }
        .mm-pop :global(.mm-shackle){ animation-duration: 3.6s; }

        /* clock: accelerated real-clock */
        .mm-subtle :global(.mm-handSec){ animation: hand 1.0s linear infinite; }
        .mm-subtle :global(.mm-handMin){ animation: hand 60.0s linear infinite; }
        .mm-subtle :global(.mm-handH){ animation: hand 12.0s linear infinite; }
        .mm-pop :global(.mm-handSec){ animation: hand 0.85s linear infinite; }
        .mm-pop :global(.mm-handMin){ animation: hand 50.0s linear infinite; }
        .mm-pop :global(.mm-handH){ animation: hand 10.0s linear infinite; }

        /* rings pull apart */
        .mm-subtle :global(.mm-separateA){ animation: sepA_S 7.2s ease-in-out infinite; }
        .mm-subtle :global(.mm-separateB){ animation: sepB_S 7.2s ease-in-out infinite; }
        .mm-pop :global(.mm-separateA){ animation: sepA_P 5.8s ease-in-out infinite; }
        .mm-pop :global(.mm-separateB){ animation: sepB_P 5.8s ease-in-out infinite; }

        /* heart */
        .mm-subtle :global(.mm-heart){ animation: heartS 1.6s ease-in-out infinite; transform-origin: 50% 50%; }
        .mm-pop :global(.mm-heart){ animation: heartS 1.35s ease-in-out infinite; transform-origin: 50% 50%; }

        /* seesaw */
        .mm-subtle :global(.mm-tilt){ animation: tiltS 6.2s ease-in-out infinite; transform-origin: 130px 154px; }
        .mm-pop :global(.mm-tilt){ animation: tiltP 5.0s ease-in-out infinite; transform-origin: 130px 154px; }
        .mm-subtle :global(.mm-roll){ animation: rollS 6.2s ease-in-out infinite; }
        .mm-pop :global(.mm-roll){ animation: rollP 5.0s ease-in-out infinite; }

        @keyframes rot1S { to { transform: rotate(360deg); } }
        @keyframes rot2S { to { transform: rotate(360deg); } }
        @keyframes rot3S { to { transform: rotate(-360deg); } }
        @keyframes floatS { 0%,100%{ transform: translate3d(0,0,0);} 50%{ transform: translate3d(8px,-6px,0);} }
        @keyframes pulseS { 0%,100%{ opacity:0.70;} 50%{ opacity:1;} }

        @keyframes rot1P { to { transform: rotate(360deg); } }
        @keyframes rot2P { to { transform: rotate(360deg); } }
        @keyframes rot3P { to { transform: rotate(-360deg); } }
        @keyframes floatP { 0%,100%{ transform: translate3d(0,0,0) scale(1);} 50%{ transform: translate3d(10px,-8px,0) scale(1.03);} }
        @keyframes pulseP { 0%,100%{ opacity:0.62;} 50%{ opacity:1;} }

        @keyframes rippleA { 0%{ transform: scale(0.35); opacity:0;} 18%{ opacity:0.22;} 100%{ transform: scale(1.25); opacity:0;} }
        @keyframes rippleB { 0%{ transform: scale(0.35); opacity:0;} 38%{ opacity:0.20;} 100%{ transform: scale(1.25); opacity:0;} }

        @keyframes lockS { 0%,100%{ transform: translate3d(0,0,0) rotate(0deg);} 40%,60%{ transform: translate3d(14px,-8px,0) rotate(-20deg);} }

        @keyframes hand { to { transform: rotate(360deg); } }

        @keyframes sepA_S { 0%,100%{ transform: translate3d(-10px,0,0);} 50%{ transform: translate3d(-34px,0,0);} }
        @keyframes sepB_S { 0%,100%{ transform: translate3d(10px,0,0);} 50%{ transform: translate3d(34px,0,0);} }
        @keyframes sepA_P { 0%,100%{ transform: translate3d(-12px,0,0);} 50%{ transform: translate3d(-44px,0,0);} }
        @keyframes sepB_P { 0%,100%{ transform: translate3d(12px,0,0);} 50%{ transform: translate3d(44px,0,0);} }

        @keyframes heartS { 0%,100%{ transform: scale(0.96); opacity:0.85;} 50%{ transform: scale(1.08); opacity:1;} }

        @keyframes tiltS { 0%,100%{ transform: rotate(-8deg);} 50%{ transform: rotate(8deg);} }
        @keyframes tiltP { 0%,100%{ transform: rotate(-10deg);} 50%{ transform: rotate(10deg);} }
        @keyframes rollS { 0%,100%{ transform: translate3d(-68px,0,0);} 50%{ transform: translate3d(68px,0,0);} }
        @keyframes rollP { 0%,100%{ transform: translate3d(-82px,0,0);} 50%{ transform: translate3d(82px,0,0);} }

        @media (prefers-reduced-motion: reduce) {
          :global(.mm-anim) { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

/* ---------- Art pieces ---------- */

type ArtProps = {
  gA: string;
  gB: string;
  gC: string;
  hi: string;
  mode: "subtle" | "pop";
};

function YinYangArt({ gA, gB, gC, hi, mode }: ArtProps) {
  const dark = "rgba(0,0,0,0.35)";
  const light = "rgba(255,255,255,0.28)";
  const s = mode === "pop" ? 1 : 0.96;
  return (
    <g className="mm-anim mm-rot1">
      <circle cx="130" cy="130" r={92 * s} fill={`url(#${gA})`} opacity="0.08" />
      <path
        d="M130,38 A92,92 0 0 1 130,222 A46,46 0 0 0 130,130 A46,46 0 0 1 130,38 Z"
        fill={light}
      />
      <path
        d="M130,222 A92,92 0 0 1 130,38 A46,46 0 0 0 130,130 A46,46 0 0 1 130,222 Z"
        fill={dark}
      />
      <circle cx="130" cy="84" r={46 * s} fill={dark} opacity="0.55" />
      <circle cx="130" cy="176" r={46 * s} fill={light} opacity="0.55" />
      <circle cx="130" cy="84" r={10 * s} fill={light} opacity="0.90" />
      <circle cx="130" cy="176" r={10 * s} fill={dark} opacity="0.90" />
      <circle cx="130" cy="130" r={92 * s} fill="none" stroke={`url(#${hi})`} strokeWidth={10} opacity="0.20" />
      <circle cx="130" cy="130" r={68 * s} fill="none" stroke={`url(#${gC})`} strokeWidth={6} opacity="0.12" />
    </g>
  );
}

function RadarArt({ gA, gB, gC, hi }: ArtProps) {
  return (
    <>
      <circle cx="130" cy="140" r="92" fill={`url(#${gA})`} opacity="0.055" />
      <circle cx="130" cy="140" r="1" opacity="0" />
      <g className="mm-anim mm-rippleA">
        <circle cx="130" cy="140" r="56" fill="none" stroke={`url(#${gB})`} strokeWidth="18" />
      </g>
      <g className="mm-anim mm-rippleB">
        <circle cx="130" cy="140" r="56" fill="none" stroke={`url(#${gC})`} strokeWidth="18" />
      </g>
      <g className="mm-anim mm-pulse">
        <circle cx="130" cy="140" r="12" fill={`url(#${hi})`} opacity="0.34" />
      </g>
    </>
  );
}

function LockArt({ gA, gB, gC, hi }: ArtProps) {
  return (
    <>
      <g className="mm-anim mm-float">
        <rect x="66" y="116" width="128" height="104" rx="38" fill={`url(#${gA})`} opacity="0.18" />
        <rect x="80" y="132" width="100" height="78" rx="30" fill={`url(#${gB})`} opacity="0.12" />
        <rect x="74" y="124" width="112" height="90" rx="34" fill="none" stroke={`url(#${hi})`} strokeWidth="12" opacity="0.22" />
      </g>
      <g className="mm-anim mm-shackle">
        <circle cx="130" cy="116" r="1" opacity="0" />
        <path
          d="M 96 124 V 96 C 96 68 120 48 140 48 C 160 48 184 68 184 96 V 124"
          fill="none"
          stroke={`url(#${gC})`}
          strokeWidth="20"
          strokeLinecap="round"
          opacity="0.30"
        />
      </g>
      <g className="mm-anim mm-pulse">
        <circle cx="130" cy="170" r="13" fill={`url(#${hi})`} opacity="0.26" />
      </g>
    </>
  );
}

function ClockArt({ gA, gB, gC, hi, mode }: ArtProps) {
  const ringW = mode === "pop" ? 18 : 16;
  return (
    <>
      <g className="mm-anim mm-rot2">
        <circle cx="130" cy="140" r="92" fill={`url(#${gA})`} opacity="0.095" />
        <circle cx="130" cy="140" r="92" fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth={ringW} opacity="0.36" />
      </g>

      <g opacity="0.32">
        <circle cx="130" cy="54" r="7" fill={`url(#${hi})`} />
        <circle cx="216" cy="140" r="7" fill={`url(#${hi})`} />
        <circle cx="130" cy="226" r="7" fill={`url(#${hi})`} />
        <circle cx="44" cy="140" r="7" fill={`url(#${hi})`} />
      </g>

      <g className="mm-anim mm-clock-hand mm-handH">
        <circle cx="130" cy="140" r="1" opacity="0" />
        <line x1="130" y1="140" x2="130" y2="104" stroke="rgba(255,255,255,0.85)" strokeWidth="16" strokeLinecap="round" opacity="0.72" />
      </g>

      <g className="mm-anim mm-clock-hand mm-handMin">
        <circle cx="130" cy="140" r="1" opacity="0" />
        <line x1="130" y1="140" x2="190" y2="140" stroke="rgba(255,255,255,0.78)" strokeWidth="12" strokeLinecap="round" opacity="0.60" />
      </g>

      <g className="mm-anim mm-clock-hand mm-handSec">
        <circle cx="130" cy="140" r="1" opacity="0" />
        <line x1="130" y1="140" x2="202" y2="140" stroke="rgba(255,255,255,0.65)" strokeWidth="5" strokeLinecap="round" opacity="0.55" />
      </g>

      <g className="mm-anim mm-pulse">
        <circle cx="130" cy="140" r="12" fill={`url(#${hi})`} opacity="0.34" />
        <circle cx="130" cy="140" r="5" fill={`url(#${gB})`} opacity="0.26" />
      </g>
    </>
  );
}

function AnchorArt({ gA, gB, gC, hi, mode }: ArtProps) {
  return (
    <>
      <g className="mm-anim mm-breathe">
        <circle cx="130" cy="130" r="92" fill={`url(#${gA})`} opacity="0.07" />
        <circle cx="130" cy="130" r="68" fill={`url(#${gB})`} opacity="0.055" />
        <circle cx="130" cy="130" r="46" fill={`url(#${gC})`} opacity="0.04" />
      </g>

            {/* heart (slightly left) */}
      <g style={{ transform: "translateX(-10px)" } as any}>
        <g className="mm-anim mm-heart">

        <path
          d="M130 160
             C116 148, 104 140, 104 126
             C104 114, 114 104, 126 104
             C134 104, 140 108, 144 114
             C148 108, 154 104, 162 104
             C174 104, 184 114, 184 126
             C184 140, 172 148, 130 160 Z"
          fill={`url(#${hi})`}
          opacity="0.18"
        />
        <path
          d="M130 156
             C118 146, 110 140, 110 128
             C110 120, 116 114, 124 114
             C132 114, 136 118, 140 124
             C144 118, 148 114, 156 114
             C164 114, 170 120, 170 128
             C170 140, 162 146, 130 156 Z"
          fill={`url(#${gB})`}
          opacity="0.08"
        />
        </g>
      </g>

      <g className="mm-anim mm-pulse">
        <circle cx="130" cy="130" r="18" fill={`url(#${hi})`} opacity="0.12" />
      </g>
    </>
  );
}

function SeesawBalanceArt({ gA, gB, gC, hi }: ArtProps) {
  return (
    <>
      <circle cx="130" cy="150" r="92" fill={`url(#${gA})`} opacity="0.040" />
      <polygon points="130,154 96,196 164,196" fill={`url(#${gB})`} opacity="0.12" />
      <polygon points="130,162 108,196 152,196" fill={`url(#${hi})`} opacity="0.14" />

      <g className="mm-anim mm-tilt" style={{ transformOrigin: "130px 154px" } as any}>
        <rect x="50" y="144" width="160" height="18" rx="9" fill={`url(#${gC})`} opacity="0.12" />
        <rect x="58" y="148" width="144" height="10" rx="5" fill={`url(#${hi})`} opacity="0.14" />

        <g className="mm-anim mm-roll">
          <circle cx="130" cy="134" r="14" fill={`url(#${hi})`} opacity="0.22" className="mm-anim mm-pulse" />
          <circle cx="130" cy="134" r="5.5" fill={`url(#${gB})`} opacity="0.18" />
        </g>
      </g>

      <g className="mm-anim mm-pulse">
        <circle cx="130" cy="210" r="12" fill={`url(#${hi})`} opacity="0.18" />
      </g>
    </>
  );
}

function HooksArt({ gA, gB, gC, hi, mode }: ArtProps) {
  return (
    <>
      <g className="mm-anim mm-separateA">
        <circle cx="130" cy="140" r="1" opacity="0" />
        <circle cx="130" cy="140" r="74" fill="none" stroke={`url(#${gA})`} strokeWidth="16" opacity="0.14" />
        <circle cx="130" cy="140" r="48" fill="none" stroke={`url(#${hi})`} strokeWidth="10" opacity="0.12" />
      </g>
      <g className="mm-anim mm-separateB">
        <circle cx="130" cy="140" r="1" opacity="0" />
        <circle cx="130" cy="140" r="74" fill="none" stroke={`url(#${gB})`} strokeWidth="16" opacity="0.13" />
        <circle cx="130" cy="140" r="48" fill="none" stroke={`url(#${gC})`} strokeWidth="10" opacity="0.10" />
      </g>
      <g className="mm-anim mm-pulse">
        <circle cx="130" cy="98" r="10" fill={`url(#${hi})`} opacity="0.18" />
      </g>
    </>
  );
}

function ProArt({ gA, gB, gC, hi, mode }: ArtProps) {
  const s = mode === "pop" ? 1.04 : 1.0;
  const rx = 48;
  const x = 36;
  const y = 58;
  const w = 188 * s;
  const h = 144 * s;

  return (
    <>
      <g className="mm-anim mm-rot1">
        <rect x={x} y={y} width={w} height={h} rx={rx} fill={`url(#${gA})`} opacity="0.07" />
      </g>
      <g className="mm-anim mm-rot2">
        <rect x={x} y={y} width={w} height={h} rx={rx} fill={`url(#${gB})`} opacity="0.06" />
      </g>
      <g className="mm-anim mm-pulse">
        <rect x={x + 18} y={y + 22} width={w - 36} height={h - 48} rx={44} fill={`url(#${gC})`} opacity="0.03" />
        <circle cx={x + w - 26} cy={y + 28} r="10" fill={`url(#${hi})`} opacity="0.18" />
      </g>
    </>
  );
}

/* The following are kept from your set (still animated via base classes) */
function RoutingArt({ gA, gB, gC, hi, mode }: ArtProps) {
  const stroke = mode === "pop" ? 18 : 14;
  return (
    <>
      <g className="mm-anim mm-float">
        <circle cx="124" cy="126" r="86" fill={`url(#${gA})`} opacity="0.09" />
        <circle cx="162" cy="144" r="70" fill={`url(#${gB})`} opacity="0.075" />
      </g>
      <g className="mm-anim mm-rot2">
        <path d="M 72 168 C 102 120, 150 116, 182 140 C 204 156, 214 160, 232 150" fill="none" stroke={`url(#${gC})`} strokeWidth={stroke} strokeLinecap="round" opacity="0.16" />
      </g>
      <g className="mm-anim mm-pulse">
        <circle cx="232" cy="150" r="12" fill={`url(#${hi})`} opacity="0.22" />
        <circle cx="232" cy="150" r="4.8" fill={`url(#${gB})`} opacity="0.20" />
      </g>
    </>
  );
}

function SignalsArt({ gA, gB, gC, hi, mode }: ArtProps) {
  const w = mode === "pop" ? 18 : 16;
  return (
    <>
      <g className="mm-anim mm-separateA">
        <circle cx="130" cy="138" r="1" opacity="0" />
        <circle cx="130" cy="138" r="66" fill="none" stroke={`url(#${gA})`} strokeWidth={w} opacity="0.16" />
        <circle cx="130" cy="138" r="40" fill="none" stroke={`url(#${hi})`} strokeWidth={Math.max(8, w - 6)} opacity="0.14" />
      </g>
      <g className="mm-anim mm-separateB">
        <circle cx="130" cy="138" r="1" opacity="0" />
        <circle cx="130" cy="138" r="66" fill="none" stroke={`url(#${gB})`} strokeWidth={w} opacity="0.14" />
        <circle cx="130" cy="138" r="40" fill="none" stroke={`url(#${gC})`} strokeWidth={Math.max(8, w - 6)} opacity="0.10" />
      </g>
    </>
  );
}

function ShieldArt({ gA, gB, gC, hi }: ArtProps) {
  return (
    <g className="mm-anim mm-float">
      <rect x="64" y="62" width="142" height="96" rx="34" fill={`url(#${gA})`} opacity="0.08" transform="rotate(6 130 110)" />
      <rect x="70" y="94" width="136" height="116" rx="36" fill={`url(#${gB})`} opacity="0.065" transform="rotate(-6 138 152)" />
      <rect x="96" y="116" width="110" height="104" rx="40" fill={`url(#${hi})`} opacity="0.14" />
      <circle cx="210" cy="78" r="16" fill={`url(#${gC})`} opacity="0.08" className="mm-anim mm-pulse" />
    </g>
  );
}

function SolanaArt({ gA, gB, gC, hi }: ArtProps) {
  return (
    <g className="mm-anim mm-rot1">
      <circle cx="130" cy="130" r="98" fill={`url(#${gA})`} opacity="0.11" />
      <path d="M 130 130 L 130 32 A 98 98 0 0 1 228 130 Z" fill={`url(#${gB})`} opacity="0.095" />
      <path d="M 130 130 L 228 130 A 98 98 0 0 1 130 228 Z" fill={`url(#${gC})`} opacity="0.07" />
      <path d="M 130 130 L 130 228 A 98 98 0 0 1 32 130 Z" fill={`url(#${hi})`} opacity="0.20" />
    </g>
  );
}

/* ---------- helpers ---------- */

function pick(v: CardCornerArtVariant, i: 0 | 1 | 2) {
  const sets: Record<string, [string, string, string]> = {
    jupiter: ["rgba(52,211,153,0.95)", "rgba(34,211,238,0.95)", "rgba(167,139,250,0.95)"],
    radar: ["rgba(34,211,238,0.95)", "rgba(59,130,246,0.95)", "rgba(168,85,247,0.95)"],
    lock: ["rgba(236,72,153,0.95)", "rgba(168,85,247,0.95)", "rgba(34,211,238,0.92)"],
    clock: ["rgba(245,158,11,0.92)", "rgba(34,211,238,0.92)", "rgba(167,139,250,0.92)"],

    solana: ["rgba(52,211,153,0.95)", "rgba(34,211,238,0.92)", "rgba(99,102,241,0.92)"],
    routing: ["rgba(34,211,238,0.95)", "rgba(168,85,247,0.92)", "rgba(236,72,153,0.92)"],
    signals: ["rgba(168,85,247,0.95)", "rgba(236,72,153,0.92)", "rgba(34,211,238,0.92)"],
    shield: ["rgba(52,211,153,0.92)", "rgba(148,163,184,0.92)", "rgba(34,211,238,0.92)"],
    anchor: ["rgba(34,211,238,0.92)", "rgba(52,211,153,0.92)", "rgba(236,72,153,0.92)"],
    balance: ["rgba(34,211,238,0.92)", "rgba(167,139,250,0.92)", "rgba(245,158,11,0.90)"],
    hooks: ["rgba(52,211,153,0.92)", "rgba(34,211,238,0.92)", "rgba(168,85,247,0.92)"],
    pro: ["rgba(167,139,250,0.95)", "rgba(34,211,238,0.92)", "rgba(236,72,153,0.90)"],
  };
  const key = v as string;
  return (sets[key] ?? sets["pro"])[i];
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(!!mq.matches);
    onChange();
    if ("addEventListener" in mq) mq.addEventListener("change", onChange);
    else (mq as any).addListener(onChange);
    return () => {
      if ("removeEventListener" in mq) mq.removeEventListener("change", onChange);
      else (mq as any).removeListener(onChange);
    };
  }, []);
  return reduced;
}

function useInView<T extends Element>(opts: {
  enabled: boolean;
  rootMargin: string;
  threshold: number;
}) {
  const ref = React.useRef<T | null>(null);
  const [inView, setInView] = React.useState(false);

  React.useEffect(() => {
    if (!opts.enabled) {
      setInView(true);
      return;
    }

    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        setInView(!!e?.isIntersecting);
      },
      { root: null, rootMargin: opts.rootMargin, threshold: opts.threshold }
    );

    io.observe(el);
    return () => io.disconnect();
  }, [opts.enabled, opts.rootMargin, opts.threshold]);

  return { ref, inView } as const;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
