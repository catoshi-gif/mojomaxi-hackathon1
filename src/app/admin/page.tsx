// File: src/app/admin/page.tsx
import React from "react";

export const dynamic = "force-dynamic";

type LBRow = { wallet: string; points: number };
type EquityRow = { setId: string; equityUsd: number; wallet?: string; label?: string };
type PnlRow = { setId: string; realizedUsd: number; wallet?: string; label?: string };
type StatusCounts = { running: number; paused: number; stopped: number; unknown: number };
type Health = { ok: boolean; ms?: number; ts?: number };

async function getOverview() {
  const tryFetch = async (url: string) => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
  const rel = await tryFetch("/api/admin/overview");
  if (rel) return rel;
  // Fallback to relative only; absolute not needed in most Next 14 setups
  return null;
}

function fmtUsd(n: number | null | undefined) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function fmtTimeAgo(ts?: number) {
  if (!ts || !Number.isFinite(ts)) return "—";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} mins ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export default async function AdminPage() {
  const data = (await getOverview()) || {};
  const {
    topLifetime = [] as LBRow[],
    topSeason = [] as LBRow[],
    equityTop = [] as EquityRow[],
    pnlTop = [] as PnlRow[],
    statusCounts = { running: 0, paused: 0, stopped: 0, unknown: 0 } as StatusCounts,
    volume24h = { usd: 0, sampleCount: 0 },
    tokens24h = [] as Array<{ symbol: string; mint: string; volumeUsd: number }>,
    health = {
      upstash: { ok: false } as Health,
      rpc: { ok: false } as Health,
      dex: { ok: false } as Health,
    },
  } = data as any;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 text-gray-100">
      <div className="mx-auto max-w-7xl px-4 py-10 space-y-10">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Mojomaxi — Admin Dashboard</h1>
          <p className="text-sm text-gray-400">All metrics are precomputed via cron and read from cached keys to be DB‑friendly.</p>
        </header>

        {/* KPIs */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi title="24h Swap Volume" value={fmtUsd(volume24h?.usd)} sub={`${volume24h?.sampleCount ?? 0} swaps`} />
          <Kpi title="Active Bots" value={String(statusCounts.running ?? 0)} sub={`Paused ${statusCounts.paused ?? 0} • Stopped ${statusCounts.stopped ?? 0}`} />
          <Kpi title="RPC Health" value={health?.rpc?.ok ? "OK" : "Degraded"} dotOk={!!health?.rpc?.ok} sub={fmtTimeAgo(health?.rpc?.ts)} />
          <Kpi title="Upstash Health" value={health?.upstash?.ok ? "OK" : "Degraded"} dotOk={!!health?.upstash?.ok} sub={fmtTimeAgo(health?.upstash?.ts)} />
        </section>

        {/* Leaderboards */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card title="MojoPoints — Lifetime (Top 100)">
            <LBTable rows={topLifetime} />
          </Card>
          <Card title="MojoPoints — Current Season (Top 100)">
            <LBTable rows={topSeason} />
          </Card>
        </section>

        {/* Sets performance */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card title="Top Equity (Sets)">
            <SetsTable rows={equityTop} valueKey="equityUsd" />
          </Card>
          <Card title="Top Realized P&L (Sets)">
            <SetsTable rows={pnlTop} valueKey="realizedUsd" />
          </Card>
        </section>

        {/* Tokens trending */}
        <section>
          <Card title="Top Tokens (24h)">
            <TokensTable rows={tokens24h} />
          </Card>
        </section>

        {/* Notes */}
        <section className="text-xs text-gray-500">
          <p>Data is aggregated by a background cron every few minutes and stored in Redis as compact keys: <code className="font-mono text-gray-300">mm:admin:*</code>.</p>
        </section>
      </div>
    </div>
  );
}

/* ---------- UI Primitives (glass cards to match site aesthetic) ---------- */

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 shadow-xl backdrop-blur">
      <div className="px-4 sm:px-5 py-3 border-b border-white/10">
        <div className="text-sm font-medium text-gray-100">{title}</div>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

function Kpi({ title, value, sub, dotOk }: { title: string; value: string; sub?: string; dotOk?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 shadow-xl backdrop-blur p-4">
      <div className="text-xs text-gray-400">{title}</div>
      <div className="mt-1.5 text-2xl font-semibold">{value}</div>
      <div className="mt-0.5 text-[11px] text-gray-400 flex items-center gap-2">
        {dotOk != null && <span className={dotOk ? "h-2 w-2 rounded-full bg-emerald-400 inline-block" : "h-2 w-2 rounded-full bg-red-400 inline-block"} />}
        {sub || "—"}
      </div>
    </div>
  );
}

function LBTable({ rows }: { rows: LBRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase text-gray-400 border-b border-white/10">
            <th className="py-2 pl-2 text-left w-10">#</th>
            <th className="py-2 text-left">Wallet</th>
            <th className="py-2 pr-2 text-right">Points</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="py-4 text-center text-gray-400">No data yet</td></tr>
          ) : rows.map((r, i) => (
            <tr key={(r.wallet ?? i) + String(i)} className="border-b border-white/5">
              <td className="py-2 pl-2 text-gray-300">{i + 1}</td>
              <td className="py-2 font-mono text-gray-100">{r.wallet}</td>
              <td className="py-2 pr-2 text-right">{Number(r.points ?? 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SetsTable({ rows, valueKey }: { rows: (EquityRow | PnlRow)[]; valueKey: "equityUsd" | "realizedUsd" }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase text-gray-400 border-b border-white/10">
            <th className="py-2 pl-2 text-left w-10">#</th>
            <th className="py-2 text-left">Set</th>
            <th className="py-2 text-left">Owner</th>
            <th className="py-2 pr-2 text-right">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={4} className="py-4 text-center text-gray-400">No data yet</td></tr>
          ) : rows.map((r: any, i) => (
            <tr key={(r.setId ?? i) + String(i)} className="border-b border-white/5">
              <td className="py-2 pl-2 text-gray-300">{i + 1}</td>
              <td className="py-2 font-mono text-gray-100">{r.setId}</td>
              <td className="py-2 font-mono text-gray-300">{r.wallet || ""}</td>
              <td className="py-2 pr-2 text-right">{fmtUsd(r[valueKey])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TokensTable({ rows }: { rows: Array<{ symbol: string; mint: string; volumeUsd: number }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase text-gray-400 border-b border-white/10">
            <th className="py-2 pl-2 text-left">Symbol</th>
            <th className="py-2 text-left">Mint</th>
            <th className="py-2 pr-2 text-right">24h Volume</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="py-4 text-center text-gray-400">No data yet</td></tr>
          ) : rows.map((r, i) => (
            <tr key={(r.mint ?? i) + String(i)} className="border-b border-white/5">
              <td className="py-2 pl-2 text-gray-100">{r.symbol}</td>
              <td className="py-2 font-mono text-gray-300">{r.mint}</td>
              <td className="py-2 pr-2 text-right">{fmtUsd(r.volumeUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
