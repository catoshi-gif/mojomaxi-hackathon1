// filepath: src/app/webhooks/_components/ActivityDebugPanel.tsx
"use client";

/**
 * Developer-only Activity Debug Inspector
 * Path: src/app/webhooks/_components/ActivityDebugPanel.tsx
 * Imported by ActivityPanel with: import ActivityDebugPanel from "./ActivityDebugPanel";
 */

import React from "react";
import { Card, CardContent } from "@/components/ui/card";

type EventRow = {
  id?: string;
  setId?: string;
  ts?: number;
  kind?: string;
  direction?: "BUY" | "SELL";
  ok?: boolean | null;
  txUrl?: string | null;
  source?: string | null;

  inSymbol?: string | null;
  outSymbol?: string | null;
  inputMint?: string | null;
  outputMint?: string | null;

  amountInUi?: number | null;
  amountOutUi?: number | null;

  inUsdPrice?: number | null;
  outUsdPrice?: number | null;
  inTotalUsd?: number | null;
  outTotalUsd?: number | null;

  unitPriceUsd?: number | null;
  usdIn?: number | null;
  usdOut?: number | null;

  __debug?: {
    symbolInSource?: "event" | "setMeta" | "common" | "unknown";
    symbolOutSource?: "event" | "setMeta" | "common" | "unknown";
    usdInSource?: "frozen" | "live" | "none";
    usdOutSource?: "frozen" | "live" | "none";
    priceInSource?: "frozen" | "live" | "derived" | "none";
    priceOutSource?: "frozen" | "live" | "derived" | "none";
  };
};

function fmtUsd(n?: number | null) {
  if (n == null || !isFinite(Number(n))) return "$0.00";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(n));
}
function fmtNum(n?: number | null, max = 6) {
  if (n == null || !isFinite(Number(n))) return "0";
  const v = Number(n);
  const dp = v < 1 ? Math.min(6, max) : 2;
  return v.toLocaleString(undefined, { maximumFractionDigits: dp });
}
function fmtTime(ts?: number) {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

export default function ActivityDebugPanel({
  events,
  priceMap,
}: {
  events: EventRow[];
  priceMap: Record<string, number>;
}) {
  if (!events?.length) return null;
  return (
    <Card className="rounded-xl border border-yellow-500/30 bg-yellow-500/5">
      <CardContent className="p-3 sm:p-4">
        <div className="mb-2 text-[13px] font-semibold text-yellow-300">Activity Debug Inspector</div>
        <div className="space-y-2">
          {events.map((e, i) => {
            const inLive = e.inputMint ? priceMap[e.inputMint] : undefined;
            const outLive = e.outputMint ? priceMap[e.outputMint] : undefined;
            return (
              <details key={(e.id || i) + String(e.ts || "")} className="rounded-md bg-black/30 p-2 text-[11px] text-white/80 ring-1 ring-white/10">
                <summary className="cursor-pointer select-none outline-none">
                  <span className="font-mono opacity-70">{(e.kind || "").toUpperCase()}</span>
                  {" • "}
                  <span className="opacity-80">{e.direction || "—"}</span>
                  {" • set "}
                  <span className="font-mono">{e.setId?.slice(0, 8)}</span>
                  {" • "}
                  <span className="opacity-70">{fmtTime(e.ts)}</span>
                </summary>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded bg-white/5 p-2">
                    <div className="font-semibold mb-1">Input</div>
                    <div>mint: <span className="font-mono">{e.inputMint || "—"}</span></div>
                    <div>symbol: <b>{e.inSymbol || "—"}</b> <span className="text-white/50">({e.__debug?.symbolInSource || "?"})</span></div>
                    <div>amountUi: <b>{fmtNum(e.amountInUi)}</b></div>
                    <div>frozen price: <b>{e.inUsdPrice != null ? fmtUsd(e.inUsdPrice) : "—"}</b></div>
                    <div>live price: <b>{Number.isFinite(inLive as number) ? fmtUsd(inLive as number) : "—"}</b></div>
                    <div>frozen total USD: <b>{e.inTotalUsd != null ? fmtUsd(e.inTotalUsd) : "—"}</b></div>
                    <div>computed total USD: <b>{(Number.isFinite(inLive as number) && Number.isFinite(e.amountInUi as number)) ? fmtUsd((inLive as number) * (e.amountInUi as number)) : "—"}</b></div>
                  </div>
                  <div className="rounded bg-white/5 p-2">
                    <div className="font-semibold mb-1">Output</div>
                    <div>mint: <span className="font-mono">{e.outputMint || "—"}</span></div>
                    <div>symbol: <b>{e.outSymbol || "—"}</b> <span className="text-white/50">({e.__debug?.symbolOutSource || "?"})</span></div>
                    <div>amountUi: <b>{fmtNum(e.amountOutUi)}</b></div>
                    <div>frozen price: <b>{e.outUsdPrice != null ? fmtUsd(e.outUsdPrice) : "—"}</b></div>
                    <div>live price: <b>{Number.isFinite(outLive as number) ? fmtUsd(outLive as number) : "—"}</b></div>
                    <div>frozen total USD: <b>{e.outTotalUsd != null ? fmtUsd(e.outTotalUsd) : "—"}</b></div>
                    <div>computed total USD: <b>{(Number.isFinite(outLive as number) && Number.isFinite(e.amountOutUi as number)) ? fmtUsd((outLive as number) * (e.amountOutUi as number)) : "—"}</b></div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-3">
                  <div>unitPriceUsd: <b>{Number.isFinite(e.unitPriceUsd as number) ? fmtUsd(e.unitPriceUsd as number) : "—"}</b></div>
                  <div>usdIn used: <b>{e.inTotalUsd != null ? fmtUsd(e.inTotalUsd) : (e.usdIn != null ? fmtUsd(e.usdIn) : "—")}</b> <span className="text-white/50">({e.__debug?.usdInSource || "?"})</span></div>
                  <div>usdOut used: <b>{e.outTotalUsd != null ? fmtUsd(e.outTotalUsd) : (e.usdOut != null ? fmtUsd(e.usdOut) : "—")}</b> <span className="text-white/50">({e.__debug?.usdOutSource || "?"})</span></div>
                </div>
                <div className="mt-2">
                  <div className="text-white/60">normalized row</div>
                  <pre className="whitespace-pre-wrap rounded bg-black/40 p-2 ring-1 ring-white/10">{JSON.stringify(e, null, 2)}</pre>
                </div>
              </details>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
