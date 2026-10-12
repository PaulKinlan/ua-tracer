// One-off backfill: populate the per-UA index (["ua", ...]) and per-UA
// aggregate (["ua-agg", ...]) for every trace that already existed in KV before
// the search feature shipped. Idempotent — safe to run repeatedly.
//
// Handles BOTH recent-index schemas:
//   - current:  ["recent", rTs, id] -> TraceStats snapshot
//   - legacy:   ["recent", rTs, id] -> bare id string (older app version)
// Legacy entries are rebuilt from ["trace", id] + ["hit", id, ...] into a full
// TraceStats, and the recent-index entry itself is upgraded in place so the
// live app (which only reads TraceStats) can render them too.
//
// Run against the production KV:
//   DENO_KV_ACCESS_TOKEN=<org token> \
//   DENO_KV_URL=https://api.deno.com/v2/databases/<db-id>/connect \
//   deno task backfill
//
// The body lives in `runBackfill(kv)` (rather than top-level await) so tests can
// drive it against an isolated KV; `import.meta.main` keeps importing this file
// side-effect free.

import {
  getKv,
  type HitRecord,
  normUa,
  type TraceRecord,
  type TraceStats,
  uaAggKey,
  type UaAggregate,
  uaIndexKey,
} from "./storage.ts";

// Rebuild a TraceStats from the source-of-truth records, used for legacy
// recent-index entries that only hold a bare trace id. Mirrors the seeding in
// handleHomepage + the denormalisation in logHit.
export async function rebuildStats(
  kv: Deno.Kv,
  id: string,
): Promise<TraceStats | null> {
  const trace = await kv.get<TraceRecord>(["trace", id]);
  if (!trace.value) return null;
  const t = trace.value;
  const stats: TraceStats = {
    id,
    ts: t.ts,
    ua: t.ua,
    ip: t.ip,
    assetCount: 0,
    jsRan: false,
    kinds: [],
  };
  for await (const h of kv.list<HitRecord>({ prefix: ["hit", id] })) {
    const hit = h.value;
    if (!hit?.kind || hit.kind === "homepage") continue;
    stats.assetCount += 1;
    if (hit.kind === "js-ran") stats.jsRan = true;
    if (!stats.kinds.includes(hit.kind)) stats.kinds.push(hit.kind);
  }
  return stats;
}

export interface BackfillResult {
  scanned: number;
  written: number;
  rebuilt: number;
  upgraded: number;
  aggregates: number;
}

export async function runBackfill(kv: Deno.Kv): Promise<BackfillResult> {
  let scanned = 0;
  let written = 0;
  let rebuilt = 0;
  let upgraded = 0;
  const aggregates = new Map<string, UaAggregate>();

  console.log('backfill: streaming ["recent"] index…');
  for await (const entry of kv.list<TraceStats>({ prefix: ["recent"] })) {
    scanned++;
    const key = entry.key;
    let s: TraceStats | null = null;

    if (
      entry.value && typeof entry.value === "object" &&
      (entry.value as TraceStats).id &&
      typeof (entry.value as TraceStats).ts === "number"
    ) {
      // Current schema: value is already a TraceStats snapshot.
      s = entry.value as TraceStats;
    } else if (typeof entry.value === "string") {
      // Legacy schema: value is a bare trace id. Rebuild from source records and
      // upgrade the recent-index entry in place so the live app can render it.
      const id = entry.value;
      s = await rebuildStats(kv, id);
      if (s) {
        await kv.set(key, s);
        rebuilt++;
        upgraded++;
      }
    }

    if (!s) continue;

    // Per-UA timeline entry. Idempotent overwrite of the authoritative snapshot.
    await kv.set(uaIndexKey(s.ua, s.ts, s.id), s);
    written++;

    // Tally the aggregate.
    const bucket = normUa(s.ua);
    const agg = aggregates.get(bucket) ??
      { ua: s.ua || "(no user-agent)", count: 0, jsRan: 0 };
    agg.count += 1;
    if (s.jsRan) agg.jsRan += 1;
    aggregates.set(bucket, agg);

    if (scanned % 500 === 0) {
      console.log(
        `  …${scanned} scanned, ${written} UA-index entries (${rebuilt} rebuilt, ${upgraded} upgraded)`,
      );
    }
  }

  console.log(
    `backfill: writing ${aggregates.size} per-UA aggregates…`,
  );
  for (const [bucket, agg] of aggregates) {
    // CAS-free overwrite: backfill owns these keys during the run. Any concurrent
    // live traffic would be adding brand-new UAs (new buckets), not editing the
    // historical ones, so a blind set is safe here.
    await kv.set(uaAggKey(bucket), agg);
  }

  console.log(
    `backfill: done. ${scanned} recent-index entries scanned, ${written} per-UA ` +
      `timeline entries written (${rebuilt} rebuilt from legacy, ${upgraded} recent-index entries upgraded), ${aggregates.size} per-UA aggregates written.`,
  );

  return {
    scanned,
    written,
    rebuilt,
    upgraded,
    aggregates: aggregates.size,
  };
}

if (import.meta.main) {
  await runBackfill(await getKv());
}
