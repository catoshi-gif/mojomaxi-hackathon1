// filepath: src/components/HeroScene.tsx
"use client";

import * as React from "react";
import {
  usePrefersReducedMotion,
  useDocumentVisible,
  useInViewNow,
} from "@/lib/hooks/useAnimationHooks";

/**
 * HeroScene
 * - Pixel-aligned layered SVG scene for the homepage hero.
 * - Pure CSS animations (no new deps).
 * - Respects prefers-reduced-motion.
 *
 * Assets expected in: /public/hero/
 *   vial.svg, wand.svg, token-sol.svg, token-z.svg, token-usd.svg, token-jup.svg, sparkle-1.svg, sparkle-2.svg, bubble-1.svg, bubble-2.svg
 */
export default function HeroScene() {
  const reduced = usePrefersReducedMotion();
  const docVisible = useDocumentVisible();
  const { ref, inView } = useInViewNow<HTMLDivElement>({ rootMargin: "220px 0px 220px 0px", threshold: 0.01 });
  const active = !reduced && docVisible && inView;

  return (
    <div ref={ref} className={`relative aspect-square w-full select-none ${active ? "mm-hero-active" : "mm-hero-paused"}`}>
      {/* Ambient glow behind art */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/2 h-[92%] w-[92%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(253,27,119,0.18),transparent_60%)] blur-2xl" />
        <div className="absolute left-[65%] top-[55%] h-[70%] w-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(227,27,253,0.12),transparent_60%)] blur-2xl" />
      </div>

      {/* Scene root (handles entrance) */}
      <div className="mm-hero-enter pointer-events-none absolute inset-0">
        {/* Wand (behind vial) */}
        <img
          src="/hero/wand.svg"
          alt=""
          className="mm-wand absolute left-[14%] top-[42%] w-[44%] rotate-[-20deg] opacity-90"
          draggable={false}
        />

        {/* Sparkles */}
        <img
          src="/hero/sparkle-1.svg"
          alt=""
          className="mm-sparkle mm-sparkle-a absolute left-[58%] top-[24%] w-[9%]"
          draggable={false}
        />
        <img
          src="/hero/sparkle-2.svg"
          alt=""
          className="mm-sparkle mm-sparkle-b absolute left-[51%] top-[36%] w-[5.8%]"
          draggable={false}
        />

        {/* Vial */}
        <img
          src="/hero/vial.svg"
          alt="vial"
          className="mm-vial absolute left-[50%] top-[20%] w-[58%]"
          draggable={false}
        />

        {/* Tokens (inside vial) */}
        <img
          src="/hero/token-sol.svg"
          alt=""
          className="mm-token mm-token-sol absolute left-[61%] top-[68%] w-[14%]"
          draggable={false}
        />
        <img
          src="/hero/token-usd.svg"
          alt=""
          className="mm-token mm-token-usd absolute left-[76%] top-[56%] w-[10%]"
          draggable={false}
        />
        <img
          src="/hero/token-z.svg"
          alt=""
          className="mm-token mm-token-z absolute left-[81%] top-[80%] w-[10%]"
          draggable={false}
        />
        <img
          src="/hero/token-jup.svg"
          alt=""
          className="mm-token mm-token-jup absolute left-[69%] top-[83%] w-[9%]"
          draggable={false}
        />

        {/* Bubbles */}
        <img
          src="/hero/bubble-1.svg"
          alt=""
          className="mm-bubble mm-bubble-a absolute left-[68%] top-[54%] w-[4.8%] opacity-70"
          draggable={false}
        />
        {/* Small bubble to the right of USDC */}
        <img
          src="/hero/bubble-2.svg"
          alt=""
          className="mm-bubble mm-bubble-c absolute left-[89%] top-[61%] w-[3.0%] opacity-55"
          draggable={false}
        />
        {/* Extra bubbles for richer motion */}
        <img
          src="/hero/bubble-1.svg"
          alt=""
          className="mm-bubble mm-bubble-d absolute left-[73%] top-[49%] w-[2.8%] opacity-45"
          draggable={false}
        />
        <img
          src="/hero/bubble-2.svg"
          alt=""
          className="mm-bubble mm-bubble-e absolute left-[70%] top-[73%] w-[2.4%] opacity-40"
          draggable={false}
        />
      </div>

      {/* Local/global CSS for keyframes */}
      <style jsx global>{`
        @media (prefers-reduced-motion: reduce) {
          .mm-hero-enter,
          .mm-wand,
          .mm-vial,
          .mm-token,
          .mm-sparkle,
          .mm-bubble {
            animation: none !important;
            transform: none !important;
          }
        }

        /* Pause all continuous motion when offscreen/tab hidden */
        .mm-hero-paused .mm-wand,
        .mm-hero-paused .mm-vial,
        .mm-hero-paused .mm-token,
        .mm-hero-paused .mm-sparkle,
        .mm-hero-paused .mm-bubble {
          animation-play-state: paused !important;
        }

        /* Entrance */
        .mm-hero-enter {
          animation: mmHeroEnter 850ms cubic-bezier(0.16, 1, 0.3, 1) both;
          transform-origin: 60% 65%;
        }
        @keyframes mmHeroEnter {
          from {
            opacity: 0;
            transform: translate3d(0, 56px, 0) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translate3d(0, 0, 0) scale(1);
          }
        }

        /* Wand bob */
        .mm-wand {
          will-change: transform;
          transform: translateZ(0);
          animation: mmWandBob 4.4s ease-in-out infinite;
          transform-origin: 40% 70%;
        }
        @keyframes mmWandBob {
          0%,
          100% {
            transform: translate3d(0, 0, 0) rotate(-20deg);
          }
          50% {
            transform: translate3d(2px, -8px, 0) rotate(-12deg);
          }
        }

        /* Vial bob (subtle) */
        .mm-vial {
          will-change: transform;
          transform: translateZ(0);
          animation: mmVialBob 5.4s ease-in-out infinite;
          transform-origin: 60% 70%;
        }
        @keyframes mmVialBob {
          0%,
          100% {
            transform: translate3d(0, 0, 0);
          }
          50% {
            transform: translate3d(0, -5px, 0);
          }
        }

        /* Tokens drift (unique phases) */
        .mm-token {
          will-change: transform;
          transform: translateZ(0);
        }
        .mm-token-sol {
          animation: mmTokenDriftA 4.2s ease-in-out infinite;
          transform-origin: 50% 50%;
        }
        .mm-token-usd {
          animation: mmTokenDriftB 4.8s ease-in-out infinite;
          transform-origin: 50% 50%;
        }
        .mm-token-z {
          animation: mmTokenDriftC 5.2s ease-in-out infinite;
          transform-origin: 50% 50%;
        }
        .mm-token-jup {
          animation: mmTokenDriftD 4.3s ease-in-out infinite;
          transform-origin: 50% 50%;
        }

        @keyframes mmTokenDriftA {
          0%,
          100% {
            transform: translate3d(0, 0, 0) rotate(-6deg) scale(1);
          }
          50% {
            transform: translate3d(1px, -4px, 0) rotate(6deg) scale(1.02);
          }
        }
        @keyframes mmTokenDriftB {
          0%,
          100% {
            transform: translate3d(0, 0, 0) rotate(8deg) scale(1);
          }
          50% {
            transform: translate3d(2px, -3px, 0) rotate(-6deg) scale(1.02);
          }
        }
        @keyframes mmTokenDriftC {
          0%,
          100% {
            transform: translate3d(0, 0, 0) rotate(-10deg) scale(1);
          }
          50% {
            transform: translate3d(1px, -2px, 0) rotate(7deg) scale(1.02);
          }
        }
        /* JUP: more buoyancy + rotation so it reads alive */
        @keyframes mmTokenDriftD {
          0%,
          100% {
            transform: translate3d(0, 0, 0) rotate(6deg) scale(1);
          }
          35% {
            transform: translate3d(-2px, -6px, 0) rotate(-14deg) scale(1.035);
          }
          70% {
            transform: translate3d(3px, -9px, 0) rotate(10deg) scale(1.05);
          }
        }

        /* Sparkles pulse */
        .mm-sparkle {
          will-change: transform, opacity;
          transform: translateZ(0);
          animation: mmSparklePulse 2.8s ease-in-out infinite;
          transform-origin: 50% 50%;
        }
        .mm-sparkle-a {
          animation-delay: 0.1s;
        }
        .mm-sparkle-b {
          animation-delay: 0.8s;
        }
        @keyframes mmSparklePulse {
          0%,
          100% {
            transform: translate3d(0, 0, 0) scale(1);
            opacity: 0.95;
          }
          50% {
            transform: translate3d(0, -1.5px, 0) scale(1.06);
            opacity: 1;
          }
        }

        /* Bubbles float */
        .mm-bubble {
          will-change: transform, opacity;
          transform: translateZ(0);
          animation: mmBubbleFloat 3.6s ease-in-out infinite;
          transform-origin: 50% 50%;
        }
        .mm-bubble-a {
          animation-duration: 3.9s;
          animation-delay: 0.2s;
        }
        .mm-bubble-c {
          animation-duration: 3.7s;
          animation-delay: 0.35s;
        }
        .mm-bubble-d {
          animation-duration: 4.2s;
          animation-delay: 0.9s;
        }
        .mm-bubble-e {
          animation-duration: 5.1s;
          animation-delay: 0.55s;
        }

        @keyframes mmBubbleFloat {
          0%,
          100% {
            transform: translate3d(0, 6px, 0) scale(1);
            opacity: 0.65;
          }
          50% {
            transform: translate3d(2px, -10px, 0) scale(1.07);
            opacity: 0.95;
          }
        }
      `}</style>
    </div>
  );
}
