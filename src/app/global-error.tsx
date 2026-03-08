// filepath: src/app/global-error.tsx
// P1-2: Root-level error boundary for crashes that occur outside the /app route group.
// This catches errors in the root layout itself (e.g., wallet provider crash, font loading
// failure, TokenMetaProvider throw). Without this, users see an unstyled white error page.
//
// IMPORTANT: global-error.tsx must render its own <html>/<body> because the root layout
// may be the thing that crashed. Uses inline styles only (no Tailwind, no CSS imports).
//
// Does NOT change any existing behavior — the /app route's error.tsx and
// SwallowAbortErrorBoundary continue to handle errors within the dashboard.
'use client';

import * as React from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const copyDiagnostics = React.useCallback(() => {
    try {
      const payload = {
        ts: new Date().toISOString(),
        route: 'global-error',
        message: String(error?.message || ''),
        digest: (error as any)?.digest || null,
        stack: String((error as any)?.stack || ''),
        ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      };
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(
        () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
        () => {},
      );
    } catch {}
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0A0A0A',
          color: '#ffffff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: '28rem' }}>
          <h2 style={{ fontSize: '1.375rem', fontWeight: 600, marginBottom: '0.75rem' }}>
            Something went wrong
          </h2>
          <p style={{ opacity: 0.6, fontSize: '0.875rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
            {error?.message || 'An unexpected error occurred.'}
          </p>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => reset()}
              style={{
                padding: '0.625rem 1.25rem',
                background: '#FD1B77',
                color: '#fff',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              Try again
            </button>
            <button
              onClick={() => typeof window !== 'undefined' && window.location.reload()}
              style={{
                padding: '0.625rem 1.25rem',
                background: 'transparent',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              Reload
            </button>
            <button
              onClick={copyDiagnostics}
              style={{
                padding: '0.625rem 1.25rem',
                background: 'transparent',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              {copied ? 'Copied!' : 'Copy diagnostics'}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
