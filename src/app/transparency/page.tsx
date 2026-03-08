// filepath: src/app/transparency/page.tsx
// download-as: transparency-page-23b1a4.txt
"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function GradientH1({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mb-2 text-4xl font-semibold leading-tight tracking-tight">
      <span className="bg-gradient-to-r from-emerald-400 via-cyan-300 to-sky-400 bg-clip-text text-transparent">
        {children}
      </span>
    </h1>
  );
}

function CodeBlock({ code, filename }: { code: string; filename?: string }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }
  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-between text-xs text-white/60">
        <div className="truncate">{filename}</div>
        <button
          onClick={copy}
          className="rounded-md border border-white/10 px-2 py-1 hover:border-white/20"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-auto rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-white/90">
        {code}
      </pre>
    </div>
  );
}

// ---- Embed scripts as raw strings so the page can show exact contents ----
// IMPORTANT: no backticks or ${...} inside this string, so Next/TS parser
// treats it as plain text.
const VERIFY_CONFIG_TS = `// scripts/verify-config.ts
//
// Mojomaxi Transparency Tool
// Verifies the global Config PDA, its owner, the authority, and the allowed relayer set.
//
// Usage (from repo root):
//   npx ts-node scripts/verify-config.ts
//
// With explicit authority check:
//   EXPECTED_AUTHORITY=<pubkey> npx ts-node scripts/verify-config.ts
//
// With explicit relayer checks (comma-separated):
//   EXPECTED_RELAYERS=<pk1,pk2,...> npx ts-node scripts/verify-config.ts
//
// JSON output for bots/CI:
//   JSON=1 npx ts-node scripts/verify-config.ts
//
// Custom RPC:
//   SOLANA_RPC_URL=https://your-rpc.example npx ts-node scripts/verify-config.ts

import { Connection, PublicKey } from "@solana/web3.js";

// ----- Constants (match on-chain program) -----
const PROGRAM_ID = new PublicKey("2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp"); // Mojomaxi Vault
const CONFIG_SEED = "config"; // seeds = [b"config"] with PROGRAM_ID

// Optional policy checks (warn if exceeded)
const MAX_RELAYER_COUNT = Number(process.env.MAX_RELAYER_COUNT ?? 32);

// RPC selection
const RPC_URL =
  process.env.ANCHOR_PROVIDER_URL ||
  process.env.SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

// Optional expectations
const EXPECTED_AUTHORITY = process.env.EXPECTED_AUTHORITY
  ? new PublicKey(process.env.EXPECTED_AUTHORITY)
  : null;

const EXPECTED_RELAYERS = (process.env.EXPECTED_RELAYERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const WANT_JSON = process.env.JSON === "1" || process.env.JSON === "true";

// ---- Helpers ----
function u32le(view: Uint8Array, off: number): number {
  return (
    (view[off] |
      (view[off + 1] << 8) |
      (view[off + 2] << 16) |
      (view[off + 3] << 24)) >>> 0
  );
}

function finish(result: any, code: number): never {
  if (WANT_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("RPC_URL:", result.rpcUrl);
    console.log("Program ID:", result.programId);
    console.log("Derived Config PDA:", result.configPda, "(bump:", result.bump + ")");
    if (!result.exists) {
      console.log("Config PDA does NOT exist on-chain.");
      process.exit(code);
    }
    console.log("Config owner:", result.owner);
    console.log("Authority:", result.authority);
    console.log("Relayer count:", result.relayers.length);
    console.log("Allowed relayers:");
    (result.relayers as string[]).forEach((r, i) => {
      console.log("  [" + i + "] " + r);
    });

    if (result.warnings.length) {
      console.log("");
      console.log("Warnings:");
      (result.warnings as string[]).forEach((w) => console.log("  WARNING:", w));
    }
    if (result.errors.length) {
      console.log("");
      console.log("Errors:");
      (result.errors as string[]).forEach((e) => console.log("  ERROR:", e));
    }

    console.log("");
    console.log("Checks:", JSON.stringify(result.checks, null, 2));
  }
  process.exit(code);
}

async function main() {
  const [configPda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(CONFIG_SEED)],
    PROGRAM_ID
  );

  const conn = new Connection(RPC_URL, "confirmed");
  const acc = await conn.getAccountInfo(configPda);

  const result: any = {
    rpcUrl: RPC_URL,
    programId: PROGRAM_ID.toBase58(),
    configPda: configPda.toBase58(),
    bump,
    exists: !!acc,
    owner: acc ? acc.owner.toBase58() : null,
    dataLen: acc?.data.length ?? 0,
    authority: null as string | null,
    relayers: [] as string[],
    checks: {
      ownerMatchesProgram: false,
      authorityMatchesExpected: EXPECTED_AUTHORITY ? false : null,
      expectedRelayersAllPresent: EXPECTED_RELAYERS.length ? false : null,
      noUnexpectedRelayers: EXPECTED_RELAYERS.length ? false : null,
      relayerCountWithinBound: null as null | boolean,
    },
    warnings: [] as string[],
    errors: [] as string[],
  };

  if (!acc) {
    result.errors.push("Config PDA does NOT exist on-chain.");
    return finish(result, 2);
  }

  // Owner must be the Mojomaxi Vault program
  result.checks.ownerMatchesProgram = acc.owner.equals(PROGRAM_ID);
  if (!result.checks.ownerMatchesProgram) {
    result.errors.push("Config account is not owned by the Mojomaxi Vault program.");
    return finish(result, 2);
  }

  // Anchor account layout:
  // [0..8): discriminator (ignored)
  // [8..40): authority (Pubkey)
  // [40..44): allowed_relayers length (u32 LE)
  // [44..]: allowed_relayers (len * 32 bytes)
  const data = acc.data;
  if (data.length < 44) {
    result.errors.push("Config account too small / unexpected layout.");
    return finish(result, 2);
  }

  const authority = new PublicKey(data.slice(8, 40));
  result.authority = authority.toBase58();

  const len = u32le(data, 40);
  const relayers: string[] = [];
  let off = 44;
  for (let i = 0; i < len; i++) {
    const end = off + 32;
    if (end > data.length) {
      result.warnings.push(
        "Truncated relayer list: expected " + len + ", but data ended at index " + i + "."
      );
      break;
    }
    relayers.push(new PublicKey(data.slice(off, end)).toBase58());
    off = end;
  }
  result.relayers = relayers;

  // Policy / expectation checks
  if (EXPECTED_AUTHORITY) {
    result.checks.authorityMatchesExpected = authority.equals(EXPECTED_AUTHORITY);
    if (!result.checks.authorityMatchesExpected) {
      result.errors.push(
        "Authority does NOT match EXPECTED_AUTHORITY (" + EXPECTED_AUTHORITY.toBase58() + ")."
      );
    }
  }

  if (EXPECTED_RELAYERS.length) {
    const set = new Set(relayers);
    const expectedSet = new Set(EXPECTED_RELAYERS);

    const missing = EXPECTED_RELAYERS.filter((pk) => !set.has(pk));
    const unexpected = relayers.filter((pk) => !expectedSet.has(pk));

    result.checks.expectedRelayersAllPresent = missing.length === 0;
    result.checks.noUnexpectedRelayers = unexpected.length === 0;

    if (missing.length) {
      result.errors.push("Missing relayers: " + missing.join(", "));
    }
    if (unexpected.length) {
      result.errors.push("Unexpected relayers present: " + unexpected.join(", "));
    }
  }

  if (typeof MAX_RELAYER_COUNT === "number") {
    result.checks.relayerCountWithinBound = relayers.length <= MAX_RELAYER_COUNT;
    if (!result.checks.relayerCountWithinBound) {
      result.warnings.push(
        "Relayer count " + relayers.length + " exceeds bound " + MAX_RELAYER_COUNT + "."
      );
      // Not fatal, but recommended to enforce on-chain.
    }
  }

  return finish(result, result.errors.length ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
`;

export default function TransparencyPage() {
  const anchors = {
    programId: "2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp",
    configPda: "6cnE3hVoWCdZtbrc7GbBcBFNvYgcjUiErdQhkCYYbhTe",
    authority: "14DGCcU6QuKeiU4xcnWpFkcfFXJVr1oPcyPEd7u9tftp",
    relayers: ["6sHBrwXdSSAyHHCtqxqTSYA6uovGjxuRfLnfESDxdeBZ"], // current relayer
  };

  return (
    <div className="space-y-8">
      <header>
        <GradientH1>Transparency &amp; On-chain Audit</GradientH1>
        <p className="text-white/70">
          Reproduce our governance checks yourself. This page publishes the public anchors and the scripts required to verify them from chain.
        </p>
      </header>

      {/* Public anchors */}
      <Card>
        <CardHeader>
          <CardTitle>Public anchors (mainnet-beta)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-white/80">
          <div>
            Program ID:{" "}
            <code className="rounded bg-white/10 px-1 py-0.5">
              {anchors.programId}
            </code>
          </div>
          <div>
            Config PDA:{" "}
            <code className="rounded bg-white/10 px-1 py-0.5">
              {anchors.configPda}
            </code>{" "}
            (seeds: <code>["config"]</code>)
          </div>
          <div>
            Config authority:{" "}
            <code className="rounded bg-white/10 px-1 py-0.5">
              {anchors.authority}
            </code>
          </div>
          <div>
            Allowed relayer(s):{" "}
            {anchors.relayers.map((r, i) => (
              <code
                key={i}
                className="ml-1 rounded bg-white/10 px-1 py-0.5"
              >
                {r}
              </code>
            ))}
          </div>
          <p className="mt-2 text-white/60">
            Notes: The Config account is a one-time init PDA; it cannot be re-initialized. Swap
            entrypoints require the caller to be allowlisted in <em>Config.allowed_relayers</em>.
          </p>
        </CardContent>
      </Card>

      {/* How to run */}
      <Card>
        <CardHeader>
          <CardTitle>Run the verifier locally</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="list-decimal space-y-2 pl-6 text-white/80 text-sm">
            <li>
              Install dev deps:{" "}
              <code className="rounded bg-white/10 px-1 py-0.5">
                npm i -D ts-node @solana/web3.js
              </code>
            </li>
            <li>
              Save the script below as{" "}
              <code className="rounded bg-white/10 px-1 py-0.5">
                scripts/verify-config.ts
              </code>{" "}
              in your repo root.
            </li>
            <li>
              Run:{" "}
              <code className="rounded bg-white/10 px-1 py-0.5">
                npx ts-node scripts/verify-config.ts
              </code>
            </li>
            <li>
              Optional checks:
              <div className="mt-1">
                <code className="rounded bg-white/10 px-1 py-0.5">
                  EXPECTED_AUTHORITY={anchors.authority} EXPECTED_RELAYERS=
                  {anchors.relayers[0]}
                </code>{" "}
                <code className="rounded bg-white/10 px-1 py-0.5">
                  npx ts-node scripts/verify-config.ts
                </code>
              </div>
            </li>
          </ol>
          <CodeBlock filename="scripts/verify-config.ts" code={VERIFY_CONFIG_TS} />
        </CardContent>
      </Card>

      {/* Why this exists */}
      <Card>
        <CardHeader>
          <CardTitle>Why this page exists</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-white/80 space-y-2">
          <p>
            mojomaxi vaults are self-custody at the user level (withdrawals are admin-only to the
            admin’s canonical ATA), while execution is governed by an allowlisted relayer set held
            in the global Config PDA. Publishing these anchors and scripts lets anyone verify that
            governance root on-chain.
          </p>
          <p className="text-white/60">
            Smart contracts are not yet third-party audited; use at your own risk. See the docs for current
            upgrade-authority posture and governance plans.
          </p>
          <div className="pt-2">
            <Link href="/help" className="underline">
              Back to Help &amp; Docs →
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
