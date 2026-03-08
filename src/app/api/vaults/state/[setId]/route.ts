// filepath: src/app/api/vaults/state/[setId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC } from "@solana/spl-token";
import IDL from "@/idl/mojomaxi_vault.json";
import bs58 from "bs58";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rpcUrl(): string {
  return (
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    process.env.SOLANA_MAINNET_RPC ||
    "https://api.mainnet-beta.solana.com"
  );
}
function getProgramId(): PublicKey {
  const pid =
    process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID ||
    (IDL as any)?.metadata?.address ||
    (IDL as any)?.address ||
    "";
  if (!pid) throw new Error("Vault program id not configured");
  return new PublicKey(pid);
}
function vaultPda(owner: PublicKey, setId16: Buffer): PublicKey {
  const programId = getProgramId();
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), setId16],
    programId
  );
  return pda;
}
function to16(id: string): Buffer {
  const cleaned = (id || "").trim();
  const hex32 = cleaned.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex32)) {
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex32.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  try { return Buffer.from(bs58.decode(cleaned).subarray(0, 16)); } catch {}
  const enc = new TextEncoder().encode(cleaned);
  const out = Buffer.alloc(16, 0);
  out.set(enc.subarray(0, 16), 0);
  return out;
}

export async function GET(req: NextRequest, { params }: any) {
  try {
    const { searchParams } = new URL(req.url);
    const adminStr = searchParams.get("admin") || "";
    if (!adminStr) throw new Error("admin is required");
    const adminPk = new PublicKey(adminStr);

    const conn = new Connection(rpcUrl(), "confirmed");
    const v = vaultPda(adminPk, to16(params.setId));

    const acc = await conn.getAccountInfo(v, "confirmed");
    if (!acc) return NextResponse.json({ ok: false, error: "vault account not found" }, { status: 404 });

    const dataB64 = Buffer.from(acc.data as Buffer).toString("base64");

    // Scan for embedded 32-byte pubkeys; describe token accounts
    const data = Buffer.from(acc.data as Buffer);
    const seen = new Set<string>();
    const pubkeys: string[] = [];
    for (let i = 0; i + 32 <= data.length; i += 1) {
      const slice = data.subarray(i, i + 32);
      try {
        const pk = new PublicKey(slice).toBase58();
        if (!seen.has(pk)) { seen.add(pk); pubkeys.push(pk); }
      } catch {}
    }

    const candidates: any[] = [];
    for (const b58 of pubkeys) {
      try {
        const pk = new PublicKey(b58);
        const info = await conn.getParsedAccountInfo(pk, "confirmed");
        const owner = (info.value as any)?.owner?.toBase58?.() || (info.value as any)?.owner;
        let tokenMeta: any = null;
        if (owner === TOKEN_PROGRAM_CLASSIC.toBase58()) {
          const parsed = (info.value as any)?.data?.parsed?.info || null;
          if (parsed) {
            tokenMeta = {
              mint: parsed.mint,
              owner: parsed.owner,
              amountRaw: parsed.tokenAmount?.amount,
              amountUi: parsed.tokenAmount?.uiAmountString
            };
          }
        }
        candidates.push({ pubkey: b58, owner, token: tokenMeta });
      } catch {}
    }

    return NextResponse.json({
      ok: true,
      vault: v.toBase58(),
      vaultAccount: { dataBase64: dataB64, dataLen: (acc.data as Buffer).length },
      embeddedPubkeys: candidates
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "state error" }, { status: 500 });
  }
}
