// filepath: src/lib/hooks/useAnimationHooks.ts
// Shared animation / visibility hooks.
// Extracted from page.tsx, HeroScene.tsx and MojoParticleWordmark.tsx to
// eliminate triple-definitions and reduce bundle size.
"use client";

import * as React from "react";

/* -------------------------------------------------------------------------- */
/*  usePrefersReducedMotion                                                   */
/* -------------------------------------------------------------------------- */

export function usePrefersReducedMotion() {
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

/* -------------------------------------------------------------------------- */
/*  useDocumentVisible                                                        */
/* -------------------------------------------------------------------------- */

export function useDocumentVisible() {
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setVisible(document.visibilityState !== "hidden");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return visible;
}

/* -------------------------------------------------------------------------- */
/*  useIsMobileViewport                                                       */
/* -------------------------------------------------------------------------- */

export function useIsMobileViewport() {
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

/* -------------------------------------------------------------------------- */
/*  useInViewOnce  (fires once, then disconnects observer)                    */
/* -------------------------------------------------------------------------- */

export function useInViewOnce<T extends Element>(opts?: {
  rootMargin?: string;
  threshold?: number;
}) {
  const ref = React.useRef<T | null>(null);
  const [seen, setSeen] = React.useState(false);
  const reduced = usePrefersReducedMotion();

  React.useEffect(() => {
    if (seen) return;
    if (reduced) {
      setSeen(true);
      return;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setSeen(true);
            io.disconnect();
            break;
          }
        }
      },
      {
        root: null,
        rootMargin: opts?.rootMargin ?? "0px 0px -10% 0px",
        threshold: opts?.threshold ?? 0.12,
      }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, reduced, opts?.rootMargin, opts?.threshold]);

  return { ref, seen } as const;
}

/* -------------------------------------------------------------------------- */
/*  useInViewNow  (tracks live in/out visibility)                             */
/* -------------------------------------------------------------------------- */

export function useInViewNow<T extends Element>(opts?: {
  rootMargin?: string;
  threshold?: number;
}) {
  const ref = React.useRef<T | null>(null);
  const [inView, setInView] = React.useState(false);
  const reduced = usePrefersReducedMotion();

  React.useEffect(() => {
    if (reduced) {
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
      {
        root: null,
        rootMargin: opts?.rootMargin ?? "0px 0px -10% 0px",
        threshold: opts?.threshold ?? 0.12,
      }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced, opts?.rootMargin, opts?.threshold]);

  return { ref, inView } as const;
}

/* -------------------------------------------------------------------------- */
/*  useInView  (takes a ref *argument*; used by MojoParticleWordmark)         */
/* -------------------------------------------------------------------------- */

export function useInView(
  ref: React.RefObject<Element>,
  opts?: { rootMargin?: string; threshold?: number }
) {
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

/* -------------------------------------------------------------------------- */
/*  easeOutCubic                                                              */
/* -------------------------------------------------------------------------- */

export function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

/* -------------------------------------------------------------------------- */
/*  useRafTween  (animates a number toward `target` with easeOutCubic)        */
/* -------------------------------------------------------------------------- */

export function useRafTween(
  target: number,
  opts?: { durationMs?: number; enabled?: boolean }
) {
  const durationMs = opts?.durationMs ?? 900;
  const enabled = opts?.enabled ?? true;
  const reduced = usePrefersReducedMotion();
  const [v, setV] = React.useState<number>(0);

  React.useEffect(() => {
    if (!enabled) return;
    if (!Number.isFinite(target)) {
      setV(0);
      return;
    }
    if (reduced) {
      setV(target);
      return;
    }

    let raf = 0;
    const start = performance.now();
    const from = v;
    const to = target;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const e = easeOutCubic(t);
      setV(from + (to - from) * e);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, enabled, reduced]);

  return v;
}
