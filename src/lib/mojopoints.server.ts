// filepath: src/lib/mojopoints.server.ts
import { createHash } from "crypto";
import { redis } from "@/lib/redis";

export type MojoApplyParams = {
  wallet: string;
  setId: string;
  kind: string;
  inTotalUsd?: number | null;
  outTotalUsd?: number | null;
  tx?: string | null;
  ts?: number | null;
};

export type SeasonMeta = {
  id: string;
  label?: string;
  start: number;
  end?: number | null;
};

type PointsResult = { applied: boolean; delta: number; seasonId?: string | null };

const KEYS = {
  lifetimeWallet: (w: string) => `mm:mojopoints:wallet:${w}`,
  lifetimeLb: () => `mm:mojopoints:leaderboard`,
  seen: (fp: string) => `mm:mojopoints:seen:${fp}`,
  hist: (w: string) => `mm:mojopoints:wallet:${w}:hist`,
  seasonCurrent: () => `mm:mojopoints:season:current`,
  seasonMeta: (id: string) => `mm:mojopoints:season:meta:${id}`,
  seasonsSet: () => `mm:mojopoints:season:ids`,
  seasonsIdx: () => `mm:mojopoints:seasons`,
  seasonWallet: (sid: string, w: string) => `mm:mojopoints:s:${sid}:wallet:${w}`,
  seasonLb: (sid: string) => `mm:mojopoints:s:${sid}:lb`,
} as const;

const MAX_HIST = Number.parseInt(process.env.MM_POINTS_HISTORY_MAX || "", 10) || 200;
const SEEN_TTL_SEC = Number.parseInt(process.env.MM_POINTS_SEEN_TTL_SEC || "", 10) || (60 * 60 * 24 * 90);
const SEASONS_CACHE_MS = 30_000;

function toIntPoints(usd: number | null | undefined): number {
  if (!Number.isFinite(usd as any)) return 0;
  const n = Number(usd);
  if (n <= 0) return 0;
  return Math.round(n);
}
function eventUsdLike(ev: { inTotalUsd?: any; outTotalUsd?: any }): number {
  if (Number.isFinite(ev?.inTotalUsd)) return Number(ev!.inTotalUsd);
  if (Number.isFinite(ev?.outTotalUsd)) return Number(ev!.outTotalUsd);
  return 0;
}
function fingerprint(p: MojoApplyParams): string {
  const secondBucket = Math.floor(Number(p.ts || Date.now()) / 1000);
  const s = `${p.setId}|${p.kind}|${p.tx || ""}|${secondBucket}`;
  return createHash("sha256").update(s).digest("hex");
}

let seasonsCache: { at: number; list: SeasonMeta[] } | null = null;

async function loadAllSeasons(): Promise<SeasonMeta[]> {
  if (seasonsCache && Date.now() - seasonsCache.at < SEASONS_CACHE_MS) return seasonsCache.list;
  let ids: string[] = [];
  try {
    const zr: any = await (redis as any).zrange(KEYS.seasonsIdx(), 0, -1).catch(() => null);
    if (Array.isArray(zr)) ids = zr.map(String);
  } catch {}
  if (!ids.length) {
    try {
      const sm = await (redis as any).smembers(KEYS.seasonsSet()).catch(() => [] as string[]);
      ids = Array.isArray(sm) ? sm.map(String) : [];
    } catch {}
  }
  const metas: SeasonMeta[] = [];
  for (const id of ids) {
    try {
      const raw = await redis.get(KEYS.seasonMeta(String(id))).catch(() => null);
      const meta = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (meta && meta.id && Number.isFinite(Number(meta.start))) metas.push({ ...meta, start: Number(meta.start), end: meta?.end != null ? Number(meta.end) : null });
    } catch {}
  }
  metas.sort((a, b) => a.start - b.start);
  seasonsCache = { at: Date.now(), list: metas };
  return metas;
}

function belongsToSeason(ts: number, s: SeasonMeta): boolean {
  const startOk = ts >= Number(s.start);
  const endOk = s.end == null ? true : ts < Number(s.end);
  return startOk && endOk;
}
async function findSeasonForTs(ts: number): Promise<SeasonMeta | null> {
  const list = await loadAllSeasons();
  for (const s of list) if (belongsToSeason(ts, s)) return s;
  return null;
}

export async function getCurrentSeason(): Promise<SeasonMeta | null> {
  try {
    const id = await redis.get<string | null>(KEYS.seasonCurrent());
    if (!id) return null;
    const raw = await redis.get(KEYS.seasonMeta(String(id)));
    const meta = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (meta && meta.id) return { ...meta, start: Number(meta.start), end: meta?.end != null ? Number(meta.end) : null };
  } catch {}
  return null;
}

export async function getMojoPoints(wallet: string, opts?: { seasonId?: string | "current" | "lifetime" }): Promise<{ points: number; season?: SeasonMeta | null; }> {
  const mode = opts?.seasonId ?? "current";
  if (mode === "lifetime") {
    const v = await redis.get(KEYS.lifetimeWallet(wallet)).catch(() => 0 as any);
    return { points: Number(v || 0), season: null };
  }
  let season: SeasonMeta | null = null;
  if (mode === "current" || !mode) {
    season = await getCurrentSeason();
  } else {
    try {
      const raw = await redis.get(KEYS.seasonMeta(String(mode)));
      const meta = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (meta && meta.id) season = { ...meta, start: Number(meta.start), end: meta?.end != null ? Number(meta.end) : null };
    } catch {}
  }
  if (!season) {
    const v = await redis.get(KEYS.lifetimeWallet(wallet)).catch(() => 0 as any);
    return { points: Number(v || 0), season: null };
  }
  const v = await redis.get(KEYS.seasonWallet(season.id, wallet)).catch(() => 0 as any);
  return { points: Number(v || 0), season };
}

export async function applyMojoPointsFromEvent(params: MojoApplyParams): Promise<PointsResult> {
  const ts = Number(params.ts || Date.now());
  const usd = eventUsdLike(params);
  const delta = toIntPoints(usd);
  if (delta <= 0 || !params.wallet || !params.setId || !params.kind) return { applied: false, delta: 0 };

  const fp = fingerprint({ ...params, ts });
  const ok = await (redis as any).set(KEYS.seen(fp), "1", { nx: true, ex: SEEN_TTL_SEC }).catch(() => null);
  if (ok !== "OK") return { applied: false, delta: 0 };

  const p = (redis as any).pipeline();
  p.incrbyfloat(KEYS.lifetimeWallet(params.wallet), delta);
  p.zincrby(KEYS.lifetimeLb(), delta, params.wallet);

  let seasonId: string | null = null;
  try {
    const season = await findSeasonForTs(ts);
    if (season && season.id) {
      seasonId = season.id;
      p.incrbyfloat(KEYS.seasonWallet(season.id, params.wallet), delta);
      p.zincrby(KEYS.seasonLb(season.id), delta, params.wallet);
    }
  } catch {}

  try {
    const histRow = JSON.stringify({
      ts,
      setId: params.setId,
      kind: params.kind,
      tx: params.tx || null,
      usd,
      points: delta,
      seasonId,
    });
    p.lpush(KEYS.hist(params.wallet), histRow);
    p.ltrim(KEYS.hist(params.wallet), 0, (Number(process.env.MM_POINTS_HISTORY_MAX || 200) - 1));
  } catch {}

  await p.exec().catch(() => null);
  return { applied: true, delta, seasonId };
}

export async function adminSetSeason(meta: SeasonMeta): Promise<{ ok: true }> {
  if (!meta?.id || !Number.isFinite(Number(meta.start))) throw new Error("invalid season meta");
  const payload: SeasonMeta = { id: String(meta.id), label: meta?.label, start: Number(meta.start), end: meta?.end != null ? Number(meta.end) : null };
  const p = (redis as any).pipeline();
  p.set(KEYS.seasonMeta(payload.id), JSON.stringify(payload));
  p.sadd(KEYS.seasonsSet(), payload.id);
  p.zadd(KEYS.seasonsIdx(), { score: payload.start, member: payload.id });
  p.set(KEYS.seasonCurrent(), payload.id);
  await p.exec();
  return { ok: true };
}

export async function adminCloseSeason(id: string, endTs?: number): Promise<{ ok: true }> {
  if (!id) throw new Error("missing id");
  const raw = await redis.get(KEYS.seasonMeta(id));
  const meta = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!meta || !meta.id) throw new Error("season not found");
  (meta as any).end = Number.isFinite(endTs) ? Number(endTs) : Date.now();
  await redis.set(KEYS.seasonMeta(id), JSON.stringify(meta));
  return { ok: true };
}
