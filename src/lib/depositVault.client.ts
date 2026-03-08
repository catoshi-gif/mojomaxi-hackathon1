// filepath: src/lib/depositVault.client.ts
// PURPOSE: Small client helper used by panels to initiate a deposit flow via /api/vaults/deposit.
//          Does NOT alter UI; only shapes the POST and validates the response.
// BEHAVIOR: Keeps your prior request/response shape intact.
// SAFETY: We send atoms when provided; otherwise send UI + decimals (server converts).

export type DepositVaultArgs = {
  ownerPubkey: string;
  setId: string;
  depositMint: string;      // Token B in your UX
  tokenAMint?: string;      // optional: pre-create vault A-ATA
  tokenBMint?: string;      // optional: pre-create vault B-ATA
  amountAtoms?: string;     // preferred: atoms as string (exact)
  amountUi?: string;        // alternative: UI string; requires `decimals`
  decimals?: number;        // optional; required when using amountUi
};

export type DepositVaultResult = {
  ok: true;
  txBase64: string;
  vaultPda: string;
  createdAtas: string[];
  deposit: { mint: string; authorityAta: string; amount: string; decimals: number };
};

export async function depositVault(args: DepositVaultArgs): Promise<DepositVaultResult> {
  const { ownerPubkey, setId, depositMint, tokenAMint, tokenBMint, amountAtoms, amountUi, decimals } = args;

  const body: Record<string, unknown> = {
    ownerPubkey,
    setId,
    mint: depositMint,
  };

  if (tokenAMint) body.tokenAMint = tokenAMint;
  if (tokenBMint) body.tokenBMint = tokenBMint;

  if (typeof amountAtoms === "string" && amountAtoms.trim().length) {
    body.amount = amountAtoms;
  } else if (typeof amountUi === "string" && amountUi.trim().length) {
    body.amountUi = amountUi;
    if (typeof decimals === "number") body.decimals = decimals;
  } else {
    throw new Error("amount_required");
  }

  const res = await fetch("/api/vaults/deposit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok || !json?.ok) {
    throw new Error(json?.detail || json?.error || "deposit_failed");
  }
  return json as DepositVaultResult;
}
