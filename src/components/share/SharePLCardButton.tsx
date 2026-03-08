// filepath: src/components/share/SharePLCardButton.tsx
'use client';

/**
 * THE GOLDEN RULE: This replacement preserves all existing functionality and adds
 * backward-compat support for legacy prop shapes used throughout the app.
 *
 * It accepts BOTH:
 *   1) The new `shareParams` object (preferred)
 *   2) Legacy props like `title`, `pnlUsd`, `currentUsd`, `vaultType`, `setId`
 *
 * No UI/UX changes and no breaking changes for existing call-sites.
 */

import * as React from 'react';
import { buildPnlCardUrl, type PnlShareParams } from '@/lib/pnlShare';

type VaultType = 'webhooks' | 'rebalance' | 'other';

/** Preferred: a single object of PnL share parameters (minus botType). */
type PreferredProps = {
  /** Which family of bot (affects labels on the card). */
  botType?: VaultType;
  /** All other params to forward to the image endpoint. */
  shareParams?: Omit<PnlShareParams, 'botType'>;
};

/** Legacy: scattered props still used in some places (e.g., MetricsPanel). */
type LegacyProps = {
  /** Legacy alias for set title on the card. */
  title?: string;
  /** Legacy totals — mapped into PnlShareParams. */
  pnlUsd?: number;
  currentUsd?: number;
  /** Legacy alias for the family of bot. */
  vaultType?: Extract<VaultType, 'webhooks' | 'rebalance'>;
  /** Optional: kept for callers that pass it (not used in URL building). */
  setId?: string;
};

export interface SharePLCardButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    PreferredProps,
    LegacyProps {
  /** Download filename hint. */
  filename?: string;
}

function coerceNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v as any);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Merge the legacy scatter-shot props with the preferred `shareParams` shape.
 * - `shareParams` wins if both provide the same field (explicit > inferred).
 * - We translate `title` -> `setTitle` and `currentUsd` -> `totalUsd`.
 */
function buildMergedParams(
  botType: VaultType,
  shareParams: SharePLCardButtonProps['shareParams'],
  legacy: LegacyProps
): PnlShareParams {
  const inferred: Omit<PnlShareParams, 'botType'> = {
    setTitle: legacy.title,
    totalUsd: coerceNumber(legacy.currentUsd),
    pnlUsd: coerceNumber(legacy.pnlUsd),
  };

  const merged: PnlShareParams = {
    botType,
    ...inferred,
    ...(shareParams ?? {}),
  };

  // Normalize a couple of fields in case legacy values are strings
  if (typeof merged.totalUsd !== 'undefined') {
    merged.totalUsd = coerceNumber(merged.totalUsd) ?? merged.totalUsd;
  }
  if (typeof merged.pnlUsd !== 'undefined') {
    merged.pnlUsd = coerceNumber(merged.pnlUsd) ?? merged.pnlUsd;
  }

  // Ensure setTitle has a non-empty value
  if (!merged.setTitle || String(merged.setTitle).trim() === '') {
    merged.setTitle = 'mojomaxi bot';
  }

  return merged;
}

export function SharePLCardButton(props: SharePLCardButtonProps) {
  const {
    children,
    className,
    filename,
    botType: botTypeMaybe,
    vaultType,
    shareParams,
    // keep legacy props intact; they may arrive from older call-sites
    title,
    pnlUsd,
    currentUsd,
    setId,
    ...btnProps
  } = props;

  // Prefer the explicit `botType`, then legacy alias, defaulting to webhooks
  const botType: VaultType = botTypeMaybe ?? (vaultType as VaultType) ?? 'webhooks';

  const handleClick = React.useCallback(() => {
    try {
      const merged = buildMergedParams(botType, shareParams, {
        title,
        pnlUsd,
        currentUsd,
        vaultType: vaultType as any,
        setId,
      });

      const url = buildPnlCardUrl({
        ...merged,
        dl: true,
        cb: Date.now(),
      });

      // Prefer an <a download> so Mobile Safari honors it.
      const a = document.createElement('a');
      a.href = url;
      a.setAttribute('download', filename || 'mojomaxi-pnl.png');
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      // Never blow up the calling component — this is a debug utility button.
      console.error('SharePLCardButton error:', e);
    }
  }, [
    botType,
    shareParams,
    title,
    pnlUsd,
    currentUsd,
    vaultType,
    setId,
    filename,
  ]);

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      {...btnProps}
    >
      {children ?? 'Download PNG'}
    </button>
  );
}

export default SharePLCardButton;
