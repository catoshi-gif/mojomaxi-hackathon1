// filepath: src/app/_components/SwallowAbortErrorBoundary.tsx
// FULL FILE REPLACEMENT for: src/app/_components/SwallowAbortErrorBoundary.tsx
'use client';

import * as React from 'react';
import { isAbortLike } from './AbortGuard';

declare global {
  interface Window { __mmResumeGraceUntil?: number; __mmLastClientError?: { when: number; kind: string; detail: string; stack?: string } }
}

type State = { epoch: number; fatal: boolean };
const FIRST_MOUNT_GRACE_MS = 5000;

function inResumeGrace() {
  if (typeof window === 'undefined') return false;
  const until = (window.__mmResumeGraceUntil as number) || 0;
  return Date.now() < until;
}

export default class SwallowAbortErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  private mountedAt = Date.now();

  constructor(props: any) {
    super(props);
    this.state = { epoch: 0, fatal: false };
  }

  static getDerivedStateFromError(_error: any) {
    return null;
  }

  componentDidCatch(error: any, _info: any) {
    try {
      (window as any).__mmLastClientError = {
        when: Date.now(),
        kind: 'boundary',
        detail: String(error?.message || error),
        stack: String(error?.stack || ''),
      };
      // eslint-disable-next-line no-console
      console.warn('[SwallowAbortErrorBoundary] caught:', error);
    } catch {}

    const withinFirstMountGrace = Date.now() - this.mountedAt < FIRST_MOUNT_GRACE_MS;
    const withinResume = inResumeGrace();
    const isTurnstile = /turnstile|verify-http-|verify-failed/i.test(String(error?.message || ''));

    if (withinFirstMountGrace || withinResume || isAbortLike(error) || isTurnstile) {
      this.setState((s) => ({ epoch: s.epoch + 1, fatal: false }));
    } else {
      this.setState({ fatal: true });
    }
  }

  render() {
    if (this.state.fatal) throw new Error('fatal');
    return <React.Fragment key={this.state.epoch}>{this.props.children}</React.Fragment>;
  }
}
