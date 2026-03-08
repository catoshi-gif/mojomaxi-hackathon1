// filepath: src/app/api/webhooks/for/[wallet]/route.ts
// Hardened: returns full webhook URLs only when the caller proves wallet ownership via the ephemeral
// mm_wallet_session cookie; otherwise returns the same shape with buyId/sellId/urls sanitized.
// UI/UX unchanged.

import "server-only";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSetsByWallet } from "@/lib/store";
import { getSessionWalletFromRequest } from "@/lib/auth/session.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Any = Record<string, any>;

function canonWallet(s: string) {
  return (s || "").trim();
}
function canonSetId(s: string) {
  return (s || "").trim();
}

function baseUrl(req: NextRequest): string {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "";
  if (envUrl) return envUrl.replace(/\/+$/, "");
  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function buildPrefs(s: Any): Any {
  // Prefer top-level mints first (string-safe in Redis hash)
  const aTop = String(s?.mintA || s?.tokenA || s?.mintIn || "").trim() || undefined;
  const bTop = String(s?.mintB || s?.tokenB || s?.mintOut || "").trim() || undefined;

  let p: Any = {};
  // Support prefs object OR JSON strings (prefsJson / prefs)
  try {
    if (s && typeof s.prefs === "object" && s.prefs) {
      p = s.prefs;
    } else if (typeof (s as any)?.prefsJson === "string") {
      const raw = String((s as any).prefsJson || "").trim();
      if (raw) p = JSON.parse(raw);
    } else if (typeof s?.prefs === "string") {
      const raw = String(s.prefs || "").trim();
      if (raw && (raw.startsWith("{") || raw.startsWith("["))) p = JSON.parse(raw);
    }
  } catch {
    p = {};
  }

  const aPref = String(p?.mintA || p?.tokenA || p?.mintIn || p?.tokenIn || "").trim() || undefined;
  const bPref = String(p?.mintB || p?.tokenB || p?.mintOut || p?.tokenOut || "").trim() || undefined;

  const out: Any = {};
  const a = aTop || aPref;
  const b = bTop || bPref;
  if (a) out.mintIn = a;
  if (b) out.mintOut = b;
  return out;
}

function sanitizeSet(base: string, row: Any): Any {
  const setId = canonSetId(String(row?.setId || row?.id || ""));
  const createdAt = Number(row?.createdAt ?? 0) || 0;
  return {
    setId,
    wallet: String(row?.wallet || ""),
    label: typeof row?.label === "string" ? row.label : undefined,
    prefs: buildPrefs(row),
    buyId: undefined,
    sellId: undefined,
    urls: { buy: undefined, sell: undefined },
    createdAt,
    createdOn: createdAt ? new Date(createdAt).toISOString().slice(0, 10) : undefined,
  };
}

function materializeSet(base: string, row: Any): Any {
  const setId = canonSetId(String(row?.setId || row?.id || ""));
  const buyId = String(row?.buyId || "");
  const sellId = String(row?.sellId || "");
  const createdAt = Number(row?.createdAt ?? 0) || 0;
  return {
    setId,
    wallet: String(row?.wallet || ""),
    label: typeof row?.label === "string" ? row.label : undefined,
    prefs: buildPrefs(row),
    buyId: buyId || undefined,
    sellId: sellId || undefined,
    urls: {
      buy: buyId ? `${base}/api/webhooks/ingest/${buyId}` : undefined,
      sell: sellId ? `${base}/api/webhooks/ingest/${sellId}` : undefined,
    },
    createdAt,
    createdOn: createdAt ? new Date(createdAt).toISOString().slice(0, 10) : undefined,
  };
}

async function fetchVaultIdMap(base: string, setIds: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!base || setIds.length === 0) return out;

  // Fetch in parallel; each endpoint is already hardened and returns { vault | vaultId }.
  // This keeps behavior identical to the client-side vault hydration, but moves it server-side
  // so webhook panels can mount immediately.
  const tasks = setIds.map((id) =>
    fetch(`${base}/api/sets/${encodeURIComponent(id)}/vaultid`, { cache: "no-store" as RequestCache })
      .then((r) => r.json())
      .then((j) => [id, (j?.vault || j?.vaultId || null) as string | null] as const)
      .catch(() => [id, null] as const),
  );

  const pairs = await Promise.all(tasks);
  for (const [id, vault] of pairs) out[id] = vault;
  return out;
}

export async function GET(req: NextRequest, ctx: any) {
  try {
    const wallet = canonWallet(String(ctx?.params?.wallet || ""));
    if (!wallet) return NextResponse.json({ ok: true, wallet: "", sets: [] });

    const all = (await getSetsByWallet(wallet).catch(() => [] as Any[])) || [];
    const onlyWebhooks = all.filter((doc: Any) => {
      const kind = String(doc?.kind || doc?.type || "").toLowerCase();
      return kind !== "rebalance";
    });

    const sessionWallet = await getSessionWalletFromRequest(req as any);
    const isOwner = !!sessionWallet && sessionWallet === wallet;

    const base = baseUrl(req);
    const setIds = onlyWebhooks.map((d: Any) => canonSetId(String(d?.setId || d?.id || ""))).filter(Boolean);
    const vaultIdMap = await fetchVaultIdMap(base, setIds);

    const sets = onlyWebhooks.map((doc: Any) => {
      const setId = canonSetId(String(doc?.setId || doc?.id || ""));
      const baseSet = isOwner ? materializeSet(base, doc) : sanitizeSet(base, doc);

      // vaultId is not sensitive; include for both owners and non-owners so UI can mount panels immediately
      // without an extra per-set roundtrip.
      return { ...baseSet, vaultId: vaultIdMap[setId] ?? null };
    });

    return NextResponse.json({ ok: true, wallet, sets }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "internal_error" }, { status: 500 });
  }
}
