// filepath: src/app/help/faq/page.tsx
"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function FAQPage() {
  return (
    <main className="mm-full-bleed relative isolate min-h-[100svh] w-full overflow-hidden bg-[#0A0A0A] text-slate-100">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-64 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(45,212,191,0.45),transparent_65%)] opacity-80" />
        <div className="absolute -bottom-40 left-[-10rem] h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle_at_center,rgba(236,72,153,0.45),transparent_70%)] opacity-80" />
        <div className="absolute -bottom-56 right-[-12rem] h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.5),transparent_70%)] opacity-80" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(148,163,184,0.18),transparent_60%)] opacity-40" />
      </div>

      <div className="relative mx-auto max-w-5xl px-4 pb-20 pt-24 sm:px-6 lg:px-8 lg:pb-24 lg:pt-28 space-y-10">
        <div className="text-sm text-white/60">
          <Link href="/help" className="underline underline-offset-4">help</Link> / faq
        </div>

        <h1 className="text-4xl sm:text-5xl font-semibold bg-gradient-to-r from-sky-400 via-cyan-300 to-emerald-300 bg-clip-text text-transparent">
          frequently asked questions
        </h1>

        <Card className="border-white/10 bg-white/[0.02] backdrop-blur-xl">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">general</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-white/80">
            <div>
              <strong>is mojomaxi custodial?</strong>
              <p>no. vaults are program derived keyless accounts — only your wallet can ever withdraw funds.</p>
            </div>

            <div>
              <strong>fees?</strong>
              <p>0.25% on executed swaps only.</p>
            </div>

            <div>
              <strong>who pays gas?</strong>
              <p>our relayer covers all SOL gas fees on bot transactions, this is made sustainable with the small 0.25% treasury fee that we charge on swap executions.</p>
            </div>

            <div>
              <strong>what if site is down?</strong>
              <p>vaults + program live on chain; UI downtime ≠ funds risk. you can deposit or withdraw as soon as the site comes back online. in the unlikely event that the site goes down temporarily, swaps will not be orchestrated on-chain, but your funds are safe in your vault since on-chain logic does not change.</p>
            </div>
            <div>
              <strong>why do i have to pay to create a vault?</strong>
              <p>to create an anchor vault on-chain so your bot can run, the blockchain charges our program lamports to create it and to warm the token accounts for your strategy to run, we do not take any profit on vault creation, this small SOL fee goes directly to create your vault on the blockchain.</p>
            </div>
            <div>
              <strong>support</strong>
              <p>open a discord ticket — never share private keys, our mods will never DM you.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
