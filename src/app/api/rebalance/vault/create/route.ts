// filepath: src/app/api/rebalance/vault/create/route.ts
// FULL FILE REPLACEMENT — Rebalance vault create with permanent mapping + safe init retry (no UI changes)
// - Immediately persists set→vault mapping as soon as we can derive the canonical vault PDA.
//   This prevents losing the vault mapping on refresh even if the vault isn't initialized yet or RPC hiccups.
// - If vault PDA is NOT initialized on-chain, returns 409 with { ok:false, error:'vault_not_initialized', initTx64, meta }.
//   Client can sign+send init_vault, then retry; mapping remains pinned.
// - On success, continues to call createRebalanceVaultForSet (which freezes mints/cadence and ensures ATAs).

import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import createRebalanceVaultForSet from "@/lib/createRebalanceVaultForSet.server";
import { upsertGlobalTokenLogos } from "@/lib/tokenLogoRegistry.server";
import { requireOwnerSession } from "@/lib/auth/guards";
import { ensureConnection } from "@/lib/vault-sdk";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import crypto from "crypto";

export const runtime = "nodejs";

type Cadence = "1h" | "2h" | "6h" | "12h" | "24h";
const CADENCES: readonly Cadence[] = ["1h", "2h", "6h", "12h", "24h"] as const;

function asCadence(v: unknown): Cadence | undefined {
  const s = String(v || "").trim();
  return CADENCES.includes(s as Cadence) ? (s as Cadence) : undefined;
}

function errMsg(e: unknown): string {
  if (!e) return "error";
  if (e instanceof Error && e.message) return e.message;
  try {
    return String(e);
  } catch {
    return "error";
  }
}

type LogoMap = Record<string, string>;

function sanitizeLogos(raw: unknown): LogoMap {
  const out: LogoMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as any)) {
    const mint = String(k || "").trim();
    const url = String(v || "").trim();
    if (!mint || !/^https?:\/\//i.test(url)) continue;
    out[mint] = url;
  }
  return out;
}

function readProgramId(): PublicKey {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID as string) ||
    (process.env.VAULT_PROGRAM_ID as string) ||
    "2Nz2Ls8NfaLDR92yDg8NVwoU6jzumdTdJFWq2rLr3Nyp";
  return new PublicKey(raw);
}

function readFeeBps(): number {
  const raw =
    (process.env.NEXT_PUBLIC_VAULT_FEE_BPS as string) ||
    (process.env.VAULT_FEE_BPS as string) ||
    (process.env.TREASURY_FEE_BPS as string) ||
    "50";
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : 50;
}

/** 16 bytes for setId. Accepts 32-hex; otherwise MD5 of raw (legacy compatible with /api/vaults/create). */
function setIdToBytes16(setId: string): Uint8Array {
  const raw = String(setId || "").trim().replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return Uint8Array.from(Buffer.from(raw, "hex"));
  return Uint8Array.from(crypto.createHash("md5").update(raw, "utf8").digest());
}

function discInitVault(): Buffer {
  // Anchor discriminator for "global:init_vault"
  return crypto.createHash("sha256").update("global:init_vault").digest().subarray(0, 8);
}

async function isVaultInitializedOnChain(
  vault: PublicKey
): Promise<{ ok: boolean; owner?: string; dataLen?: number }> {
  try {
    const conn = ensureConnection();
    const info = await conn.getAccountInfo(vault, { commitment: "confirmed" });
    if (!info) return { ok: false };
    const owner58 = info.owner?.toBase58?.() || "";
    const dataLen = info.data?.length ?? 0;
    const ok = owner58 === readProgramId().toBase58() && dataLen >= 8;
    return { ok, owner: owner58, dataLen };
  } catch {
    return { ok: false };
  }
}

async function buildInitVaultTx64(params: {
  admin: PublicKey;
  setId: string;
}): Promise<{ tx64: string; vault: PublicKey; authority: PublicKey; feeBps: number }> {
  const conn = ensureConnection();
  const programId = readProgramId();
  const feeBps = readFeeBps();

  const setId16 = setIdToBytes16(params.setId);
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from("vault", "utf8"), params.admin.toBuffer(), Buffer.from(setId16)],
    programId
  )[0];
  const authority = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority", "utf8"), vault.toBuffer()],
    programId
  )[0];

  const ixData = Buffer.concat([
    discInitVault(),
    Buffer.from(setId16),
    Buffer.from([1]), // Option::Some fee_bps
    Buffer.from(Uint16Array.of(feeBps).buffer).subarray(0, 2), // LE u16
  ]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.admin, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const tx = new Transaction();
  tx.add(ix);
  tx.feePayer = params.admin;

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const tx64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  return { tx64, vault, authority, feeBps };
}


// logo registry
const LOGO_KEY = (id: string) => `mm:v1:set:${id}:logos`;

// mapping keys (shared with other bot types)
const KEY_VAULT_ID = (id: string) => `mm:set:${id}:vaultId`;
const KEY_VAULT_LEGACY = (id: string) => `mm:set:${id}:vault`;

// rebalance set docs
const KEY_REBAL_SET = (id: string) => `mm:rebal:set:${id}`;
const KEY_REBAL_LEGACY = (id: string) => `REBAL_SET:${id}`;

async function patchJsonOrStringDoc(key: string, patch: Record<string, any>) {
  // Best-effort: support redis.json and plain string/object storage
  try {
    // Try JSON.GET root
    const raw = await (redis as any).json?.get(key, "$");
    if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object") {
      const updated = { ...(raw[0] as any), ...patch };
      await (redis as any).json?.set(key, "$", updated);
      return;
    }
  } catch {}
  try {
    const raw2 = await (redis as any).get(key);
    if (typeof raw2 === "string" && raw2.trim().startsWith("{")) {
      const obj = JSON.parse(raw2);
      const updated = { ...(obj || {}), ...patch };
      await (redis as any).set(key, JSON.stringify(updated));
      return;
    }
    if (raw2 && typeof raw2 === "object") {
      const updated = { ...(raw2 as any), ...patch };
      await (redis as any).set(key, JSON.stringify(updated));
      return;
    }
  } catch {}
}

async function persistPermanentVaultMapping(params: { setId: string; wallet: string; vault: string }) {
  const { setId, wallet, vault } = params;

  // 1) Global mapping keys used across bot types
  try {
    await redis.set(KEY_VAULT_ID(setId), vault);
  } catch {}
  try {
    await redis.set(KEY_VAULT_LEGACY(setId), vault);
  } catch {}

  // 2) Patch rebalance set docs (so UI bootstrap always sees vaultId)
  const minimal = { id: setId, wallet, vaultId: vault, type: "rebalance", createdAt: Date.now() };
  await patchJsonOrStringDoc(KEY_REBAL_SET(setId), { ...minimal });
  await patchJsonOrStringDoc(KEY_REBAL_LEGACY(setId), { ...minimal });

  // 3) Also patch generic mm:set hash mirror if present (best-effort)
  try {
    await redis.hset(`mm:set:${setId}`, { vaultId: vault, vault, vaultAddress: vault } as any);
  } catch {}
}

export async function POST(req: NextRequest) {
  const guard = await requireOwnerSession(req as any);
  if (guard.ok === false) return guard.res;

  try {
    const wallet = String(req.headers.get("x-wallet") || "").trim();
    const body = await req.json().catch(() => ({} as any));
    const setId = String(body?.setId || body?.id || "").trim();
    const mints = Array.isArray(body?.mints)
      ? body.mints.map((m: any) => String(m || "").trim()).filter(Boolean)
      : undefined;
    const cadence = asCadence(body?.cadence);
    const vaultHint = body?.vault ? String(body.vault).trim() : undefined;
    const logos = sanitizeLogos(body?.logos);

    if (!wallet) return NextResponse.json({ ok: false, error: "missing wallet" }, { status: 400 });
    if (!setId) return NextResponse.json({ ok: false, error: "missing setId" }, { status: 400 });

    let adminPk: PublicKey;
    try {
      adminPk = new PublicKey(wallet);
    } catch {
      return NextResponse.json({ ok: false, error: "invalid wallet" }, { status: 400 });
    }

    const programId = readProgramId();
    const setId16 = setIdToBytes16(setId);
    const derivedVault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault", "utf8"), adminPk.toBuffer(), Buffer.from(setId16)],
      programId
    )[0];

    // If caller provided a vault, only trust it if it is initialized and owned by program.
    // Otherwise, prefer the derived PDA (canonical).
    let chosenVault = derivedVault;
    if (vaultHint) {
      try {
        const hintPk = new PublicKey(vaultHint);
        const chk = await isVaultInitializedOnChain(hintPk);
        if (chk.ok) chosenVault = hintPk;
      } catch {
        // ignore invalid hint
      }
    }

    // ✅ Permanent mapping: once we know the canonical vault PDA, pin it immediately.
    // This prevents "lost mapping on refresh" even if init hasn't happened yet.
    await persistPermanentVaultMapping({ setId, wallet, vault: chosenVault.toBase58() });

    // Ensure the chosen vault is actually initialized before we proceed with freezing docs/ATAs.
    const chk2 = await isVaultInitializedOnChain(chosenVault);
    if (!chk2.ok) {
      const init = await buildInitVaultTx64({ admin: adminPk, setId });
      return NextResponse.json(
        {
          ok: false,
          error: "vault_not_initialized",
          initTx64: init.tx64,
          meta: {
            wallet,
            setId,
            programId: programId.toBase58(),
            vault: init.vault.toBase58(),
            authority: init.authority.toBase58(),
            feeBps: init.feeBps,
          },
        },
        { status: 409 }
      );
    }

    const res = await createRebalanceVaultForSet({
      wallet,
      setId,
      mints,
      cadence,
      vault: chosenVault.toBase58(),
    });
    const status = res.ok ? 200 : 400;

    // Persist sticky logos (best-effort) ONLY after successful persist.
    try {
      if (res.ok && logos && Object.keys(logos).length) {
        const key = LOGO_KEY(setId);
        const cur = await redis.get<Record<string, string> | null>(key);
        const merged = { ...(cur || {}), ...logos };
        await redis.set(key, merged);
        await upsertGlobalTokenLogos(logos);
      }
    } catch {}

    return NextResponse.json(res, { status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: errMsg(e) }, { status: 500 });
  }
}
