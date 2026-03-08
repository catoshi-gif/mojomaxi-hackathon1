// filepath: src/app/privacy/page.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function GradientH1({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mb-2 text-3xl font-semibold tracking-tight">
      <span className="bg-gradient-to-r from-fuchsia-400 via-pink-400 to-emerald-300 bg-clip-text text-transparent">
        {children}
      </span>
    </h1>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-6">
        <GradientH1>Privacy Policy</GradientH1>
        <p className="text-sm text-white/70">
          Last updated: {new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
        </p>
      </div>

      <div className="space-y-4">
        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>What Mojomaxi is</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <p>
              Mojomaxi is a non-custodial automation layer for Solana trading workflows. You connect a wallet, configure
              webhook sets, and execute transactions that you authorize via your wallet and/or your configured on-chain
              vault logic.
            </p>
            <p>
              Mojomaxi does not hold your private keys. Wallet connections are handled by wallet providers and standard
              Solana tooling.
            </p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Data we collect</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <span className="font-medium text-white/90">Wallet public address</span> (when you connect), to load your
                sets, vaults, and activity.
              </li>
              <li>
                <span className="font-medium text-white/90">Configuration data</span> you create in-app (webhook sets,
                token selections, preferences) stored in backend storage.
              </li>
              <li>
                <span className="font-medium text-white/90">Operational logs</span> (timestamps, request IDs, route errors)
                to keep the service reliable and secure.
              </li>
              <li>
                <span className="font-medium text-white/90">On-chain data</span> is public; we may display it (e.g., Solscan
                links, signatures).
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Data we do not collect</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <ul className="list-disc pl-5 space-y-2">
              <li>We do not collect or store your private keys or seed phrases.</li>
              <li>We do not sell personal data.</li>
              <li>We do not intentionally store sensitive information (government IDs, exact location, health data, etc.).</li>
            </ul>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Third parties</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <p>
              Mojomaxi may interact with third-party infrastructure such as Solana RPC providers, token metadata services,
              analytics/monitoring, and swap routing services. These providers may receive limited technical information
              necessary to fulfill requests (e.g., IP address, user agent, request timing).
            </p>
            <p>
              Your transactions are recorded on-chain. Explorer links (e.g., Solscan) leave our site and are governed by the
              explorer’s policies.
            </p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Security</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <p>
              We use reasonable measures to protect the service (rate limiting, request validation, security headers). No
              system is perfect; you are responsible for wallet security and verifying transactions before signing.
            </p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <p>
              For privacy questions, contact us via the support links in{" "}
              <Link className="underline text-white/90" href="/help">Help</Link>.
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <Link className="inline-flex items-center justify-center gap-2 rounded-2xl border px-3.5 min-h-[44px] h-9 sm:h-10 text-sm font-medium transition duration-200 active:translate-y-[0.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/40 disabled:opacity-60 disabled:pointer-events-none text-white border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm" href="/terms">Terms</Link>
              <Link className="inline-flex items-center justify-center gap-2 rounded-2xl border px-3.5 min-h-[44px] h-9 sm:h-10 text-sm font-medium transition duration-200 active:translate-y-[0.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/40 disabled:opacity-60 disabled:pointer-events-none text-white border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm" href="/transparency">Transparency</Link>
              <Link className="inline-flex items-center justify-center gap-2 rounded-2xl border px-3.5 min-h-[44px] h-9 sm:h-10 text-sm font-medium transition duration-200 active:translate-y-[0.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/40 disabled:opacity-60 disabled:pointer-events-none text-white border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm" href="/help">Help</Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
