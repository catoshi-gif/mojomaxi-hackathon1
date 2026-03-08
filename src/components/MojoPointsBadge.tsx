"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePollingGate } from "@/lib/useActivityGate";

type PointsResp = { ok: boolean; points?: number; error?: string | null };

function tryInjectedWallet(): string {
  try {
    const g: any = globalThis as any;
    const providers = [
      g?.solana,
      g?.phantom?.solana,
      g?.backpack?.solana,
      g?.exodus?.solana,
      g?.solflare?.solana,
    ].filter(Boolean);
    for (const p of providers) {
      const pk = p?.publicKey?.toBase58?.() || p?.publicKey?.toString?.();
      if (pk && typeof pk === "string") return pk;
    }
  } catch {}
  return "";
}

export default function MojoPointsBadge() {
  const { shouldPoll } = usePollingGate({ idleMs: 60_000 });
  const { publicKey } = useWallet();
  const [points, setPoints] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [fallbackWallet, setFallbackWallet] = useState<string>("");

  // Poll for injected provider publicKey in case wallet connects post-hydration
  useEffect(() => {
    let alive = true;
    const update = () => { if (!alive) return; setFallbackWallet(tryInjectedWallet()); };
    update();
    const id = setInterval(update, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const owner = useMemo(() => {
    const pk = publicKey?.toBase58?.();
    return pk || fallbackWallet || "";
  }, [publicKey, fallbackWallet]);

  // If there is no owner, render nothing (hide badge when not connected)
  if (!owner) return null;

  useEffect(() => {
    let abort = false;
    async function fetchPoints() {
      if (!owner) { setPoints(null); return; }
      setLoading(true);
      try {
        const res = await fetch(`/api/mojo/points?owner=${encodeURIComponent(owner)}`, { cache: "no-store" });
        const json = (await res.json()) as PointsResp;
        if (!abort) setPoints(typeof json?.points === "number" ? json.points : 0);
      } catch {
        if (!abort) setPoints(0);
      } finally {
        if (!abort) setLoading(false);
      }
    }
    fetchPoints();
    const id = shouldPoll ? setInterval(fetchPoints, 30_000) : null;
    return () => { abort = true; if (id) clearInterval(id); };
  }, [owner, shouldPoll]);

  const display = useMemo(() => {
    if (loading && points === null) return "…";
    return typeof points === "number" ? points.toLocaleString() : "--";
  }, [loading, points]);

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs"
      title="potion"
      aria-label="mojo points"
    >
      {/* Tiny logo instead of "mojo" text. Place at /public/brand/mojo-vial-64.png */}
      <Image
        src="/brand/mojo-vial-64.png"
        width={14}
        height={14}
        alt="Mojo vial"
        className="mr-1 inline-block h-[14px] w-[14px] md:h-4 md:w-4"
        priority={false}
      />
      <span className="font-semibold bg-clip-text text-transparent bg-gradient-to-r from-fuchsia-300 via-pink-300 to-purple-300 drop-shadow">
        {display}
      </span>
    </span>
  );
}
