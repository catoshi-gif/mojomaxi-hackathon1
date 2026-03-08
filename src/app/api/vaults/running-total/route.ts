// src/app/api/vaults/running-total/route.ts
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    let cursor = 0;
    let totalRunning = 0;

    do {
      // Scan all mm:set:* keys
      const [nextCursor, keys] = await redis.scan(cursor, {
        match: "mm:set:*",
        count: 100,
      });
      cursor = Number(nextCursor);

      if (keys.length > 0) {
        const values = await redis.mget(...keys);
        for (const v of values) {
          if (!v) continue;
          try {
            const sets = JSON.parse(v as string);
            // Each mm:set:{wallet} stores an array of sets
            for (const set of sets) {
              if (set.vault && set.vault.running === true) {
                totalRunning++;
              }
            }
          } catch (err) {
            console.error("Failed to parse set JSON", err);
          }
        }
      }
    } while (cursor !== 0);

    return NextResponse.json({ totalRunningVaults: totalRunning });
  } catch (err) {
    console.error("Error computing running vaults total:", err);
    return NextResponse.json(
      { error: "failed_to_count_running_vaults" },
      { status: 500 }
    );
  }
}
