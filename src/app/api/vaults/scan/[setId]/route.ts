// filepath: src/app/api/vaults/scan/[setId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID as TOKEN_PROGRAM_CLASSIC } from "@solana/spl-token";
import IDL from "@/idl/mojomaxi_vault.json";
import bs58 from "bs58";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rpcUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
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
function authPda(vault: PublicKey): PublicKey {
  const programId = getProgramId();
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), vault.toBuffer()],
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
    const mintStr  = searchParams.get("mint")  || "";
    if (!adminStr || !mintStr) throw new Error("admin and mint are required");

    const adminPk = new PublicKey(adminStr);
    const mintPk  = new PublicKey(mintStr);
    const conn    = new Connection(rpcUrl(), "confirmed");

    const v = vaultPda(adminPk, to16(params.setId));
    const a = authPda(v);

    // List all token accounts by owner/mint (authority and vault)
    const list = async (owner: PublicKey) => {
      const resp = await conn.getTokenAccountsByOwner(owner, { mint: mintPk }, "confirmed");
      const out: any[] = [];
      for (const it of resp.value) {
        const pk = new PublicKey(it.pubkey);
        let ui = "0", raw = "0";
        try {
          const b = await conn.getTokenAccountBalance(pk, "confirmed");
          ui = b?.value?.uiAmountString || "0"; raw = b?.value?.amount || "0";
        } catch {}
        out.push({ ata: pk.toBase58(), raw, ui });
      }
      return out;
    };

    return NextResponse.json({
      ok: true,
      vault: v.toBase58(),
      vaultAuthority: a.toBase58(),
      authorityAccounts: await list(a),
      vaultAccounts: await list(v),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
