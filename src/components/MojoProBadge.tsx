// filepath: src/components/MojoProBadge.tsx
"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

type Status = { active: boolean; expiresAt: number; creditedUsd?: number; totalPaidUsd?: number };
type StatusResp = { ok: boolean; status?: Status; error?: string | null };

function tryInjectedWallet(): string {
  try {
    const g: any = globalThis as any;
    const providers = [
      g?.solana,
      g?.phantom?.solana,
      g?.backpack?.solana,
      g?.exodus?.solana,
      g?.trustwallet?.solana,
    ].filter(Boolean);
    for (const p of providers) {
      const pk =
        p?.publicKey?.toBase58?.() ||
        p?.publicKey?.toString?.() ||
        p?.wallet?.publicKey?.toBase58?.() ||
        p?.wallet?.publicKey?.toString?.() ||
        p?.adapter?.publicKey?.toBase58?.() ||
        p?.adapter?.publicKey?.toString?.();
      if (pk) return String(pk);
    }
  } catch {}
  return "";
}

export default function MojoProBadge() {
  const { publicKey } = useWallet();

  const keyFromAdapter = publicKey?.toBase58?.() || publicKey?.toString?.() || "";
  const wallet = useMemo(() => keyFromAdapter || tryInjectedWallet(), [keyFromAdapter]);

  const [isActive, setIsActive] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    if (!wallet) { setIsActive(false); return; }
    (async () => {
      try {
        const r = await fetch(`/api/subs/mojo-pro-sol/status?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" });
        const j: StatusResp = await r.json();
        if (!cancelled) setIsActive(!!j?.status?.active);
      } catch {
        if (!cancelled) setIsActive(false);
      }
    })();
    return () => { cancelled = true; };
  }, [wallet]);

  if (!wallet || !isActive) return null;

  // Circle capsule, visually matches the MojoPoints "pill": same border/bg, same overall height.
  return (
    <span
      className="inline-flex h-[22px] w-[22px] md:h-6 md:w-6 items-center justify-center rounded-full border border-white/10 bg-white/5"
      title="pro subscription active"
    >
      <Image
        src="/brand/mojopro-64.png"
        alt="mojo pro"
        width={14}
        height={14}
        className="inline-block h-[14px] w-[14px] md:h-4 md:w-4"
        priority={false}
      />
    </span>
  );
}
