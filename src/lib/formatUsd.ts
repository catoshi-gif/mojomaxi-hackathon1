
// src/lib/formatUsd.ts
// Dynamic USD unit price formatter for very small tokens (e.g., BONK)
// Use ONLY for *per-token* unit prices. For totals, keep standard 2-decimal USD.

export function formatUsdUnitDynamic(price?: number | null): string {
  if (price == null || !Number.isFinite(Number(price))) return "$—";
  const p = Number(price);
  let decimals = 2;
  if (p < 1) {
    if (p >= 0.1) decimals = 3;
    else if (p >= 0.01) decimals = 4;
    else if (p >= 0.001) decimals = 5;
    else if (p >= 0.0001) decimals = 6;
    else if (p >= 0.00001) decimals = 7;
    else decimals = 8;
  }
  return p.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
