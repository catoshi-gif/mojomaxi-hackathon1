"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import React from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import ConnectWallet from "@/components/ConnectWallet";

const MojoProBadge = dynamic(() => import("@/components/MojoProBadge"), {
  ssr: false,
  loading: () => null,
});

/** Recoverable boundary: if it ever errors, it will reset when resetKey changes */
class Boundary extends React.Component<
  { children: React.ReactNode; resetKey?: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; resetKey?: string }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: any, errorInfo: any) {
    if (typeof window !== "undefined") {
      console.error("[SiteHeader Boundary]", error, errorInfo);
    }
  }
  componentDidUpdate(
    prevProps: Readonly<{ children: React.ReactNode; resetKey?: string }>
  ) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children as any;
  }
}

function WalletScopedBoundary({ children }: { children: React.ReactNode }) {
  let connected = false;
  let key = "";
  try {
    const w = useWallet();
    connected = !!w?.connected;
    key = `${connected ? "1" : "0"}-${w?.publicKey?.toBase58?.() || ""}`;
  } catch {
    connected = false;
    key = "";
  }
  return <Boundary resetKey={key}>{children}</Boundary>;
}

function NavLink({
  href,
  children,
  active,
}: {
  href: string;
  children: React.ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={[
        "text-sm font-medium transition-colors",
        active ? "text-white" : "text-white/45 hover:text-white/80",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

export default function SiteHeader() {
  const { connected } = useWallet();
  const pathname = usePathname() || "/";
  const isHome = pathname === "/";
  const isApp = pathname.startsWith("/app");
  const isHelp = pathname.startsWith("/help");
  const isCommunity = pathname.startsWith("/community");

  return (
    <header className="relative sticky top-0 z-40 backdrop-blur supports-[backdrop-filter]:bg-black/40">
      {/* Subtle brand glow */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-70"
        style={{
          background:
            "radial-gradient(900px 320px at 18% -40px, rgba(236,72,153,0.18), transparent 55%), radial-gradient(900px 320px at 78% -70px, rgba(168,85,247,0.14), transparent 55%)",
        }}
        aria-hidden
      />

      <div className="mx-auto w-full max-w-7xl px-4 md:px-8 md:h-16">
        <div className="flex h-16 items-center justify-between gap-4">
          {/* Brand */}
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="flex items-center gap-3 min-w-0">
<Image
  src="/brand/mojomaxi-wordmark.svg"
  alt="mojomaxi"
  width={180}
  height={36}
  priority
  className="h-8 w-auto flex-none object-contain"
/>
            </Link>
            <span className="rounded-full bg-emerald-900/55 px-3 py-1 text-xs font-semibold tracking-wide text-emerald-300">
              Beta
            </span>
          </div>

          {/* Nav */}
          <nav className="hidden md:flex items-center gap-10">
            <NavLink href="/" active={isHome}>
              Home
            </NavLink>
            <NavLink href="/app" active={isApp}>
              App
            </NavLink>
            <NavLink href="/help" active={isHelp}>
              Help
            </NavLink>
            <NavLink href="/community" active={isCommunity}>
              Community
            </NavLink>
          </nav>

          {/* Right */}
          <div className="flex items-center justify-end gap-2">
            <div className="flex items-center gap-1">
              {connected ? (
                <WalletScopedBoundary>
                  <MojoProBadge />
                </WalletScopedBoundary>
              ) : null}
            </div>
            <WalletScopedBoundary>
              <ConnectWallet />
            </WalletScopedBoundary>
          </div>
        </div>

        {/* Mobile nav (simple, no pills) */}
        <nav className="flex md:hidden items-center justify-center gap-8 pb-3">
          <NavLink href="/" active={isHome}>
            Home
          </NavLink>
          <NavLink href="/app" active={isApp}>
            App
          </NavLink>
          <NavLink href="/help" active={isHelp}>
            Help
          </NavLink>
          <NavLink href="/community" active={isCommunity}>
            Community
          </NavLink>
        </nav>
      </div>
    </header>
  );
}
