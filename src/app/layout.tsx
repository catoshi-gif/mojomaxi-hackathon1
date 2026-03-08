// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import AbortGuard from "@/app/_components/AbortGuard";
import PwaBootstrap from "@/app/_components/PwaBootstrap";
import SolanaWalletProvider from "./solana/WalletProvider";
import SiteHeader from "@/components/SiteHeader";
import SubscribeModalRoot from "@/components/SubscribeModalRoot";
import TokenMetaProvider from "./_providers/TokenMetaProvider";

const geist = Geist({ subsets: ["latin"] });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.mojomaxi.com";

// P1-1: Next.js 15 requires a separate viewport export for mobile configuration.
// viewport-fit=cover is required for notched Seeker devices to use full screen area.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "mojomaxi", template: "%s • mojomaxi" },
  description: "put your solana signals on autopilot — without giving up custody.",
  // Keep OG/Twitter here; omit 'icons' so we don't double-inject them
  openGraph: {
    title: "mojomaxi",
    description: "decentralized, signal-driven, solana trading.",
    url: "/",
    siteName: "mojomaxi",
    images: ["/mojomaxi-social-card.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "mojomaxi",
    description: "decentralized, signal-driven, solana trading.",
    images: ["/mojomaxi-social-card.png"],
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "mojomaxi" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Icons / PWA */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        {/* Brand-kit: use primary pink for pinned-tab mask color */}
        <link rel="mask-icon" href="/safari-pinned-tab.svg" color="#FD1B77" />
        <link rel="manifest" href="/site.webmanifest" />
        {/* Brand-kit: use brand black for browser/PWA chrome */}
        <meta name="theme-color" content="#0A0A0A" />
      </head>
      {/* Brand-kit: use brand neutrals (falls back to exact hex if Tailwind tokens not present) */}
      <body className={`${geist.className} bg-brandBlack text-brandWhite antialiased`}>
        <AbortGuard />
        <PwaBootstrap />
        <SolanaWalletProvider>
          <TokenMetaProvider>
            <SiteHeader />
            <SubscribeModalRoot />
            <main className="mx-auto w-full max-w-7xl px-6 py-6 md:px-8">
              {children}
            </main>
          </TokenMetaProvider>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
