// filepath: src/app/help/architecture/page.tsx
"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Vault Architecture, Routing & Safety — dedicated page.
 * - Contains the full architecture section + transparency snippet from original /help.
 */

function GradientH1({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
      <span className="bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-300 bg-clip-text text-transparent">
        {children}
      </span>
    </h1>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md bg-white/10 px-2 py-1 font-mono text-[12px] text-white">
      {children}
    </code>
  );
}

export default function ArchitecturePage() {
  return (
    <main className="mm-full-bleed relative isolate min-h-[100svh] w-full overflow-hidden bg-[#0A0A0A] text-slate-100">
      {/* background gradients */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-64 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(45,212,191,0.45),transparent_65%)] opacity-80" />
        <div className="absolute -bottom-40 left-[-10rem] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle_at_center,rgba(236,72,153,0.45),transparent_70%)] opacity-80" />
        <div className="absolute -bottom-56 right-[-12rem] h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.5),transparent_70%)] opacity-80" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(148,163,184,0.18),transparent_60%)] opacity-40" />
      </div>

      {/* center line */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-emerald-400/0 via-emerald-400/25 to-transparent"
      />

      <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-24 sm:px-6 lg:px-8 lg:pb-24 lg:pt-28 space-y-10">
        {/* breadcrumb */}
        <div className="text-sm text-white/60">
          <Link href="/help" className="underline underline-offset-4">
            Help
          </Link>{" "}
          / Vault Architecture &amp; Safety
        </div>

        {/* HERO */}
        <GradientH1>Vault Architecture, Routing &amp; Safety</GradientH1>

        {/* main architecture card */}
        <Card className="border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
          <CardContent className="space-y-4 pt-6 text-sm text-slate-200">
            <p>
              Both the TradingView Webhooks bot and the Rebalance Basket bot run on the same Solana Anchor vault
              program. each bot set gets its own vault PDA, so funds stay in program-owned accounts you control.
            </p>

            <div className="grid gap-6 md:grid-cols-3">
              {/* vaults & custody */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                  Vaults &amp; Custody
                </h3>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Vaults are non-custodial <strong>Anchor PDAs</strong> created per bot set — you never deposit into a
                    centralized or hosted exchange wallet.
                  </li>
                  <li>
                    Neither mojomaxi nor the relayer can withdraw funds; only the vault admin (you) can withdraw, and only to
                    their wallet&apos;s canonical associated token accounts (ATAs) for the mints configured in that set.
                  </li>
                  <li>
                    Per-set vaults lock in the selected tokens (Token A/B pairs or basket mints 1-6(up to 20 for pro). Always deposit via the
                    mojomaxi dashboard; direct manual transfers to a vault address may not be recognized by the program
                    and might not be recoverable.
                  </li>
                </ul>
              </div>

              {/* routing, fees & gas */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                  Routing, Fees &amp; Gas
                </h3>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Swaps route via <strong>Jupiter&apos;s on-chain aggregator (CPI swaps)</strong> using
                    best-available routing at execution time (within CPI program constraints).
                  </li>
                  <li>
                    A platform fee of <strong>0.25% (25 bps)</strong> on token swaps is directed to our treasury wallet{" "}
                    <Code>5mEqxr6McBRL5DGE9dJ2Td3viwhAmRpe4V7pqGTPMtvr</Code>.
                  </li>
                  <li>
                    SOL gas for all TradingView and Rebalance bot swaps is paid by our relayer{" "}
                    <Code>6sHBrwXdSSAyHHCtqxqTSYA6uovGjxuRfLnfESDxdeBZ</Code> and made sustainable from the 0.25%
                    treasury fees that we take on each swap (with a $100 minimum starting balance).
                  </li>
                </ul>
              </div>

              {/* tokens & transparency */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
                  tokens &amp; transparency
                </h3>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    <strong>Supported token programs:</strong> SPL (for all accounts) and Token‑2022 (with an active
                    Mojo Pro subscription).
                  </li>
                  <li>
                    The <strong>Activity</strong> panel shows deposits, withdrawals, buys, sells, and rebalances so you
                    can audit what happened on-chain.
                  </li>
                  <li>
                    Vault Program ID: <Code>2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp</Code>.
                  </li>
                  <li>
                    IDL JSON:{" "}
                    <Link href="/idl/mojomaxi_vault.json" className="underline underline-offset-4">
                      /idl/mojomaxi_vault.json
                    </Link>{" "}
                    (also visible on-chain under the program address above).
                  </li>
                  <li>
                    Routing and uptime depend on Solana, Jupiter, RPC and website network services. Temporary site downtime does not put funds at risks, trades will continue when service returns.
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* transparency & audit card from original help page */}
        <Card className="border-white/10 bg-white/[0.02] shadow-[0_22px_80px_rgba(15,23,42,0.9)] backdrop-blur-xl">
          <CardHeader>
            <CardTitle className="text-base font-semibold text-slate-100">
              Transparency &amp; Audit
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="mt-2 text-sm text-white/80">
              Verify our on-chain governance root (Config PDA), authority, and allowed relayers yourself. We publish
              scripts and public anchors so power users and auditors can reproduce all checks directly from chain.
            </p>
            <div className="mt-3">
              <Link
                href="/transparency"
                className="text-sm underline underline-offset-4"
              >
                Open the Transparency Page →
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* support footer */}
        <div className="text-sm text-white/60">
          If you&apos;re doing deeper protocol or integration work and need clarification on vault behavior, open a
          ticket in discord and mention that you&apos;re reviewing the architecture docs.
        </div>
      </div>
    </main>
  );
}
