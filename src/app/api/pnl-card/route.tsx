// FULL FILE REPLACEMENT for: src/app/api/pnl-card/route.tsx
// filepath: src/app/api/pnl-card/route.tsx
/* eslint-disable react/jsx-key */
import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const WIDTH = 500;
const HEIGHT = 500;

/* ---------------- helpers ---------------- */

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// Edge/Satori-safe number formatter (no Intl/toLocaleString)
function formatNumber(n: number, maxFractionDigits: number = 2): string {
  if (!isFinite(n)) return '0';
  const mfd = Math.max(0, Math.min(6, Math.floor(maxFractionDigits)));
  let s = n.toFixed(mfd);
  if (mfd > 0) s = s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  const parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

function fmtUsd(n: number | null | undefined): string {
  if (typeof n !== 'number' || !isFinite(n)) return '$0';
  const abs = Math.abs(n);
  const s = formatNumber(abs, 2);
  return (n < 0 ? '-' : '') + '$' + s;
}

function fmtUsdSigned(n: number | null | undefined): string {
  if (typeof n !== 'number' || !isFinite(n)) return '$0';
  const abs = Math.abs(n);
  const s = formatNumber(abs, 2);
  return (n < 0 ? '-' : '+') + '$' + s;
}

function fmtPct(n: number | null | undefined): string {
  if (typeof n !== 'number' || !isFinite(n)) return '0%';
  const abs = Math.abs(n);
  const s = formatNumber(abs, 2);
  return (n < 0 ? '-' : '+') + s + '%';
}

function fmtInt(n: number | null | undefined): string {
  if (typeof n !== 'number' || !isFinite(n)) return '0';
  return formatNumber(Math.floor(n), 0);
}

// arrayBuffer → base64 (Edge-safe)
function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk) as any);
  }
  // @ts-ignore btoa exists in Edge runtime
  return btoa(binary);
}

// Load /public/pnlcard.jpg as a data URL. In the Edge runtime, attempting to fetch it via
// `new URL('../../../../public/...', import.meta.url)` can be intermittently flaky on Vercel builds/runs.
// Instead, fetch it from the deployed static asset URL (same origin as this request) with a small retry.
async function loadBgDataUrl(requestUrl: string): Promise<string | null> {
  try {
    const origin = new URL(requestUrl);
    const base = new URL('/pnlcard.jpg', origin);

    for (let attempt = 0; attempt < 2; attempt++) {
      const u = new URL(base.toString());
      // Retry with a cache-busting query param
      if (attempt === 1) u.searchParams.set('v', Date.now().toString());

      const res = await fetch(u, { cache: 'no-store' });
      if (!res.ok) continue;

      const ct = res.headers.get('content-type') || '';
      if (ct && !ct.includes('image')) continue;

      const buf = await res.arrayBuffer();
      return `data:image/jpeg;base64,${abToBase64(buf)}`;
    }

    return null;
  } catch {
    return null;
  }
}


// Accept number-like strings, but only emit finite numbers
function toNum(s: string | null): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Convert 123456s -> "1d 10h 17m" (omit zeros)
function fmtRuntimeFromSeconds(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return '';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ');
}

/* ---------------- route ------------------ */

export async function GET(req: Request) {
  const u = new URL(req.url);

  // New fields
  const setTitle = (u.searchParams.get('setTitle') || u.searchParams.get('title') || 'mojomaxi bot').toString();
  const botType = (u.searchParams.get('botType') || u.searchParams.get('kind') || 'webhooks').toLowerCase();

  // totals & pnl
  const totalUsd = u.searchParams.has('totalUsd') ? toNum(u.searchParams.get('totalUsd')) : null;
  const pnlUsd = u.searchParams.has('pnlUsd') ? toNum(u.searchParams.get('pnlUsd')) : null;
  const pnlPct = u.searchParams.has('pnlPct') ? toNum(u.searchParams.get('pnlPct')) : null;
  const runtimeSec = u.searchParams.has('runtimeSec') ? toNum(u.searchParams.get('runtimeSec')) : null;

  // webhooks metrics
  const bestTradeUsd = u.searchParams.has('bestTradeUsd') ? toNum(u.searchParams.get('bestTradeUsd')) : null;
  const totalTrades = u.searchParams.has('totalTrades') ? toNum(u.searchParams.get('totalTrades')) : null;
  const wins = u.searchParams.has('wins') ? toNum(u.searchParams.get('wins')) : null;
  const losses = u.searchParams.has('losses') ? toNum(u.searchParams.get('losses')) : null;
  const winRatePct = u.searchParams.has('winRatePct') ? toNum(u.searchParams.get('winRatePct')) : null;

  // rebalance metrics
  const cadenceHours = u.searchParams.has('cadenceHours') ? toNum(u.searchParams.get('cadenceHours')) : null;
  const totalRebalances = u.searchParams.has('totalRebalances') ? toNum(u.searchParams.get('totalRebalances')) : null;

  // misc
  const startedAt = u.searchParams.has('startedAt') ? toNum(u.searchParams.get('startedAt')) : null;
  const runtimeTextExplicit = (u.searchParams.get('runtimeText') || '').toString();
  const dl = u.searchParams.get('dl') === '1' || u.searchParams.get('download') === '1';
  const ultra = (u.searchParams.get('ultra') === '1' || u.searchParams.get('ultra') === 'true');
  const debug = u.searchParams.has('debug');
  const trace = u.searchParams.has('trace');
  const format = (u.searchParams.get('format') || '').toString();


  // Background (safe if it fails)
  const bgDataUrl = await loadBgDataUrl(req.url);

  // Derived
  const computedTotalTrades =
    typeof totalTrades === 'number' && isFinite(totalTrades) && totalTrades >= 0
      ? totalTrades
      : (typeof wins === 'number' && typeof losses === 'number'
          ? wins + losses
          : null);

  const computedWinRate =
    typeof winRatePct === 'number'
      ? clamp(winRatePct, -100, 100)
      : (typeof wins === 'number' &&
         typeof computedTotalTrades === 'number' &&
         computedTotalTrades > 0
            ? (wins / computedTotalTrades) * 100
            : null);

  const runtimeText = runtimeTextExplicit || (typeof runtimeSec === 'number' ? fmtRuntimeFromSeconds(runtimeSec) : '');

  // When debug & not tracing, just echo the normalized params (existing behavior)
  if (debug && !trace) {
    return new Response(
      JSON.stringify(
        {
          ok: true,
          params: {
            setTitle,
            botType,
            totalUsd,
            pnlUsd,
            pnlPct,
            runtimeSec,
            bestTradeUsd,
            totalTrades,
            wins,
            losses,
            winRatePct: computedWinRate,
            cadenceHours,
            totalRebalances,
            startedAt,
            runtimeText,
            ultra,
          },
        },
        null,
        2,
      ),
      { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  }

  
  // If format=svg is requested, return our ultra-safe SVG text card and skip Satori entirely.
  if (format === 'svg') {
    const runtimeText = typeof runtimeSec === 'number' && isFinite(runtimeSec)
      ? fmtRuntimeFromSeconds(runtimeSec)
      : '';
    try {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <style>
      .t1 { font: 22px sans-serif; fill: #FAFAFA; }
      .t2 { font: 40px sans-serif; fill: #FAFAFA; font-weight: 700; }
      .t3 { font: 14px sans-serif; fill: #FAFAFA; }
    </style>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#0A0A0A"/>\n  ${bgDataUrl ? '<image href="' + bgDataUrl + '" x="0" y="0" width="' + WIDTH + '" height="' + HEIGHT + '" opacity="' + (ultra ? 0.12 : 0.20) + '"/>' : ''}
  <text x="24" y="64" class="t1">${botType === 'rebalance' ? 'Rebalancing bot' : 'Webhooks bot'}</text>
  <text x="24" y="116" class="t2">${(setTitle || 'mojomaxi bot').replace(/&/g,'&amp;')}</text>
  <text x="24" y="176" class="t1">Total: ${fmtUsd(typeof totalUsd === 'number' ? totalUsd : 0)}</text>
  <text x="24" y="208" class="t1">P&amp;L: ${fmtUsdSigned(typeof pnlUsd === 'number' ? pnlUsd : 0)}${typeof pnlPct === 'number' ? ` (${fmtPct(pnlPct)})` : ''}</text>
  ${runtimeText ? `<text x="24" y="236" class="t3">runtime: ${runtimeText}</text>` : ''}
  <text x="24" y="${HEIGHT - 16}" class="t3">generated by mojomaxi.com</text>
</svg>`;
      const headers: Record<string, string> = {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=60, s-maxage=60',
      };
      if (dl) headers['Content-Disposition'] = 'attachment; filename="mojomaxi-pnl.svg"';
      return new Response(svg, { status: 200, headers });
    } catch (e: any) {
      return new Response(String(e?.message || e), { status: 500, headers: { 'content-type': 'text/plain' } });
    }
  }

  // --- Primary render (Satori) ---
  try {
    const res = new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: '#0A0A0A',
            position: 'relative',
          }}
        >
          {/* Background (Satori-safe) */}
          {bgDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={bgDataUrl}
              width={WIDTH}
              height={HEIGHT}
              alt=""
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: WIDTH,
                height: HEIGHT,
                opacity: ultra ? 0.12 : 0.20,
              }}
            />
          ) : null}

          {/* "mojomaxi" faint watermark */}
          <div
            style={{
              position: 'absolute',
              top: 10,
              right: 16,
              fontSize: 16,
              opacity: 0.25,
              letterSpacing: 1,
            }}
          >
            mojomaxi
          </div>

          {/* Centered content */}
          <div
            style={{
              position: 'absolute',
              left: 24,
              right: 24,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              top: 36,
            }}
          >
            {/* Set title */}
            <div
              style={{
                fontSize: 28,
                fontWeight: ultra ? 400 : 800,
                lineHeight: 1.1,
              }}
            >
              {setTitle || 'mojomaxi bot'}
            </div>

            {/* Spacer instead of gap */}
            <div style={{ height: 6 }} />

            {/* Bot family label */}
            <div
              style={{
                fontSize: 12,
                opacity: 0.75,
              }}
            >
              {botType === 'rebalance' ? 'Rebalancing bot' : 'Webhooks bot'}
            </div>

            {/* Spacer */}
            <div style={{ height: 12 }} />

            {/* Totals */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ fontSize: 18, opacity: 0.9 }}>Total</div>
              <div style={{ fontSize: 36, fontWeight: 800 }}>
                {fmtUsd(typeof totalUsd === 'number' ? totalUsd : 0)}
              </div>
              <div style={{ fontSize: 16, opacity: 0.85 }}>
                P&amp;L:&nbsp;<span style={{ fontWeight: 700 }}>{fmtUsdSigned(pnlUsd ?? 0)}</span>
                {typeof pnlPct === 'number'
                  ? (<>&nbsp;(<span style={{ fontWeight: 700 }}>{fmtPct(pnlPct)}</span>)</>)
                  : null}
              </div>
              {runtimeText ? (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  runtime:&nbsp;<span style={{ fontWeight: 600 }}>{runtimeText}</span>
                </div>
              ) : null}
            </div>

            {/* Spacer */}
            <div style={{ height: 16 }} />

            {/* Metrics (right column area) */}
            <div
              style={{
                position: 'absolute',
                left: 24,
                right: 24,
                bottom: 44,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {botType === 'rebalance' ? (
                <>
                  {typeof cadenceHours === 'number' ? (
                    <div style={{ display: 'flex', fontSize: 14, opacity: 0.95 }}>
                      <div style={{ width: 120, opacity: 0.75 }}>Cadence</div>
                      <div style={{ fontWeight: 700 }}>{fmtInt(cadenceHours)}h</div>
                    </div>
                  ) : null}

                  {/* Spacer */}
                  <div style={{ height: 8 }} />

                  {typeof totalRebalances === 'number' ? (
                    <div style={{ display: 'flex', fontSize: 14, opacity: 0.95 }}>
                      <div style={{ width: 120, opacity: 0.75 }}>Rebalances</div>
                      <div style={{ fontWeight: 700 }}>{fmtInt(totalRebalances)}</div>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  {/* Webhooks metrics */}
                  {typeof bestTradeUsd === 'number' ? (
                    <div style={{ display: 'flex', fontSize: 14, opacity: 0.95 }}>
                      <div style={{ width: 120, opacity: 0.75 }}>Best trade</div>
                      <div style={{ fontWeight: 700 }}>{fmtUsdSigned(bestTradeUsd)}</div>
                    </div>
                  ) : null}

                  {/* Spacer */}
                  <div style={{ height: 8 }} />

                  {typeof computedTotalTrades === 'number' ? (
                    <div style={{ display: 'flex', fontSize: 14, opacity: 0.95 }}>
                      <div style={{ width: 120, opacity: 0.75 }}>Total trades</div>
                      <div style={{ fontWeight: 700 }}>{fmtInt(computedTotalTrades)}</div>
                    </div>
                  ) : null}

                  {/* Spacer */}
                  <div style={{ height: 8 }} />

                  {typeof wins === 'number' ? (
                    <div style={{ display: 'flex', fontSize: 14, opacity: 0.95 }}>
                      <div style={{ width: 120, opacity: 0.75 }}>Wins</div>
                      <div style={{ fontWeight: 700 }}>{fmtInt(wins)}</div>
                    </div>
                  ) : null}

                  {/* Spacer */}
                  <div style={{ height: 8 }} />

                  {typeof losses === 'number' ? (
                    <div style={{ display: 'flex', fontSize: 14, opacity: 0.95 }}>
                      <div style={{ width: 120, opacity: 0.75 }}>Losses</div>
                      <div style={{ fontWeight: 700 }}>{fmtInt(losses)}</div>
                    </div>
                  ) : null}

                  {/* Spacer */}
                  <div style={{ height: 8 }} />

                  {typeof computedWinRate === 'number' ? (
                    <div style={{ display: 'flex', fontSize: 14, opacity: 0.95 }}>
                      <div style={{ width: 120, opacity: 0.75 }}>Win rate</div>
                      <div style={{ fontWeight: 700 }}>{formatNumber(clamp(computedWinRate, -100, 100), 2)}%</div>
                    </div>
                  ) : null}
                </>
              )}
            </div>

            {/* Footer */}
            <div
              style={{
                position: 'absolute',
                left: 16,
                bottom: 12,
                fontSize: 12,
                opacity: 0.6,
              }}
            >
              generated by mojomaxi.com
            </div>
          </div>
        </div>
      ),
      { width: WIDTH, height: HEIGHT },
    );

    if (dl) {
      res.headers.set('Content-Disposition', 'attachment; filename="mojomaxi-pnl.png"');
    }
    res.headers.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    return res;

  } catch (e: any) {
    const msg = String(e?.message || e);

    // --- Minimal Satori fallback (still PNG) ---
    try {
      const fallback = new ImageResponse(
        (
          <div
            style={{
              width: WIDTH,
              height: HEIGHT,
              backgroundColor: '#0A0A0A',
              color: '#FAFAFA',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 18, opacity: 0.9 }}>{botType === 'rebalance' ? 'Rebalancing bot' : 'Webhooks bot'}</div>
            <div style={{ height: 6 }} />
            <div style={{ fontSize: 28, fontWeight: 800 }}>{setTitle || 'mojomaxi bot'}</div>
            <div style={{ height: 12 }} />
            <div style={{ fontSize: 36, fontWeight: 800 }}>{fmtUsd(typeof totalUsd === 'number' ? totalUsd : 0)}</div>
            <div style={{ fontSize: 16, opacity: 0.85 }}>
              P&amp;L:&nbsp;<span style={{ fontWeight: 700 }}>{fmtUsdSigned(pnlUsd ?? 0)}</span>
              {typeof pnlPct === 'number' ? (<> &nbsp;(<span style={{ fontWeight: 700 }}>{fmtPct(pnlPct)}</span>)</>) : null}
            </div>
            {runtimeText ? (
              <>
                <div style={{ height: 6 }} />
                <div style={{ fontSize: 12, opacity: 0.7 }}>runtime: <span style={{ fontWeight: 600 }}>{runtimeText}</span></div>
              </>
            ) : null}
          </div>
        ),
        { width: WIDTH, height: HEIGHT },
      );
      if (dl) {
        fallback.headers.set('Content-Disposition', 'attachment; filename="mojomaxi-pnl.png"');
      }
      fallback.headers.set('Cache-Control', 'public, max-age=60, s-maxage=60');
      fallback.headers.set('x-satori-error', msg);
      return fallback;

    } catch (e2: any) {
      const msg2 = String(e2?.message || e2);

      // If tracing, return JSON with the error detail
      if (debug || trace) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: msg,
            errorStack: (e as any)?.stack,
            fallbackError: msg2,
            fallbackStack: (e2 as any)?.stack,
            params: {
              setTitle,
              botType,
              totalUsd,
              pnlUsd,
              pnlPct,
              runtimeSec,
              bestTradeUsd,
              totalTrades,
              wins,
              losses,
              winRatePct: computedWinRate,
              cadenceHours,
              totalRebalances,
              startedAt,
              runtimeText,
              ultra,
            },
          }, null, 2),
          { status: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
        );
      }

      // Final ultra-safe fallback that avoids Satori entirely (SVG)
      try {
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <style>
      .t1 { font: 22px sans-serif; fill: #FAFAFA; }
      .t2 { font: 40px sans-serif; fill: #FAFAFA; font-weight: 700; }
      .t3 { font: 14px sans-serif; fill: #FAFAFA; }
    </style>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#0A0A0A"/>\n  ${bgDataUrl ? '<image href="' + bgDataUrl + '" x="0" y="0" width="' + WIDTH + '" height="' + HEIGHT + '" opacity="' + (ultra ? 0.12 : 0.20) + '"/>' : ''}
  <text x="24" y="64" class="t1">${botType === 'rebalance' ? 'Rebalancing bot' : 'Webhooks bot'}</text>
  <text x="24" y="116" class="t2">${(setTitle || 'mojomaxi bot').replace(/&/g,'&amp;')}</text>
  <text x="24" y="176" class="t1">Total: ${fmtUsd(typeof totalUsd === 'number' ? totalUsd : 0)}</text>
  <text x="24" y="208" class="t1">P&amp;L: ${fmtUsdSigned(pnlUsd ?? 0)}${typeof pnlPct === 'number' ? ` (${fmtPct(pnlPct)})` : ''}</text>
  ${runtimeText ? `<text x="24" y="236" class="t3">runtime: ${runtimeText}</text>` : ''}
  <text x="24" y="${HEIGHT - 16}" class="t3">generated by mojomaxi.com</text>
</svg>`;
        const headers: Record<string, string> = {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=60, s-maxage=60',
          'x-satori-error': msg2 || msg,
        };
        if (dl) headers['Content-Disposition'] = 'attachment; filename="mojomaxi-pnl.svg"';
        return new Response(svg, { status: 200, headers });
      } catch {
        return new Response('Failed to generate image', { status: 500 });
      }
    }
  }
}
