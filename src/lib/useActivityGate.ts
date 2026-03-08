// filepath: src/lib/useActivityGate.ts
// FULL FILE REPLACEMENT for: src/lib/useActivityGate.ts
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePageVisible } from '@/lib/usePageVisible';

/**
 * withJitterMs
 * - Returns a jittered interval in milliseconds to avoid thundering herds.
 * - Keeps the *average* interval approximately the same.
 * - Safe for sacred UI/behavior: only spreads requests out over time.
 */
export function withJitterMs(baseMs: number, jitterPct: number = 0.15) {
  const pct = Math.max(0, Math.min(0.9, jitterPct));
  const delta = baseMs * pct;
  const lo = baseMs - delta;
  const hi = baseMs + delta;
  return Math.max(250, Math.floor(lo + Math.random() * (hi - lo)));
}


/**
 * useInactivity
 * - Marks the user as idle after `idleMs` without any interaction events.
 * - Resets immediately on any interaction.
 * - Completely client-side and lightweight.
 * - No UI changes — only controls polling toggles.
 */
export function useInactivity(idleMs: number = 60_000) {
  const [idle, setIdle] = useState(false);
  const [lastActiveAt, setLastActiveAt] = useState<number>(() => Date.now());
  const idleTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const onAny = () => {
      setLastActiveAt(Date.now());
      if (idle) setIdle(false);
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      idleTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setIdle(true);
      }, idleMs);
    };

    const opts: AddEventListenerOptions = { passive: true };
    const events = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'wheel',
      'pointerdown',
      'scroll',
    ] as const;
    events.forEach((ev) => window.addEventListener(ev, onAny, opts));
    // kick off timer initially
    onAny();

    return () => {
      mountedRef.current = false;
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      events.forEach((ev) => window.removeEventListener(ev, onAny));
    };
  }, [idleMs, idle]);

  return { idle, lastActiveAt };
}

type PollingGateOpts = {
  idleMs?: number;
  /** Debounce visibility flips (ms) to avoid flapping during OS focus transitions. */
  debounceVisibleMs?: number;
  /** Grace window after resuming visibility where we *avoid* hammering RPC/db (ms). */
  resumeGraceMs?: number;
};

/**
 * usePollingGate
 * - shouldPoll => true only when: page is visible, user not idle, and we're outside resume grace.
 * - Also exposes { idle, visible } for diagnostics/conditional UI (no UI changes by default).
 */
export function usePollingGate(opts: PollingGateOpts = {}) {
  const { idleMs = 60_000, debounceVisibleMs = 250, resumeGraceMs = 2500 } = opts;
  const { idle } = useInactivity(idleMs);
  const visible = usePageVisible();

  // Debounce visibility to avoid very short flaps triggering fetches.
  const [visibleDebounced, setVisibleDebounced] = useState<boolean>(visible);
  const debTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (debTimerRef.current) {
      window.clearTimeout(debTimerRef.current);
      debTimerRef.current = null;
    }
    debTimerRef.current = window.setTimeout(() => {
      setVisibleDebounced(visible === true);
      debTimerRef.current = null;
    }, debounceVisibleMs);

    return () => {
      if (debTimerRef.current) {
        window.clearTimeout(debTimerRef.current);
        debTimerRef.current = null;
      }
    };
  }, [visible, debounceVisibleMs]);

  // Resume grace logic
  const prevVisibleRef = useRef<boolean>(visible);
  const [resumeAt, setResumeAt] = useState<number>(0);

  useEffect(() => {
    const prev = prevVisibleRef.current;
    prevVisibleRef.current = visibleDebounced;
    if (prev === false && visibleDebounced === true) {
      // we just became visible — give the UI a moment to settle
      setResumeAt(Date.now() + resumeGraceMs);
      // keep the global abort guard in sync so it relaxes error handling during resume
      try {
        (window as any).__mmResumeGraceUntil = Date.now() + Math.max(2000, resumeGraceMs);
      } catch {}
    }
  }, [visibleDebounced, resumeGraceMs]);

  const now = Date.now();
  const inResume = visibleDebounced && now < resumeAt;
  const shouldPoll = useMemo(
    () => Boolean(visibleDebounced && !idle && !inResume),
    [visibleDebounced, idle, inResume]
  );

  return { shouldPoll, idle, visible: visibleDebounced };
}
