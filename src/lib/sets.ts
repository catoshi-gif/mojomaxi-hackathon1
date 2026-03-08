// filepath: src/lib/sets.ts
import { kv, kSetDoc } from "./kv"; // adjust to your kv helpers if different

export type SetDoc = {
  setId: string;
  wallet: string;
  buyMint: string;
  sellMint: string;
  createdAt: number;
  updatedAt: number;
  buyId?: string;
  sellId?: string;
  [k: string]: any;
};

// Ensure createdAt is present on new docs before saving
export function ensureCreatedAt(doc: any): any {
  const now = Date.now();
  if (!doc || typeof doc !== "object") return doc;
  if (!doc.createdAt || typeof doc.createdAt !== "number" || !isFinite(doc.createdAt)) {
    doc.createdAt = now;
  }
  doc.updatedAt = now;
  return doc;
}

// Example usage when creating a set
export async function saveSetDoc(set: SetDoc) {
  const doc = ensureCreatedAt(set);
  await kv().hset(kSetDoc(set.setId), doc as any);
  return doc;
}
