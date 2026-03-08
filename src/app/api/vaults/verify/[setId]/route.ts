// filepath: src/app/api/vaults/verify/[setId]/route.ts
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

function rpc(): string {
  const u = (process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "").trim();
  return u || "https://api.mainnet-beta.solana.com";
}
function programId(): PublicKey {
  const pid = (process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID || "").trim();
  if (!pid) throw new Error("program id missing");
  return new PublicKey(pid);
}
function to16(id: string): Buffer {
  let cleaned = (id || "").trim();
  if (cleaned.toLowerCase().startsWith("set_")) cleaned = cleaned.slice(4);
  const hex32 = cleaned.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex32)) {
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex32.slice(i*2, i*2 + 2), 16);
    return out;
  }
  try { const b = bs58.decode(cleaned); return Buffer.from(b.subarray(0,16)); } catch {}
  const enc = new TextEncoder().encode(cleaned);
  const out = Buffer.alloc(16,0); out.set(enc.subarray(0,16),0); return out;
}
function vaultPda(admin: PublicKey, set16: Buffer): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), admin.toBuffer(), set16], programId());
  return pda;
}

export async function GET(req: NextRequest, { params }: any) {
  try {
    const url = new URL(req.url);
    const adminStr = String(url.searchParams.get("admin") || "");
    if (!adminStr) return NextResponse.json({ ok:false, error:"admin required" }, { status:400 });
    const conn = new Connection(rpc(), "confirmed");
    const admin = new PublicKey(adminStr);
    const set16 = to16(params.setId);
    const vault = vaultPda(admin, set16);

    const acc = await conn.getAccountInfo(vault).catch(() => null);
    if (!acc) return NextResponse.json({ ok:true, exists:false, vault: vault.toBase58(), setId16: Buffer.from(set16).toString("hex") });

    const ownerOk = acc.owner.equals(programId());
    const discOk = acc.data && acc.data.length >= 8 && Buffer.from(acc.data.subarray(0,8)).equals(Buffer.from([211,8,232,43,2,152,117,119]));
    // set_id bytes offset: 8(discriminator) + 32(admin) = 40 .. 56
    let foundHex: string | null = null;
    if (acc.data && acc.data.length >= 56) {
      const bytes = acc.data.subarray(40, 56);
      foundHex = Buffer.from(bytes).toString("hex");
    }
    const setMatches = foundHex === Buffer.from(set16).toString("hex");

    return NextResponse.json({
      ok:true,
      exists: Boolean(acc && ownerOk && discOk),
      vault: vault.toBase58(),
      setId16: Buffer.from(set16).toString("hex"),
      foundSetId16Hex: foundHex,
      matchesSetId: ownerOk && discOk && setMatches,
      ownerOk,
      discOk
    });
  } catch (e: any) {
    return NextResponse.json({ ok:false, error: e?.message || "verify_error" }, { status:500 });
  }
}
