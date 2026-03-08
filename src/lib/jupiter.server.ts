// DEPRECATED shim: use Jupiter Lite via "@/lib/jupiter-lite"
// This file delegates existing helpers to the Lite API so you don't have to chase imports.

import { jupLiteQuote, jupLiteSwapInstructions, type QuotePlan } from "@/lib/jupiter-lite";

/**
 * getQuote (shim)
 * Matches the previous signature but calls Jupiter Lite under the hood.
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps = 50,
  planOverrides?: Partial<QuotePlan>
) {
  const plan: QuotePlan = {
    onlyDirectRoutes: false,
    restrictIntermediateTokens: true,
    maxAccounts: 64,
    slippageBps,
    ...planOverrides,
  };
  return jupLiteQuote(inputMint, outputMint, String(amount), plan);
}

/**
 * getSwapInstructions (new shim)
 * Convenience wrapper to fetch segmented swap instructions from Jupiter Lite.
 * userPublicKey should be the authority that owns the input/output ATAs (e.g. vault_authority).
 * destinationTokenAccount is the ATA for the OUTPUT mint under that authority.
 */
export async function getSwapInstructions(params: {
  userPublicKey: string;
  destinationTokenAccount: string;
  quoteResponse: any;
  useSharedAccounts?: boolean;
  useTokenLedger?: boolean;
}) {
  return jupLiteSwapInstructions({
    userPublicKey: params.userPublicKey,
    destinationTokenAccount: params.destinationTokenAccount,
    quoteResponse: params.quoteResponse,
    useSharedAccounts: params.useSharedAccounts ?? false,
    useTokenLedger: params.useTokenLedger ?? false,
  });
}

// If you want to remove this shim later, replace imports of "@/lib/jupiter.server"
// with "@/lib/jupiter-lite" and call jupLiteQuote / jupLiteSwapInstructions directly.
