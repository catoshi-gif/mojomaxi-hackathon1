// filepath: src/app/app/template.tsx
// FULL FILE REPLACEMENT for: src/app/app/template.tsx
'use client';

import * as React from 'react';
import AbortGuard from '../_components/AbortGuard';
import SwallowAbortErrorBoundary from '../_components/SwallowAbortErrorBoundary';
import CrashBeacon from '../_components/CrashBeacon';

/** Local guard + recorder for the /app/app segment; no visible UI. */
export default function AppAppTemplate({ children }: { children: React.ReactNode }) {
  return (
    <SwallowAbortErrorBoundary>
      <AbortGuard />
      <CrashBeacon />
      {children}
    </SwallowAbortErrorBoundary>
  );
}
