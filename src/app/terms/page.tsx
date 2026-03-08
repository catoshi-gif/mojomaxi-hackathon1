// filepath: src/app/terms/page.tsx
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

export default function TermsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-6">
        <GradientH1>Terms of Service</GradientH1>
        <p className="text-sm text-white/70">
          Last updated: {new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
        </p>
      </div>

      <div className="space-y-4">
        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Important disclaimer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <p>
              Mojomaxi provides software tooling and automation to help you interact with decentralized networks. Crypto
              assets are volatile and risky. You are solely responsible for decisions, configuration, and transactions you
              authorize.
            </p>
            <p>Mojomaxi is not a broker, advisor, or custodian. We do not provide investment advice.</p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Non-custodial</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <p>
              You control your wallet keys. Transactions are executed via your wallet and/or on-chain programs you
              authorize. We cannot recover funds if you approve a malicious transaction or send assets to the wrong place.
            </p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Service availability</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <p>
              The service may be unavailable due to maintenance, network congestion, RPC issues, or third-party outages.
              Automation is best-effort; never rely on it as your only risk control.
            </p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Prohibited use</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <ul className="list-disc pl-5 space-y-2">
              <li>Attempting to disrupt the service (abuse, scraping, DoS).</li>
              <li>Using Mojomaxi to violate laws or sanctions applicable to you.</li>
              <li>Submitting malicious webhooks or payloads intended to compromise users or infrastructure.</li>
            </ul>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Third-party services</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <p>
              Mojomaxi integrates with third parties (wallet providers, explorers, RPC providers, swap routers). We are not
              responsible for third-party failures, pricing, outages, or policy changes.
            </p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Links</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/75 leading-relaxed">
            <div className="flex flex-wrap gap-2">
              <Link href="/privacy" className="inline-flex items-center justify-center gap-2 rounded-2xl border px-3.5 min-h-[44px] h-9 sm:h-10 text-sm font-medium transition duration-200 active:translate-y-[0.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/40 disabled:opacity-60 disabled:pointer-events-none text-white border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm">Privacy</Link>
              <Link href="/transparency" className="inline-flex items-center justify-center gap-2 rounded-2xl border px-3.5 min-h-[44px] h-9 sm:h-10 text-sm font-medium transition duration-200 active:translate-y-[0.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/40 disabled:opacity-60 disabled:pointer-events-none text-white border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm">Transparency</Link>
              <Link href="/help" className="inline-flex items-center justify-center gap-2 rounded-2xl border px-3.5 min-h-[44px] h-9 sm:h-10 text-sm font-medium transition duration-200 active:translate-y-[0.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/40 disabled:opacity-60 disabled:pointer-events-none text-white border-white/10 bg-white/5 hover:bg-white/10 backdrop-blur-sm">Help</Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
