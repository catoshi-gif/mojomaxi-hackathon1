// filepath: src/app/api/vaults/scan-mint/[setId]/route.ts
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
  try { const b = bs58.decode(cleaned); return Buffer.from(b.subarray(0, 16)); } catch {}
  const enc = new TextEncoder().encode(cleaned);
  const out = Buffer.alloc(16, 0);
  out.set(enc.subarray(0, 16), 0);
  return out;
}

async function getTokenAccountsByOwnerAndMint(conn: Connection, owner: PublicKey, mint: PublicKey) {
  // Use dual memcmp filters: mint at offset 0, owner at offset 32; dataSize = 165
  const filters: any[] = [
    { dataSize: 165 },
    { memcmp: { offset: 0,  bytes: mint.toBase58()   } },
    { memcmp: { offset: 32, bytes: owner.toBase58() } },
  ];
  const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_CLASSIC, { filters, commitment: "confirmed" });
  return accounts;
}

export async function GET(req: NextRequest, { params }: any) {
  try {
    const { searchParams } = new URL(req.url);
    const adminStr = searchParams.get("admin") || "";
    const mintStr  = searchParams.get("mint")  || "";
    if (!adminStr || !mintStr) {
      return NextResponse.json({ ok: false, error: "admin and mint are required" }, { status: 400 });
    }
    const adminPk = new PublicKey(adminStr);
    const mintPk  = new PublicKey(mintStr);
    const conn    = new Connection(rpcUrl(), "confirmed");

    const v = vaultPda(adminPk, to16(params.setId));
    const a = authPda(v);

    // Query ONLY accounts owned by authority, for this mint
    const [authAccs, vaultAccs] = await Promise.all([
      getTokenAccountsByOwnerAndMint(conn, a, mintPk),
      getTokenAccountsByOwnerAndMint(conn, v, mintPk),
    ]);

    async function describe(pubkey: PublicKey) {
      const info = await conn.getParsedAccountInfo(pubkey, "confirmed");
      const parsed = (info.value as any)?.data?.parsed?.info;
      const owner  = parsed?.owner as string | undefined;
      const amountRaw = parsed?.tokenAmount?.amount as string | undefined;
      const amountUi  = parsed?.tokenAmount?.uiAmountString as string | undefined;
      return { pubkey: pubkey.toBase58(), owner, amountRaw: amountRaw ?? "0", amountUi: amountUi ?? "0" };
    }

    const authList = await Promise.all(authAccs.map(ae => describe(ae.pubkey)));
    const vaultList = await Promise.all(vaultAccs.map(ve => describe(ve.pubkey)));

    const sortDesc = (arr: any[]) => arr.sort((x, y) => BigInt(y.amountRaw) > BigInt(x.amountRaw) ? 1 : BigInt(y.amountRaw) < BigInt(x.amountRaw) ? -1 : 0);

    return NextResponse.json({
      ok: true,
      mint: mintPk.toBase58(),
      vault: v.toBase58(),
      vaultAuthority: a.toBase58(),
      authorityAccounts: sortDesc(authList),
      vaultAccounts: sortDesc(vaultList),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "scan-mint filtered error" }, { status: 500 });
  }
}
