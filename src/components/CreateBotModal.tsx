"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type AnyObj = Record<string, any>;

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated?: (kind: "webhook" | "rebalance" | "mojo-pro", setObj: AnyObj) => void;
  wallet?: string | null;
};

// --- Idempotency helpers ---
const IDEM_PREFIX = "idem";
function makeIdem(prev?: string | null): string {
  if (typeof prev === "string" && prev.length > 0) return prev;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${IDEM_PREFIX}_${t}_${r}`;
}

export default function CreateBotModal({ open, onClose, onCreated, wallet }: Props) {
  const disabled = !wallet || wallet.length === 0;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "webhook" | "rebalance" | "mojo-pro">(null);

  const idemWebhookRef = useRef<string | null>(null);
  const idemRebalanceRef = useRef<string | null>(null);

  const createWebhook = useCallback(async () => {
    if (!wallet) return;
    setBusy("webhook");
    setErr(null);
    try {
      const r = await fetch("/api/webhooks/new", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wallet": wallet,
          "x-idempotency-key": (idemWebhookRef.current = makeIdem(idemWebhookRef.current)),
        },
        body: JSON.stringify({ wallet }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.set) throw new Error(j?.error || "Failed to create webhook set");
      onCreated?.("webhook", j.set);
      onClose();
    } catch (e: any) {
      setErr(e?.message || "Failed to create webhook set");
    } finally {
      setBusy(null);
    }
  }, [wallet, onCreated, onClose]);

  const createRebalance = useCallback(async () => {
    if (!wallet) return;
    setBusy("rebalance");
    setErr(null);
    try {
      const r = await fetch("/api/rebalance/set", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wallet": wallet,
          "x-idempotency-key": (idemRebalanceRef.current = makeIdem(idemRebalanceRef.current)),
        },
        body: JSON.stringify({ wallet }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.set) throw new Error(j?.error || "Failed to create rebalance set");
      onCreated?.("rebalance", j.set);
      onClose();
    } catch (e: any) {
      setErr(e?.message || "Failed to create rebalance set");
    } finally {
      setBusy(null);
    }
  }, [wallet, onCreated, onClose]);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-hidden">
      <div className="absolute inset-0 z-[110] bg-black/70" onClick={onClose} />

      <div className="absolute inset-0 z-[120] flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="w-full max-w-lg rounded-xl border border-white/10 bg-[#0A0A0A]/90 p-4 shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-[#0A0A0A]/80"
          style={{ WebkitTransform: "translateZ(0)" }}
        >
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm text-muted-foreground">Create Bot</div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-md border border-white/10 px-2 py-1 text-sm hover:bg-white/5"
              style={{ touchAction: "manipulation" }}
            >
              ✕
            </button>
          </div>

          <div className="space-y-3">
            {/* CHANGED sm:grid-cols-3 -> sm:grid-cols-2 to remove the empty third slot */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button
                onClick={createWebhook}
                disabled={disabled || busy === "webhook"}
                className="rounded-full border border-fuchsia-400/20 bg-fuchsia-400/10 px-4 py-1.5 text-sm hover:bg-fuchsia-400/15 hover:border-fuchsia-400/30 transition-colors disabled:opacity-60"
              >
                {busy === "webhook" ? "Creating…" : "TradingView Webhooks"}
              </Button>

              <Button
                onClick={createRebalance}
                disabled={disabled || busy === "rebalance"}
                className="rounded-full border border-fuchsia-400/20 bg-fuchsia-400/10 px-4 py-1.5 text-sm hover:bg-fuchsia-400/15 hover:border-fuchsia-400/30 transition-colors disabled:opacity-60"
              >
                {busy === "rebalance" ? "Creating…" : "Rebalancing Basket"}
              </Button>

              {/* Removed: PRO STRATEGIES button */}
            </div>

            {!wallet && (
              <div className="text-xs text-yellow-300/80">Connect your wallet to create a bot.</div>
            )}
            {err && <div className="text-xs text-red-400">{err}</div>}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
