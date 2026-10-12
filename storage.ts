// Stable KV schema and trace/probe persistence; no HTTP entrypoint imports.
import type { BotVerification } from "./bot-verification.ts";

// Lazily open Deno KV so module evaluation never blocks/fails at build time
// (Deno Deploy provisions KV lazily; top-level await on openKv can break builds).
let _kv: Deno.Kv | null = null;
export async function getKv(): Promise<Deno.Kv> {
  if (!_kv) {
    // On Deno Deploy the KV is bound to the app, so openKv() with no argument
    // connects automatically. For local/CLI access (e.g. the backfill script)
    // the connect URL must be passed EXPLICITLY as the argument — Deno does NOT
    // honour DENO_KV_URL as an env var and silently falls back to local KV if
    // the URL is omitted. Read it here and forward it.
    const url = Deno.env.get("DENO_KV_URL");
    _kv = url ? await Deno.openKv(url) : await Deno.openKv();
  }
  return _kv;
}

export interface TraceRecord {
  id: string;
  ts: number; // ms since epoch (server-receive)
  ua: string;
  ip: string;
  method: string;
  headers: Record<string, string>;
  secret?: string; // per-trace secret gating /r/{id}/{secret}/... probe paths
  verified?: BotVerification | null; // IP-range check vs published bot ranges
}

// Denormalized per-trace stats, updated as hits arrive. Lets the homepage
// render the list + per-UA counts with O(1) reads per trace instead of an
// expensive list() over every trace's hits (which exhausted the KV pool under
// crawler load — POOL_DEPLETED 503s).
export interface TraceStats {
  id: string;
  ts: number;
  ua: string;
  ip: string;
  assetCount: number; // sub-requests, excludes the homepage hit
  jsRan: boolean; // js-ran.gif was hit
  kinds: AssetKind[]; // distinct kinds seen (for quick badges)
  verified?: BotVerification | null; // IP-range check vs published bot ranges
}

export type AssetKind =
  | "homepage"
  | "css"
  | "js"
  | "img"
  | "font"
  | "css-bg"
  | "css-font"
  | "js-ran"
  | "timing"
  | "favicon"
  | "apple-icon"
  | "manifest"
  | "manifest-icon"
  | "preload"
  | "prefetch"
  | "module"
  | "module-ran"
  | "og-image"
  | "twitter-image"
  | "iframe"
  | "iframe-img"
  | "css-import"
  | "csp-report"
  | "report";

export interface HitRecord {
  id: string; // trace id
  kind: AssetKind;
  ts: number; // ms since epoch (server-receive)
  ua: string;
  ip: string;
  method: string;
  headers: Record<string, string>;
  // for "timing" hits only: the client-side resource timing payload
  timing?: ResourceTiming[];
}

export interface ResourceTiming {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  initiatorType?: string;
  transferSize?: number;
}

export function shortId(): string {
  // URL-safe short random id.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// Recent-index key: newest sorts first (MAX - ts). Shared by the homepage
// seeder and logHit's incremental updates so they target the same entry.
//
// This key is the AUTHORITATIVE serialization point for a trace's stats: writers
// compare-and-set it (and the per-UA aggregate key) rather than the per-UA mirror,
// which is a pure function of the same records and is written in the same atomic.
// See commitHit for the reasoning.
//
// EDITOR RULE for anyone adding a key to the stats transaction (ua-tracer-7e7):
// every key the transaction writes other than the per-hit key must be either
//   (a) derived from the same records and written atomically with them - a MIRROR,
//       which needs no check because it cannot disagree with this key, or
//   (b) listed in the checks (as the aggregate key is).
// Adding a contended non-derived key means the check list must grow with it, or the
// CAS stops being a compare-and-set on the true state: it would then commit a
// snapshot that never existed. That is the whole reason the per-UA mirror is written
// here without a check and the aggregate is not. The checks themselves are in
// commitHit's atomic.
export function recentIndexKey(ts: number, id: string): [string, string, string] {
  const reverseKey = (Number.MAX_SAFE_INTEGER - ts).toString().padStart(20, "0");
  return ["recent", reverseKey, id];
}

// Normalised UA used as a key segment. Lowercased so ?ua= searches are
// case-insensitive against the index. Empty UA collapses to a sentinel so it
// still groups into a stable bucket.
export function normUa(ua: string): string {
  const t = (ua || "").trim().toLowerCase();
  return t || "(no user-agent)";
}

// Per-trace UA index: [ua, uaLower, reverseTs, id] -> TraceStats. Lets a
// ?ua= filter list EVERY trace for a user agent across the whole corpus
// (newest first) instead of only the recent 200. Value is kept in sync with
// the recent-index snapshot by logHit's CAS loop.
export function uaIndexKey(
  ua: string,
  ts: number,
  id: string,
): [string, string, string, string] {
  const reverseKey = (Number.MAX_SAFE_INTEGER - ts).toString().padStart(20, "0");
  return ["ua", normUa(ua), reverseKey, id];
}

// Per-UA running aggregate: [ua-agg, uaLower] -> { ua, count, jsRan }.
// count = number of homepage traces by this UA; jsRan = how many ran JS.
// Powers the full-corpus "By user agent" leaderboard (previously only the
// recent 200 were counted, so the counts were wrong).
export function uaAggKey(ua: string): [string, string] {
  return ["ua-agg", normUa(ua)];
}
export interface UaAggregate {
  ua: string; // original-cased UA for display
  count: number;
  jsRan: number;
}

// A deadline rather than a fixed attempt count handles concurrent sub-requests:
// every CAS loser burns an attempt (measured: 9 of 12 hits recorded with a fixed
// retry count). Awaiting this on the probe response path adds at most 2s under
// pathological contention; a count dropped that way is SHORT until it is repaired, not
// permanent: `deno task backfill` re-derives counts from the records (ua-tracer-plx).
// Since ua-tracer-3re the record and its increment are committed by ONE transaction, so
// this deadline is no longer what keeps them in step. Moving denormalisation off the
// response path is a separate follow-up.
// Bound on how long a CAS retry loop may chase a contended key. Exported because the
// backfill repair pass paces its verification by at least this long: a writer that
// lost a race normally finishes (commits or gives up) within this window, which makes
// a paced verification good evidence that no writer is still straddling a rebuilt
// snapshot. Evidence, not proof - a writer descheduled between its read and its commit
// can still land afterwards; see backfill.ts's header for the full argument.
//
// WHAT THIS BOUND IS FOR NOW (ua-tracer-3re): it is NOT the primary protection for the
// increment path - the record and its count are committed by one atomic, so a lost count
// is repairable rather than something this window prevents. What it still covers is
// snapshots written by versions before that atomic existed, and writers that clobber a
// snapshot without a CAS check (ua-tracer-5ub). For those it remains evidence, not proof.
export const CAS_DEADLINE_MS = 2000;
/**
 * Retry an atomic compare-and-set until it commits or the deadline passes.
 * Returns whether it committed: callers that must repair a give-up (commitHit)
 * need that answer, and before ua-tracer-3re nothing downstream could tell.
 */
export async function casRetry(
  what: string,
  attemptOnce: () => Promise<boolean>,
  deadlineMs: number = CAS_DEADLINE_MS,
): Promise<boolean> {
  const started = performance.now();
  for (let attempt = 1;; attempt++) {
    if (await attemptOnce()) return true;
    if (performance.now() - started > deadlineMs) {
      console.warn(`[kv] gave up updating ${what} after ${attempt} attempts`);
      return false;
    }
    // Small jittered backoff so the retries do not re-collide in lockstep.
    await new Promise((r) => setTimeout(r, 1 + Math.random() * 7));
  }
}

// Seed all three indexes before recording the homepage hit. The recent and UA
// values are complete snapshots; the shared UA aggregate needs its own CAS.
export async function seedTrace(rec: TraceRecord, stats: TraceStats): Promise<void> {
  const kv = await getKv();
  await kv.atomic()
    .set(["trace", rec.id], rec)
    .set(recentIndexKey(rec.ts, rec.id), stats)
    .set(uaIndexKey(rec.ua, rec.ts, rec.id), stats)
    .commit();
  const aKey = uaAggKey(rec.ua);
  await casRetry(`ua aggregate ${normUa(rec.ua)}`, async () => {
    const aggCur = await kv.get<UaAggregate>(aKey);
    const agg = aggCur.value ??
      { ua: rec.ua || "(no user-agent)", count: 0, jsRan: 0 };
    const res = await kv.atomic()
      .check({ key: aKey, versionstamp: aggCur.versionstamp })
      .set(aKey, { ua: agg.ua, count: agg.count + 1, jsRan: agg.jsRan })
      .commit();
    return res.ok;
  });
}

/** The KV per-value cap is 65536 bytes (measured); keep a working margin below it. */
export const MAX_RECORD_BYTES = 48 * 1024;

export interface HitCommitOptions {
  /** CAS retry bound. Tests inject a few ms so the give-up path is reachable fast. */
  deadlineMs?: number;
  /** Warning sink, so tests assert the loud degradation instead of scraping stderr. */
  warn?: (line: string) => void;
}

/** How a hit's record and its count were reconciled. */
export type HitCommitOutcome = "committed" | "recorded-alone" | "no-trace";

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Drop the client-supplied display payload: it is what can push a record over the cap. */
function stripPayload(rec: HitRecord): HitRecord {
  const headers = { ...rec.headers };
  delete headers["x-report-body"];
  const { timing: _timing, ...rest } = rec;
  return { ...rest, headers };
}

/**
 * Keep a hit record inside the KV value cap BEFORE writing it. The cap is hard: an
 * over-limit write throws, and on this path that used to mean an unhandled 500 and a
 * probe lost at the RECORD layer - count and waterfall both short, with nothing
 * anywhere saying so. Dropping the payload keeps the probe (its identity, its kind,
 * its position in the waterfall) so the waterfall still shows it and the backfill
 * pass still counts it, and the truncation is marked in the record and warned about
 * rather than being silent.
 */
const MAX_HEADER_VALUE_CHARS = 4096;

/**
 * A client can send very long header values. Those are what the cheap early-out above
 * must not skip past, because KV rejects the resulting value against its own cap.
 */
function hasHugeHeader(rec: HitRecord): boolean {
  for (const value of Object.values(rec.headers)) {
    if (value.length > MAX_HEADER_VALUE_CHARS) return true;
  }
  return false;
}

function boundRecord(rec: HitRecord, warn: (line: string) => void): HitRecord {
  // Cheap first: only hits carrying a client-supplied payload can be large, so the
  // common probe path pays nothing. A long HEADER value is the other way in, and it is
  // the one KV rejects against its own cap without this function ever being asked
  // (ua-tracer-emp's residual), so it has to be routed through the size check too.
  if (
    !rec.timing?.length && !rec.headers["x-report-body"] && !hasHugeHeader(rec)
  ) return rec;
  if (encodedSize(rec) <= MAX_RECORD_BYTES) return rec;

  const marker = `payload dropped: ${
    encodedSize(rec)
  } bytes over the ${MAX_RECORD_BYTES}-byte budget`;
  const stripped = stripPayload(rec);
  let bounded: HitRecord = {
    ...stripped,
    headers: { ...stripped.headers, "x-payload-truncated": marker },
  };
  if (encodedSize(bounded) > MAX_RECORD_BYTES) {
    // Even the metadata is over budget (a client can send very long header values).
    // Identity is all the counters and the waterfall need, so keep exactly that.
    bounded = {
      id: rec.id,
      kind: rec.kind,
      ts: rec.ts,
      ua: rec.ua.slice(0, 200),
      ip: rec.ip,
      method: rec.method,
      headers: { "x-payload-truncated": marker },
    };
  }
  warn(
    `[hit] payload on trace ${rec.id} exceeded the KV value limit; stored without it (counts can be re-derived with: deno task backfill)`,
  );
  return bounded;
}

/**
 * Reconcile a non-homepage hit's RECORD with its INCREMENT (ua-tracer-3re).
 *
 * The record is written by the same transaction that bumps the counters. That is the
 * point of the fold: on the success path a record exists exactly when the counter has
 * counted it, so a rebuild that recomputes from the records can no longer see a record
 * whose increment is still in flight and add it a second time (the qvu overcount).
 *
 * Off the success path the record is never lost: a give-up, an over-limit payload or a
 * missing trace row all fall back to writing the record alone, which leaves the count
 * SHORT of the records - a state the warning names (with the repair command) and
 * `deno task backfill` repairs from the records themselves. So the failure mode is
 * "an increment is missing", never "a record is missing" and never a count that is
 * higher than the record set.
 *
 * `recentKey` is the AUTHORITATIVE serialization point for a trace's stats. The
 * transaction checks it (and the aggregate key) but not the per-UA mirror: the mirror
 * is a pure function of the same records, written alongside them in the same atomic,
 * so checking it could only cost a retry, never prevent corruption. plx's repair pass
 * does check it, and that asymmetry is harmless for the same reason. The general rule
 * for a key added here is stated beside `recentIndexKey`; the check list below must
 * grow with any contended key that rule does not cover.
 */
export async function commitHit(
  kv: Deno.Kv,
  rec: HitRecord,
  hitKey: Deno.KvKey,
  trace: TraceRecord,
  opts: HitCommitOptions = {},
): Promise<HitCommitOutcome> {
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const recentKey = recentIndexKey(trace.ts, rec.id);
  const uKey = uaIndexKey(trace.ua, trace.ts, rec.id);
  const aKey = uaAggKey(trace.ua);

  const bounded = boundRecord(rec, warn);
  // The record KV may reject is no candidate for the fallback (ua-tracer-emp's second
  // half), so the last-resort form is built here. It is small enough that KV cannot
  // refuse it: identity is all the counters and the waterfall need.
  const identityOnly: HitRecord = {
    id: rec.id,
    kind: rec.kind,
    ts: rec.ts,
    ua: rec.ua.slice(0, 200),
    ip: rec.ip,
    method: rec.method,
    headers: {},
  };

  // A trace row can exist while its stats entry does not, and calling that "shouldn't
  // happen" is what turned ua-tracer-swf into silent data loss: the old branch here
  // returned success WITHOUT executing the atomic, so the record was never written
  // while the caller was told it had committed. The state is reachable - rows are
  // written by paths other than seedTrace (legacy traces from before the recent index
  // existed, the verified-probe path), and the row a hit checks in logHit is a
  // different read from the entry checked here, so the two can disagree. There is no
  // counter to increment in that state and a CAS cannot invent one, so the honest
  // outcome is the record-alone path below, said out loud.
  if (!(await kv.get<TraceStats>(recentKey)).value) {
    warn(
      `[hit] trace ${rec.id} has no stats entry to increment (a sub-resource hit ahead of the seed, or a row written by another path); hit recorded without its count; run: deno task backfill`,
    );
    await storeRecordAlone(kv, hitKey, bounded, identityOnly, rec, warn);
    return "recorded-alone";
  }

  const attempt = (record: HitRecord) =>
    casRetry(`stats for trace ${rec.id}`, async () => {
      const cur = await kv.get<TraceStats>(recentKey);
      // Belt and braces: the check above saw an entry, but never report success for a
      // transaction that did not run. Returning false retries, and the deadline turns
      // it into the record-alone path rather than a lost record.
      if (!cur.value) return false;
      const s = cur.value;
      const wasJsRan = s.jsRan;
      s.assetCount += 1;
      if (rec.kind === "js-ran") s.jsRan = true;
      if (!s.kinds.includes(rec.kind)) s.kinds.push(rec.kind);
      // Bump the UA aggregate only for the fields that change here: the jsRan
      // counter flips exactly once per trace (false -> true).
      const aggCur = await kv.get<UaAggregate>(aKey);
      const agg = aggCur.value ??
        { ua: trace.ua || "(no user-agent)", count: 0, jsRan: 0 };
      const aggNext: UaAggregate = {
        ua: agg.ua,
        count: agg.count,
        jsRan: agg.jsRan + (!wasJsRan && rec.kind === "js-ran" ? 1 : 0),
      };
      const res = await kv.atomic()
        .check({ key: recentKey, versionstamp: cur.versionstamp })
        .check({ key: aKey, versionstamp: aggCur.versionstamp })
        .set(hitKey, record) // the fold: the record is written BY this transaction
        .set(recentKey, s)
        .set(uKey, s)
        .set(aKey, aggNext)
        .commit();
      return res.ok;
    }, opts.deadlineMs);

  let committed: boolean;
  let fallback = bounded;
  try {
    committed = await attempt(bounded);
  } catch (err) {
    // A write-time rejection (the 64 KiB cap is the realistic one) must not lose the
    // probe silently: warn, then try once more with only the identity fields.
    warn(
      `[hit] KV rejected the record for trace ${rec.id} (${
        (err as Error).message
      }); retrying with its identity fields only`,
    );
    fallback = identityOnly;
    try {
      committed = await attempt(identityOnly);
    } catch (err2) {
      warn(
        `[hit] KV rejected even the identity-only record for trace ${rec.id} (${
          (err2 as Error).message
        })`,
      );
      committed = false;
    }
  }
  if (committed) return "committed";

  // Give-up. The increment is lost, the record is not: keep the raw evidence so the
  // probe still appears in the waterfall, and say loudly that the count is short.
  warn(`[hit] hit recorded without its count (trace ${rec.id}); run: deno task backfill`);
  await storeRecordAlone(kv, hitKey, fallback, identityOnly, rec, warn);
  return "recorded-alone";
}

/**
 * Store a hit's record without its increment, and never throw. ua-tracer-emp's residual
 * was this step doing `await kv.set(hitKey, bounded)` with a record KV had already
 * rejected, so the rejection escaped as an unhandled 500 and took the probe with it.
 * `preferred` is tried first, then the identity-only form, and if even that is refused
 * the loss is said out loud rather than swallowed - a lost probe must never be silent.
 */
async function storeRecordAlone(
  kv: Deno.Kv,
  hitKey: Deno.KvKey,
  preferred: HitRecord,
  identityOnly: HitRecord,
  rec: HitRecord,
  warn: (line: string) => void,
): Promise<void> {
  try {
    await kv.set(hitKey, preferred);
    return;
  } catch (err) {
    warn(
      `[hit] KV rejected the hit record for trace ${rec.id} (${
        (err as Error).message
      }); retrying with its identity fields only`,
    );
  }
  try {
    await kv.set(hitKey, identityOnly);
  } catch (err) {
    warn(
      `[hit] could not store any record for trace ${rec.id} (${
        (err as Error).message
      }); the probe is lost - check the KV limits before trusting this trace`,
    );
  }
}

/**
 * The key a hit's record is stored under. The timestamp segment orders hits within a
 * trace, but a timestamp is not an IDENTITY: two hits for one trace can sample the same
 * microsecond, and before ua-tracer-6sn the later write simply overwrote the earlier
 * record - a lost probe with no trace of the loss. The random suffix makes the key
 * unique.
 *
 * It is generated ONCE per hit: the caller builds the key before its retry loop, so a
 * retried commit cannot mint a SECOND record for the same hit.
 *
 * READ COMPATIBILITY, which is the reason this was safe to change: every read of a hit is
 * prefix-based (`kv.list({ prefix: ["hit", id] })`) and nothing anywhere parses the shape
 * of a hit key, so records written before this change - without the suffix - stay readable
 * with no migration and no rewrite. A legacy key and a suffixed key are therefore treated
 * identically by the waterfall, by `deno task backfill`, and by every counter that
 * re-derives from the records.
 */
export function hitKeyFor(id: string, tsNanos: bigint): Deno.KvKey {
  return ["hit", id, tsNanos.toString().padStart(25, "0"), shortId()];
}

export async function logHit(rec: HitRecord): Promise<void> {
  const kv = await getKv();
  // Sequence per trace so we can list hits in receive order. Use a counter via
  // atomic-ish read+write; collisions are fine (we order by ts then seq).
  const tsNanos = BigInt(rec.ts) * 1000000n +
    BigInt(Math.floor(performance.now() * 1000) % 1000000);
  const hitKey: Deno.KvKey = hitKeyFor(rec.id, tsNanos);

  // Only a non-homepage hit has a count to keep in step with its record: the
  // homepage entry is seeded by seedTrace (with its own CAS on the aggregate) and
  // `rebuildStats` excludes kind "homepage" from assetCount, so there is no counter
  // that could straddle it. A hit whose trace row is gone has no snapshot to update
  // either. Both of those write the record alone, as they always have.
  if (rec.kind !== "homepage") {
    const trace = await kv.get<TraceRecord>(["trace", rec.id]);
    if (trace.value) {
      await commitHit(kv, rec, hitKey, trace.value);
    } else {
      await kv.set(hitKey, boundRecord(rec, (line) => console.warn(line)));
    }
  } else {
    await kv.set(hitKey, boundRecord(rec, (line) => console.warn(line)));
  }

  console.log(
    `[hit] trace=${rec.id} kind=${rec.kind} ip=${rec.ip} ua="${rec.ua.slice(0, 80)}"`,
  );
}

export async function listHits(id: string): Promise<HitRecord[]> {
  const kv = await getKv();
  const hits: HitRecord[] = [];
  for await (const entry of kv.list<HitRecord>({ prefix: ["hit", id] })) {
    hits.push(entry.value);
  }
  hits.sort((a, b) => a.ts - b.ts);
  return hits;
}

// Returns recent traces as denormalized stats with NO per-trace extra reads.
// The recent index value holds the stats snapshot, which is kept fresh by
// updating the index entry whenever a trace's stats change.
export async function recentTraces(limit = 100): Promise<TraceStats[]> {
  const kv = await getKv();
  const out: TraceStats[] = [];
  // recent index keyed by [recent, reverseTs, id] so newest sorts first.
  for await (
    const entry of kv.list<TraceStats>({ prefix: ["recent"] }, {
      limit,
      reverse: false,
    })
  ) {
    if (entry.value && typeof entry.value === "object") out.push(entry.value);
  }
  return out;
}

// Search the ENTIRE corpus by user-agent substring (case-insensitive),
// newest-first. Uses the per-UA index so:
//   - an exact-UA match (the common path: leaderboard clicks pass the full UA)
//     is a bounded prefix scan over just that UA's traces; and
//   - a genuine substring search streams the whole ["ua"] index once, filtering
//     in memory, so nothing older than the recent window is hidden.
// `collectLimit` caps how many matches we materialise (the corpus could be
// huge); callers slice for display. Returns { traces, truncated }.
export async function searchTracesByUa(
  uaFilter: string,
  collectLimit = 2000,
): Promise<{ traces: TraceStats[]; truncated: boolean }> {
  const kv = await getKv();
  const needle = (uaFilter || "").trim().toLowerCase();
  const out: TraceStats[] = [];
  let truncated = false;
  // Exact-UA fast path: if an aggregate exists for this exact (normalised) UA,
  // scan only that UA's bucket. Covers the "By user agent" click-through, which
  // is the vast majority of filtered views.
  const exactPrefix: [string, string] = ["ua", normUa(uaFilter)];
  // Heuristic: treat as exact only when the needle matches a known UA bucket.
  // We detect that by checking the aggregate — cheap single point read.
  const agg = await kv.get<UaAggregate>(uaAggKey(uaFilter));
  const startPrefix = agg.value ? exactPrefix : ["ua"] as [string];
  const iter = kv.list<TraceStats>({ prefix: startPrefix });
  for await (const entry of iter) {
    if (!entry.value || typeof entry.value !== "object") continue;
    if (needle && !(entry.value.ua || "").toLowerCase().includes(needle)) {
      continue;
    }
    if (out.length >= collectLimit) {
      truncated = true;
      break;
    }
    out.push(entry.value);
  }
  // The ["ua"] index is already newest-first within each UA bucket, but a
  // cross-UA scan mixes buckets, so re-sort globally by time descending.
  out.sort((a, b) => b.ts - a.ts);
  return { traces: out, truncated };
}

// Full-corpus per-UA leaderboard from the aggregate index. Optionally filtered
// by substring (over the UA string). This is what makes "By user agent" counts
// correct — they previously only reflected the recent 200 traces.
export async function uaAggregate(
  uaFilter = "",
): Promise<{
  entries: [string, { count: number; jsRan: number }][];
  total: number;
}> {
  const kv = await getKv();
  const needle = uaFilter.trim().toLowerCase();
  const entries: [string, { count: number; jsRan: number }][] = [];
  let total = 0;
  for await (const entry of kv.list<UaAggregate>({ prefix: ["ua-agg"] })) {
    const v = entry.value;
    if (!v) continue;
    if (needle && !(v.ua || "").toLowerCase().includes(needle)) continue;
    entries.push([v.ua, { count: v.count, jsRan: v.jsRan }]);
    total += v.count;
  }
  entries.sort((a, b) => b[1].count - a[1].count);
  return { entries, total };
}

// Unsolicited "probe" requests: paths a UA fetches WITHOUT us ever linking them
// (robots.txt, sitemap.xml, /.well-known/*, llms.txt, …). Logged separately from
// traces (no trace id) — reveals what an agent checks on its own initiative.
export interface ProbeRecord {
  path: string;
  ts: number;
  ua: string;
  ip: string;
  method: string;
}
function probeIndexKey(ts: number, rid: string): [string, string, string] {
  const reverseKey = (Number.MAX_SAFE_INTEGER - ts).toString().padStart(20, "0");
  return ["probe", reverseKey, rid];
}
export async function logProbe(path: string, req: Request, ip: string): Promise<void> {
  const ua = req.headers.get("user-agent") ?? "";
  const ts = Date.now();
  console.log(`[probe] ${req.method} ${path} ip=${ip} ua="${ua.slice(0, 80)}"`);
  const kv = await getKv();
  await kv.set(
    probeIndexKey(ts, shortId()),
    { path, ts, ua, ip, method: req.method } as ProbeRecord,
    { expireIn: 7 * 24 * 60 * 60 * 1000 },
  );
}
export async function recentProbes(limit = 200): Promise<ProbeRecord[]> {
  const kv = await getKv();
  const out: ProbeRecord[] = [];
  for await (
    const entry of kv.list<ProbeRecord>({ prefix: ["probe"] }, { limit })
  ) {
    if (entry.value) out.push(entry.value);
  }
  return out;
}
