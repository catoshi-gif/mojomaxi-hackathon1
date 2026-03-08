// filepath: src/lib/subscriptions.client.ts
"use client";

import { VersionedTransaction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

type IntentResp = {
  ok: boolean;
  txBase64?: string;
  amountUsd?: number;
  _meta?: any;
  error?: string;
  hint?: string;
};

export async function subscribeAndConfirm(opts: {
  strategySlug: string;          // e.g., "mojo-pro-sol"
  amountUsd: number;             // e.g., 20
  owner: string;                 // wallet public key base58
  connection: Connection;
  wallet: WalletContextState;    // from @solana/wallet-adapter-react
  abortSignal?: AbortSignal;
}) {
  const { strategySlug, amountUsd, owner, connection, wallet, abortSignal } = opts;

  // 1) Fetch the intent to get the transaction
  const intentRes = await fetch(`/api/subs/${encodeURIComponent(strategySlug)}/intent?owner=${owner}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUsd, owner }),
    signal: abortSignal,
  }).then(r => r.json() as Promise<IntentResp>);

  if (!intentRes?.ok || !intentRes.txBase64) {
    throw new Error(intentRes?.error || "intent_failed");
  }

  // 2) Deserialize, sign & send
  const tx = VersionedTransaction.deserialize(Buffer.from(intentRes.txBase64, "base64"));
  const sig = await wallet.sendTransaction(tx, connection, { skipPreflight: false });

  // 3) Confirm + log on backend
  const confirmBody = { wallet: owner, signature: sig, amountUsd };
  const confirm = await fetch(`/api/subs/${encodeURIComponent(strategySlug)}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmBody),
    signal: abortSignal,
  }).then(r => r.json());

  if (!confirm?.ok) {
    // fallback to GET to cover clients that block POST
    const u = new URL(location.origin + `/api/subs/${encodeURIComponent(strategySlug)}/confirm`);
    u.searchParams.set("wallet", owner);
    u.searchParams.set("signature", sig);
    u.searchParams.set("amountUsd", String(amountUsd));
    const confirm2 = await fetch(u.toString(), { method: "GET", signal: abortSignal }).then(r => r.json());
    if (!confirm2?.ok) throw new Error(confirm2?.error || confirm?.error || "confirm_failed");
    return { ok: true, signature: sig, amountUsd, status: confirm2?.status };
  }

  return { ok: true, signature: sig, amountUsd, status: confirm?.status };
}
