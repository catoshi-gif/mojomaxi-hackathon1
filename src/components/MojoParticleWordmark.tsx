
"use client";

import * as React from "react";

type Props = {
  className?: string;
  /** Accessible label for screen readers */
  ariaLabel?: string;
  /** Wordmark text to render as particles */
  text?: string;
  /** Extra spacing between letters (in px, auto-tuned if omitted) */
  letterSpacingPx?: number;
  /**
   * Post-form wave amplitude multiplier.
   * 1 = subtle wave. Increase slightly for more motion (e.g., 1.25).
   */
  waveIntensity?: number;
  /**
   * Subtle brightness pulse amount (0..0.35). Default is very subtle.
   * Higher values make the dots "breathe" more.
   */
  pulseAmount?: number;
  /**
   * Desktop-only hover interaction strength (0..1.5).
   * 0 disables. 1 is a tasteful “disperse & reform” effect.
   */
  hoverDisperseStrength?: number;
};

export default function MojoParticleWordmark({
  className = "",
  ariaLabel = "mojomaxi",
  text = "mojomaxi",
  letterSpacingPx,
  waveIntensity = 1.25,
  pulseAmount = 0.14,
  hoverDisperseStrength = 1,
}: Props) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const isMobileViewport = useIsMobileViewport();

  // Only animate when visible (saves CPU on long pages / background tabs).
  const inView = useInView(wrapRef, { rootMargin: "200px 0px 200px 0px", threshold: 0.05 });

  React.useEffect(() => {
    if (reduced) return;
    if (!inView) return;

    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx =
      canvas.getContext("2d", { alpha: true }) ||
      canvas.getContext("2d");
    if (!ctx) return;

    // Android/Chromium sometimes composites a 2D canvas as opaque when certain flags are used.
    // Force a transparent canvas surface.
    canvas.style.background = "transparent";

    let raf = 0;
    let running = true;

    const onVis = () => {
      running = document.visibilityState === "visible";
      if (running && !raf) raf = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", onVis);

    const state = {
      w: 0,
      h: 0,
      dpr: 1,
      fontPx: 92,
      points: [] as TargetPoint[],
      particles: [] as Particle[],
      startAt: performance.now(),
      formedAt: 0,
      phase: 0,
      last: performance.now(),
      letterGap: 10,
      isMobile: false,
      // 24fps throttle on mobile
      lastFrameAt: 0,
      frameIntervalMs: 1000 / 24,
      // Desktop hover interaction (cursor pushes particles away, then springs back)
      pointer: { x: 0, y: 0, active: false },
    };

    const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

    const pickDpr = () => {
      const raw = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      // Cap DPR to keep older devices cool.
      return clamp(raw, 1, state.isMobile ? 1.25 : 1.5);
    };

    function drawSpacedText(
      c: CanvasRenderingContext2D,
      str: string,
      x: number,
      y: number,
      gap: number,
      stroke: boolean,
      fill: boolean
    ) {
      const chars = [...str];
      if (!chars.length) return;

      let total = 0;
      for (let i = 0; i < chars.length; i++) {
        total += c.measureText(chars[i]).width;
        if (i < chars.length - 1) total += gap;
      }

      let penX = x - total / 2;
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (stroke) c.strokeText(ch, penX, y);
        if (fill) c.fillText(ch, penX, y);
        penX += c.measureText(ch).width + gap;
      }
    }

    function measureWordWidth(c: CanvasRenderingContext2D, str: string, gap: number) {
      const chars = [...str];
      let total = 0;
      for (let i = 0; i < chars.length; i++) {
        total += c.measureText(chars[i]).width;
        if (i < chars.length - 1) total += gap;
      }
      return total;
    }

    function applyFont(offCtx: CanvasRenderingContext2D) {
      const font = `${800} ${state.fontPx}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
      offCtx.font = font;
      return font;
    }

    function measure() {
      state.isMobile = typeof window !== "undefined" ? window.matchMedia("(max-width: 640px)").matches : false;

      const r = wrap.getBoundingClientRect();
      const w = Math.max(320, Math.floor(r.width));
      const h = Math.max(120, Math.floor(r.height));

      state.dpr = pickDpr();
      state.w = w;
      state.h = h;

      canvas.width = Math.floor(w * state.dpr);
      canvas.height = Math.floor(h * state.dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

      // Initial font guess based on width
      const ideal = Math.floor(w * (state.isMobile ? 0.20 : 0.18));
      state.fontPx = clamp(ideal, state.isMobile ? 44 : 56, state.isMobile ? 70 : 98);

      state.letterGap =
        typeof letterSpacingPx === "number"
          ? letterSpacingPx
          : clamp(
              Math.floor(state.fontPx * (state.isMobile ? 0.20 : 0.18)),
              state.isMobile ? 8 : 10,
              state.isMobile ? 14 : 18
            );

      // Auto-fit so the whole wordmark fits (prevents iPhone portrait cropping).
      const off = document.createElement("canvas");
      const offCtx = off.getContext("2d");
      if (!offCtx) return;

      offCtx.textAlign = "left";
      offCtx.textBaseline = "middle";

      const safeW = w * 0.965; // generous so edges don't get clipped by any parent padding
      let tries = 0;
      while (tries < 26) {
        applyFont(offCtx);
        const ww = measureWordWidth(offCtx, text, state.letterGap);
        if (ww <= safeW) break;

        state.fontPx = Math.max(state.isMobile ? 36 : 52, Math.floor(state.fontPx * 0.92));

        if (typeof letterSpacingPx !== "number") {
          state.letterGap = clamp(
            Math.floor(state.fontPx * (state.isMobile ? 0.19 : 0.17)),
            state.isMobile ? 7 : 9,
            state.isMobile ? 12 : 16
          );
        }
        tries++;
      }
    }

    function buildTargets() {
      const off = document.createElement("canvas");
      const offCtx = off.getContext("2d", { willReadFrequently: true });
      if (!offCtx) return;

      off.width = state.w;
      off.height = state.h;

      offCtx.clearRect(0, 0, off.width, off.height);

      applyFont(offCtx);
      offCtx.textAlign = "left";
      offCtx.textBaseline = "middle";

      const cx = off.width / 2;
      const cy = off.height / 2 + (state.isMobile ? 4 : 2);

      // OUTLINE-ONLY sampling: keeps counters (holes) open, avoids blobbed "a".
      offCtx.lineJoin = "round";
      offCtx.lineCap = "round";
      offCtx.lineWidth = Math.max(5, Math.floor(state.fontPx * 0.095));
      offCtx.strokeStyle = "rgba(255,255,255,1)";
      offCtx.globalAlpha = 1;

      drawSpacedText(offCtx, text, cx, cy, state.letterGap, true, false);

      const img = offCtx.getImageData(0, 0, off.width, off.height).data;

      // Dot density:
      // - Mobile: match the *previous desktop* density, then rely on 24fps throttle for perf.
      // - Desktop: increase density/cap for a richer look.
      const step = state.isMobile ? 6 : 4; // smaller step = more dots
      const pts: TargetPoint[] = [];

      let minX = off.width,
        minY = off.height,
        maxX = 0,
        maxY = 0;

      for (let y = 0; y < off.height; y += step) {
        for (let x = 0; x < off.width; x += step) {
          const a = img[(y * off.width + x) * 4 + 3];
          if (a > 20) {
            pts.push({ x, y, baseX: x, baseY: y, seed: hash2(x, y) });
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (!pts.length) {
        state.points = [];
        return;
      }

      // Center the sampled cloud
      const bw = maxX - minX;
      const bh = maxY - minY;
      const offsetX = state.w / 2 - (minX + bw / 2);
      const offsetY = state.h / 2 - (minY + bh / 2);

      for (const p of pts) {
        p.x += offsetX;
        p.y += offsetY;
        p.baseX = p.x;
        p.baseY = p.y;
      }

      // Caps:
      // - Mobile: 720 (≈ old desktop)
      // - Desktop: 1400 (richer, still sane for glow circles)
      const cap = state.isMobile ? 720 : 1400;

      if (pts.length > cap) {
        const stride = Math.ceil(pts.length / cap);
        state.points = pts.filter((_, i) => i % stride === 0);
      } else {
        state.points = pts;
      }
    }

    function buildParticles() {
      const pts = state.points;
      const n = pts.length;
      const particles: Particle[] = [];

      const cx = state.w / 2;
      const cy = state.h / 2;
const originX = cx;
const originY = cy - state.h * 0.06;

// tight cluster radius (scaled; slightly larger on desktop)
const clusterR = state.isMobile ? 10 : 14;

for (let i = 0; i < n; i++) {
  const t = pts[i];

  const a = rand01(t.seed + 11) * Math.PI * 2;
  const r = clusterR * Math.sqrt(rand01(t.seed + 29)); // sqrt = uniform density in circle

  const sx = originX + Math.cos(a) * r;
  const sy = originY + Math.sin(a) * r;
        // Smaller particles => clearer letterforms (keeps more negative space).
        const sizeBase = state.isMobile ? 1.05 : 0.95;
        const sizeVar = state.isMobile ? 0.65 : 0.85;

// vector from origin → start position
const dx0 = sx - originX;
const dy0 = sy - originY;

// normalize (cheap + safe)
const d0 = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
const nx0 = dx0 / d0;
const ny0 = dy0 / d0;

// burst strength (subtle, tuned)
const burstBase = state.isMobile ? 22 : 34;
const burstJitter = rand01(t.seed + 123) * 0.35 + 0.65;
const burst = burstBase * burstJitter;

particles.push({
  x: sx,
  y: sy,

  // 👇 THIS is the premium touch
  vx: nx0 * burst,
  vy: ny0 * burst,

  baseTx: t.baseX,
  baseTy: t.baseY,
  seed: t.seed,
  r: sizeBase + rand01(t.seed + 7) * sizeVar,
});
      }

      state.particles = particles;
      state.startAt = performance.now();
      state.formedAt = 0;
    }

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        measure();
        buildTargets();
        buildParticles();
      });
      ro.observe(wrap);
    } else {
      const onResize = () => {
        measure();
        buildTargets();
        buildParticles();
      };
      window.addEventListener("resize", onResize);
    }

    // --- Desktop hover interaction listeners (very lightweight)
    // We attach pointermove/pointerleave to the wrapper.
    // Repulsion is only applied on desktop after the word has formed.
    const onPointerMove = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      state.pointer.x = e.clientX - r.left;
      state.pointer.y = e.clientY - r.top;
      state.pointer.active = true;
    };
    const onPointerLeave = () => {
      state.pointer.active = false;
    };
    wrap.addEventListener("pointermove", onPointerMove, { passive: true } as any);
    wrap.addEventListener("pointerleave", onPointerLeave, { passive: true } as any);

    // Initial
    measure();
    buildTargets();
    buildParticles();

    function draw() {
      const { w, h } = state;

      // Some Android GPUs can momentarily treat the canvas as opaque.
      // Clear using an explicit transparent fill under source-over, then switch to additive.
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      const pulse = clamp(pulseAmount, 0, 0.35);

      for (const p of state.particles) {
        const rr = p.r;

        // Very subtle per-particle brightness pulse
        const pulsePhase = state.phase * 0.9 + (p.seed % 997) * 0.0025;
        const pulseK = 1 + pulse * Math.sin(pulsePhase);
        const a0 = 0.50 + 0.34 * rand01(p.seed + 3);
        const alpha = clamp(a0 * pulseK, 0.08, 0.98);

        // outer soft glow
        ctx.beginPath();
        ctx.fillStyle = `rgba(168,85,247,${alpha * 0.14})`;
        ctx.arc(p.x, p.y, rr * (2.85 + 0.28 * (pulseK - 1)), 0, Math.PI * 2);
        ctx.fill();

        // inner bright dot
        ctx.beginPath();
        ctx.fillStyle = `rgba(216,180,254,${alpha})`;
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    function step(now: number) {
      const dtRaw = (now - state.last) / 1000;
      const dt = Math.min(0.033, Math.max(0.008, dtRaw || 0.016));
      state.last = now;

      const formDur = 1.55;
      const t = clamp((now - state.startAt) / 1000 / formDur, 0, 1);
      const formP = easeOutCubic(t);
      const post = t >= 1;

      const baseWaveA = state.isMobile ? 3.0 : 4.6;
      const waveA = baseWaveA * clamp(waveIntensity, 0.8, 1.9);

      const waveK = (Math.PI * 2) / Math.max(320, state.w * 0.86);
      const waveSpd = 1.0;

      const attract = post ? 34 : 26;
      const damping = post ? 0.85 : 0.83;
      const flow = post ? 0.50 : 0.82;

      // Desktop hover interaction parameters (only after formation)
      const hoverK = clamp(hoverDisperseStrength, 0, 1.5);
      const enableHover = post && !state.isMobile && state.pointer.active && hoverK > 0.001;

      // radius in px and strength tuned to feel premium, not chaotic
      const R = 130;
      const R2 = R * R;
      const hoverStrength = 11 * hoverK;

      state.phase += dt;

      for (let i = 0; i < state.particles.length; i++) {
        const p = state.particles[i];

        let tx = p.baseTx;
        let ty = p.baseTy;

        if (post) {
          const wv = Math.sin(tx * waveK + state.phase * waveSpd);
          const wv2 = Math.sin(tx * waveK * 0.55 - state.phase * (waveSpd * 0.7));
          ty = ty + (wv * waveA + wv2 * (waveA * 0.42));
          tx = tx + Math.sin(ty * waveK * 0.85 + state.phase * 0.9) * 0.75;
        }

        const targetX = p.x + (tx - p.x) * (0.02 + 0.18 * formP);
        const targetY = p.y + (ty - p.y) * (0.02 + 0.18 * formP);

        const dx = targetX - p.x;
        const dy = targetY - p.y;

        p.vx += dx * attract * dt;
        p.vy += dy * attract * dt;

        // Cursor repulsion (desktop only, post-formation)
        // Cheap: a single distance check; only sqrt if inside radius.
        if (enableHover) {
          const rx = p.x - state.pointer.x;
          const ry = p.y - state.pointer.y;
          const r2 = rx * rx + ry * ry;

          if (r2 < R2) {
            const d = Math.sqrt(r2) + 0.0001;
            const nx = rx / d;
            const ny = ry / d;

            // smooth falloff (strongest near cursor)
            const k = 1 - d / R;
            const push = hoverStrength * k * k;

            p.vx += nx * push;
            p.vy += ny * push;
          }
        }

        const n = noise2(p.seed, state.phase * 0.9);
        p.vx += (n.x - 0.5) * flow;
        p.vy += (n.y - 0.5) * flow;

        p.vx *= damping;
        p.vy *= damping;

        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }

      if (post && !state.formedAt) state.formedAt = now;
    }

    function tick(now: number) {
      raf = 0;
      if (!running) return;

      // 24fps throttle on mobile (PAL-like, visually fine, huge battery/heat saver)
      if (state.isMobile) {
        if (state.lastFrameAt && now - state.lastFrameAt < state.frameIntervalMs) {
          raf = requestAnimationFrame(tick);
          return;
        }
        state.lastFrameAt = now;
      }

      step(now);
      draw();
      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (ro) ro.disconnect();
      wrap.removeEventListener("pointermove", onPointerMove as any);
      wrap.removeEventListener("pointerleave", onPointerLeave as any);
      cancelAnimationFrame(raf);
    };
  }, [reduced, inView, text, letterSpacingPx, waveIntensity, pulseAmount, hoverDisperseStrength]);

  // IMPORTANT:
  // - Any strong feathering can cut off edges on narrow mobile portrait screens.
  // - We therefore apply NO mask on mobile; on larger screens we apply a very mild side fade only.
  const mildInsetMask: React.CSSProperties = {
    WebkitMaskImage:
      "linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 5%, rgba(0,0,0,1) 95%, rgba(0,0,0,0) 100%)",
    maskImage:
      "linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 5%, rgba(0,0,0,1) 95%, rgba(0,0,0,0) 100%)",
  };

  return (
    <div
      ref={wrapRef}
      className={["relative w-full select-none", "h-[clamp(84px,14vw,132px)]", className].join(" ")}
      aria-label={ariaLabel}
    >
      {reduced ? (
        <div className="flex h-full items-center justify-center">
          <span className="text-center text-[clamp(2.2rem,6vw,3.4rem)] font-extrabold tracking-[0.28em] bg-gradient-to-r from-pink-500 to-violet-500 bg-clip-text text-transparent">
            {text}
          </span>
        </div>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full pointer-events-none"
            aria-hidden="true"
            // Force transparent background (fixes black box on some Android GPUs)
            style={{
              background: "transparent",
              ...(isMobileViewport ? {} : mildInsetMask),
            }}
          />
          <span className="sr-only">{text}</span>
        </>
      )}
    </div>
  );
}

/* ----------------------------- small utilities ---------------------------- */

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

function useIsMobileViewport() {
  const [mobile, setMobile] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = () => setMobile(!!mq.matches);
    onChange();
    if ("addEventListener" in mq) mq.addEventListener("change", onChange);
    else (mq as any).addListener(onChange);
    return () => {
      if ("removeEventListener" in mq) mq.removeEventListener("change", onChange);
      else (mq as any).removeListener(onChange);
    };
  }, []);

  return mobile;
}

function useInView(ref: React.RefObject<Element>, opts?: { rootMargin?: string; threshold?: number }) {
  const [inView, setInView] = React.useState(true);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const io = new IntersectionObserver(
      (entries) => {
        const any = entries.some((e) => e.isIntersecting);
        setInView(any);
      },
      {
        root: null,
        rootMargin: opts?.rootMargin ?? "0px",
        threshold: opts?.threshold ?? 0.01,
      }
    );

    io.observe(el);
    return () => io.disconnect();
  }, [ref, opts?.rootMargin, opts?.threshold]);

  return inView;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

type TargetPoint = { x: number; y: number; baseX: number; baseY: number; seed: number };
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseTx: number;
  baseTy: number;
  seed: number;
  r: number;
};

function hash2(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = (h * 1274126177) | 0;
  return h >>> 0;
}

function rand01(seed: number) {
  let x = (seed >>> 0) || 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return ((x >>> 0) % 10000) / 10000;
}

function noise2(seed: number, t: number) {
  const a = Math.sin((seed * 0.00017 + t * 1.3) * 12.9898) * 43758.5453;
  const b = Math.sin((seed * 0.00019 + t * 1.7) * 78.233) * 12345.6789;
  return { x: a - Math.floor(a), y: b - Math.floor(b) };
}
