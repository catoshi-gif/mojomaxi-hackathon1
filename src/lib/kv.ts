// filepath: src/lib/kv.ts
import { Redis } from "@upstash/redis";
import { redis as sharedRedis } from "@/lib/redis";

type KV = Redis;

export function kv(): KV {
  return sharedRedis;
}

const NS = "mm:v1";

export function kWalletSets(walletExact: string) {
  return `${NS}:wallet:${walletExact}:sets`;
}

export function kSetDoc(setId: string) { return `${NS}:set:${setId}`; }
export function kSetSecret(setId: string) { return `${NS}:set:${setId}:secret`; }
export function kVaultForSet(setId: string) { return `${NS}:set:${setId}:vault`; }

export async function putJSON<T>(key: string, obj: T): Promise<void> { await kv().set(key, obj); }
export async function getJSON<T>(key: string): Promise<T | null> { const v = await kv().get<T | null>(key); return v ?? null; }
export async function del(key: string): Promise<void> { await kv().del(key); }
