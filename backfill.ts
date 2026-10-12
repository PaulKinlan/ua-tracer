// Backfill / REPAIR pass over the denormalised indexes.
//
// The durable source of truth is the pair of records written by the live app:
// ["trace", id] (the trace itself) and ["hit", id, seq] (every probe the trace
// received). Everything else — the ["recent"] index entry, the ["ua"] index and
// the ["ua-agg"] aggregate — is a denormalisation that must be a pure function of
// those records. This pass makes that true again: it RECOMPUTES each snapshot
// from the records instead of trusting what is stored, which is what allows a
// dropped incremental update (a lost CAS, a request that died mid-write) to be
// repaired rather than remaining permanently wrong.
//
// Two schemas exist in the recent index:
//   - current:  ["recent", rTs, id] -> TraceStats snapshot
//   - legacy:   ["recent", rTs, id] -> bare id string (older app version)
// Both are recomputed from the records now; legacy entries are additionally
// upgraded in place so the live app (which only reads TraceStats) can render them.
//
// Safety against live traffic, which is the hard part:
//   A rebuild recomputing from hits can OVERCOUNT a hit that is in flight. The
//   live path writes the raw hit record first (storage.ts logHit), then applies
//   +1 to the snapshot in a CAS. If the rebuild lists hits after that record
//   lands but commits before the live CAS does, the live CAS loses, retries,
//   re-reads a snapshot that already includes its own hit, and adds +1 again.
//   So this pass (a) recomputes from the records on EVERY attempt — never
//   re-committing a remembered value, so a hit that arrives mid-correction is
//   folded in rather than reverted — and (b) after writing, verifies by
//   re-listing and recomputing, pacing that verification by at least
//   CAS_DEADLINE_MS. The pacing is what makes the check meaningful: a writer that
//   lost a race is finished (committed or given up) within CAS_DEADLINE_MS of its
//   first attempt, so a paced verification that finds the snapshot equal to a
//   fresh recompute proves no writer is still straddling it.
//   The loop is bounded and LOUD: a repair pass that cannot converge must never
//   read as a clean pass, so unfinished traces are reported with their attempt
//   counts and the command exits non-zero.
//
// Traces that received a hit more recently than `settleMs` (default 300 s) are
// deferred: deferral is an efficiency choice (the pass does not fight a trace
// that is actively being probed), NOT a correctness mechanism — the verify loop
// is what makes the result trustworthy, and the threshold is well above the
// largest activity span observed on live data.
//
// Run against the production KV:
//   DENO_KV_ACCESS_TOKEN=<org token> \
//   DENO_KV_URL=https://api.deno.com/v2/databases/<db-id>/connect \
//   deno task backfill
//
// The body lives in `runBackfill(kv, options)` (rather than top-level await) so
// tests can drive it against an isolated KV with an injected clock and delay;
// `import.meta.main` keeps importing this file side-effect free.

import {
  CAS_DEADLINE_MS,
  getKv,
  type HitRecord,
  normUa,
  type TraceRecord,
  type TraceStats,
  uaAggKey,
  type UaAggregate,
  uaIndexKey,
} from "./storage.ts";

/** Traces hit more recently than this are deferred to a later pass. */
export const DEFAULT_SETTLE_MS = 300_000;
/** Verification rounds before the pass declares itself unfinished. */
export const DEFAULT_MAX_ROUNDS = 4;
/** Pacing between a write and the verification that must confirm it (see above). */
export const DEFAULT_VERIFY_PACING_MS = CAS_DEADLINE_MS;

export interface BackfillOptions {
  settleMs?: number;
  now?: () => number;
  maxRounds?: number;
  verifyPacingMs?: number;
  /** Injected so tests can pace without sleeping; called only for verification. */
  delay?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface UnsettledTrace {
  id: string;
  attempts: number;
  expected: TraceStats;
  stored: TraceStats | string | null;
}

export interface BackfillResult {
  scanned: number;
  written: number;
  rebuilt: number;
  upgraded: number;
  aggregates: number;
  deferred: number;
  unsettled: number;
}

function isCurrentSnapshot(v: unknown): v is TraceStats {
  return !!v && typeof v === "object" &&
    typeof (v as TraceStats).id === "string" &&
    typeof (v as TraceStats).ts === "number";
}

/** Field-wise equality, so a rebuild that changes nothing is not counted as work. */
function sameStats(a: TraceStats, b: TraceStats): boolean {
  return a.id === b.id && a.ts === b.ts && a.ua === b.ua && a.ip === b.ip &&
    a.assetCount === b.assetCount && a.jsRan === b.jsRan &&
    a.kinds.length === b.kinds.length &&
    a.kinds.every((k, i) => k === b.kinds[i]) &&
    JSON.stringify(a.verified ?? null) === JSON.stringify(b.verified ?? null);
}

/**
 * The definition of a trace's snapshot, in one place. `verified` is copied from
 * the trace record — it is not derivable from hits, and dropping it (as the
 * previous rebuild did) would wipe the bot verdict on every repair.
 */
function buildStats(t: TraceRecord, hits: HitRecord[]): TraceStats {
  const stats: TraceStats = {
    id: t.id,
    ts: t.ts,
    ua: t.ua,
    ip: t.ip,
    assetCount: 0,
    jsRan: false,
    kinds: [],
    verified: t.verified ?? null,
  };
  for (const hit of hits) {
    if (!hit?.kind || hit.kind === "homepage") continue;
    stats.assetCount += 1;
    if (hit.kind === "js-ran") stats.jsRan = true;
    if (!stats.kinds.includes(hit.kind)) stats.kinds.push(hit.kind);
  }
  return stats;
}

async function readHits(kv: Deno.Kv, id: string): Promise<HitRecord[]> {
  const hits: HitRecord[] = [];
  for await (const h of kv.list<HitRecord>({ prefix: ["hit", id] })) {
    if (h.value) hits.push(h.value);
  }
  return hits;
}

/** Rebuild a TraceStats from the source-of-truth records. */
export async function rebuildStats(
  kv: Deno.Kv,
  id: string,
): Promise<TraceStats | null> {
  const trace = await kv.get<TraceRecord>(["trace", id]);
  if (!trace.value) return null;
  return buildStats(trace.value, await readHits(kv, id));
}

type CommitOutcome = "missing" | "unchanged" | "changed" | "contended";

/**
 * Recompute one trace's snapshot and commit it under a versionstamp check,
 * re-listing the hits on every attempt (see the header: never re-commit a
 * remembered value). The recent-index key is passed in rather than derived so a
 * legacy entry is upgraded in place, exactly where it was.
 */
async function commitTrace(
  kv: Deno.Kv,
  id: string,
  recentKey: Deno.KvKey,
  opts: Required<BackfillOptions>,
): Promise<CommitOutcome> {
  const started = opts.now();
  for (;;) {
    const trace = await kv.get<TraceRecord>(["trace", id]);
    if (!trace.value) return "missing";

    const fresh = buildStats(trace.value, await readHits(kv, id));
    const uKey = uaIndexKey(fresh.ua, fresh.ts, fresh.id);
    const recent = await kv.get<TraceStats | string>(recentKey);
    const ua = await kv.get<TraceStats>(uKey);

    const alreadyCorrect = isCurrentSnapshot(recent.value) &&
      sameStats(recent.value, fresh) && !!ua.value && sameStats(ua.value, fresh);
    if (alreadyCorrect) return "unchanged";

    const res = await kv.atomic()
      .check({ key: recentKey, versionstamp: recent.versionstamp })
      .check({ key: uKey, versionstamp: ua.versionstamp })
      .set(recentKey, fresh)
      .set(uKey, fresh)
      .commit();
    if (res.ok) return "changed";

    // Lost the race. Re-list and recompute rather than merging a stale value; if
    // contention outlasts the deadline, hand the trace to the verify loop.
    if (opts.now() - started >= CAS_DEADLINE_MS) return "contended";
    await new Promise((r) => setTimeout(r, 1 + Math.random() * 7));
  }
}

/**
 * Recompute a UA's aggregate as the fold of its per-UA index entries. Writers
 * that touch this key are CAS-disciplined and idempotent (logHit only flips
 * jsRan once; seedTrace bumps count), so a lost race here is a retry, not a
 * double count — which is why aggregates need no verify loop of their own.
 */
async function rebuildAggregate(
  kv: Deno.Kv,
  bucket: string,
): Promise<UaAggregate> {
  const started = performance.now();
  for (;;) {
    let count = 0;
    let jsRan = 0;
    let ua = "";
    for await (const entry of kv.list<TraceStats>({ prefix: ["ua", bucket] })) {
      const s = entry.value;
      if (!s) continue;
      count++;
      if (!ua) ua = s.ua;
      if (s.jsRan) jsRan++;
    }
    const next: UaAggregate = { ua: ua || "(no user-agent)", count, jsRan };
    const cur = await kv.get<UaAggregate>(uaAggKey(bucket));
    if (
      cur.value && cur.value.ua === next.ua && cur.value.count === next.count &&
      cur.value.jsRan === next.jsRan
    ) {
      return next;
    }
    const res = await kv.atomic()
      .check({ key: uaAggKey(bucket), versionstamp: cur.versionstamp })
      .set(uaAggKey(bucket), next)
      .commit();
    if (res.ok) return next;
    if (performance.now() - started >= CAS_DEADLINE_MS) return next;
    await new Promise((r) => setTimeout(r, 1 + Math.random() * 7));
  }
}

/** Non-zero when the pass could not show that every trace settled. */
export function backfillExitCode(result: BackfillResult): number {
  return result.unsettled > 0 ? 1 : 0;
}

export async function runBackfill(
  kv: Deno.Kv,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const opts: Required<BackfillOptions> = {
    settleMs: DEFAULT_SETTLE_MS,
    now: () => Date.now(),
    maxRounds: DEFAULT_MAX_ROUNDS,
    verifyPacingMs: DEFAULT_VERIFY_PACING_MS,
    delay: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    log: (line: string) => console.log(line),
    ...options,
  };

  let scanned = 0;
  let written = 0;
  let rebuilt = 0;
  let upgraded = 0;
  let deferred = 0;
  const targets: { id: string; key: Deno.KvKey }[] = [];
  const buckets = new Set<string>();

  opts.log('backfill: streaming ["recent"] index…');
  for await (const entry of kv.list<TraceStats | string>({ prefix: ["recent"] })) {
    scanned++;
    const value = entry.value;
    // The index KEY is authoritative for which trace this entry belongs to; the
    // snapshot's own id is only a fallback (a corrupt snapshot must not be able
    // to point the pass at a different trace).
    const id = typeof entry.key[2] === "string"
      ? entry.key[2]
      : (isCurrentSnapshot(value) ? value.id : (typeof value === "string" ? value : null));
    if (!id) continue;

    const trace = await kv.get<TraceRecord>(["trace", id]);
    if (!trace.value) continue; // dangling entry: nothing to repair from

    const hits = await readHits(kv, id);
    const lastHitTs = hits.reduce((max, h) => Math.max(max, h.ts), trace.value.ts);
    if (opts.now() - lastHitTs < opts.settleMs) {
      deferred++;
      continue;
    }

    const outcome = await commitTrace(kv, id, entry.key, opts);
    if (outcome === "missing") continue;
    if (outcome === "changed") {
      rebuilt++;
      if (!isCurrentSnapshot(value)) upgraded++;
      written++;
    }
    targets.push({ id, key: entry.key });
    buckets.add(normUa(trace.value.ua));

    if (scanned % 500 === 0) {
      opts.log(
        `  …${scanned} scanned, ${written} written (${rebuilt} rebuilt, ${upgraded} upgraded, ${deferred} deferred)`,
      );
    }
  }

  opts.log(`backfill: reconciling ${buckets.size} per-UA aggregate(s)…`);
  let aggregates = 0;
  for (const bucket of buckets) {
    const before = await kv.get<UaAggregate>(uaAggKey(bucket));
    const after = await rebuildAggregate(kv, bucket);
    if (
      !before.value || before.value.ua !== after.ua ||
      before.value.count !== after.count || before.value.jsRan !== after.jsRan
    ) {
      aggregates++;
    }
  }

  // Verify what we wrote, and correct anything that a concurrent writer moved.
  const attempts = new Map<string, number>();
  let unsettled: UnsettledTrace[] = [];
  for (let round = 0; round < opts.maxRounds; round++) {
    // Load-bearing pacing: >= the longest a writer can still be retrying.
    await opts.delay(opts.verifyPacingMs);
    const pending: UnsettledTrace[] = [];
    for (const { id, key } of targets) {
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      const trace = await kv.get<TraceRecord>(["trace", id]);
      if (!trace.value) continue;
      const fresh = buildStats(trace.value, await readHits(kv, id));
      const stored = (await kv.get<TraceStats | string>(key)).value;
      if (isCurrentSnapshot(stored) && sameStats(stored, fresh)) continue;
      const outcome = await commitTrace(kv, id, key, opts);
      if (outcome === "missing") continue;
      const after = (await kv.get<TraceStats | string>(key)).value;
      // A mismatch means this round could NOT show the trace settled - even
      // though it has just been corrected. A later clean round proves it, and
      // reporting only the uncorrected ones would let a writer that keeps
      // striking after every correction read as a clean pass.
      pending.push({
        id,
        attempts: attempts.get(id) ?? 0,
        expected: fresh,
        stored: after ?? null,
      });
    }
    unsettled = pending;
    if (pending.length === 0) break;
    opts.log(
      `backfill: ${pending.length} trace(s) still mismatched after verify round ${
        round + 1
      }/${opts.maxRounds}`,
    );
  }

  for (const u of unsettled) {
    opts.log(
      `backfill: UNSETTLED ${u.id} after ${u.attempts} attempt(s): stored=${
        JSON.stringify(u.stored)
      } expected=${JSON.stringify(u.expected)}`,
    );
  }

  opts.log(
    `backfill: done. ${scanned} recent-index entries scanned, ${written} snapshots written ` +
      `(${rebuilt} rebuilt, ${upgraded} legacy entries upgraded), ${deferred} deferred (hit too recently), ` +
      `${aggregates} per-UA aggregate(s) rewritten, ${unsettled.length} unsettled.`,
  );

  return {
    scanned,
    written,
    rebuilt,
    upgraded,
    aggregates,
    deferred,
    unsettled: unsettled.length,
  };
}

if (import.meta.main) {
  const result = await runBackfill(await getKv());
  const code = backfillExitCode(result);
  if (code !== 0) {
    console.error(
      `backfill: FAILED - ${result.unsettled} trace(s) could not be shown to settle; see the UNSETTLED lines above.`,
    );
    Deno.exit(code);
  }
}
