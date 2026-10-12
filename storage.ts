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
// pathological contention; dropping a count is permanent. Moving denormalisation
// off the response path is a separate follow-up.
const CAS_DEADLINE_MS = 2000;
export async function casRetry(
  what: string,
  attemptOnce: () => Promise<boolean>,
): Promise<void> {
  const started = performance.now();
  for (let attempt = 1;; attempt++) {
    if (await attemptOnce()) return;
    if (performance.now() - started > CAS_DEADLINE_MS) {
      console.warn(`[kv] gave up updating ${what} after ${attempt} attempts`);
      return;
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

export async function logHit(rec: HitRecord): Promise<void> {
  const kv = await getKv();
  // Sequence per trace so we can list hits in receive order. Use a counter via
  // atomic-ish read+write; collisions are fine (we order by ts then seq).
  const tsNanos = BigInt(rec.ts) * 1000000n +
    BigInt(Math.floor(performance.now() * 1000) % 1000000);
  await kv.set(["hit", rec.id, tsNanos.toString().padStart(25, "0")], rec);

  // Update the denormalized stats stored IN the recent index entry so the
  // homepage never has to list every trace's hits. The homepage hit seeds the
  // entry (see handleHomepage); sub-requests bump it here. The recent key is
  // derived from the TRACE's timestamp (not this hit's), so resolve the trace
  // record to get it.
  if (rec.kind !== "homepage") {
    const trace = await kv.get<TraceRecord>(["trace", rec.id]);
    const tv = trace.value;
    if (tv) {
      const recentKey = recentIndexKey(tv.ts, rec.id);
      const uKey = uaIndexKey(tv.ua, tv.ts, rec.id);
      const aKey = uaAggKey(tv.ua);
      // Concurrent sub-requests (css-bg, js-ran, font, …) all update the same
      // stats entry, so use an atomic compare-and-set on the versionstamp. A
      // plain get→set races and loses updates (e.g. the jsRan flag getting
      // clobbered). The same atomic also mirrors the snapshot to the per-UA
      // index and bumps the per-UA aggregate, so all three views stay
      // consistent. Retries are deadline-bounded, not attempt-bounded: a real
      // browser fires ~12 sub-resources at once, every CAS loser burns an
      // attempt, and a fixed 8-attempt count silently dropped updates
      // (measured: 9 of 12 hits recorded).
      await casRetry(`stats for trace ${rec.id}`, async () => {
        const cur = await kv.get<TraceStats>(recentKey);
        if (!cur.value) return true; // entry not seeded (shouldn't happen)
        const s = cur.value;
        const wasJsRan = s.jsRan;
        s.assetCount += 1;
        if (rec.kind === "js-ran") s.jsRan = true;
        if (!s.kinds.includes(rec.kind)) s.kinds.push(rec.kind);
        // Bump the UA aggregate only for the fields that change here: the
        // jsRan counter flips exactly once per trace (false -> true).
        const aggCur = await kv.get<UaAggregate>(aKey);
        const agg = aggCur.value ??
          { ua: tv.ua || "(no user-agent)", count: 0, jsRan: 0 };
        const aggNext: UaAggregate = {
          ua: agg.ua,
          count: agg.count,
          jsRan: agg.jsRan + (!wasJsRan && rec.kind === "js-ran" ? 1 : 0),
        };
        const res = await kv.atomic()
          .check({ key: recentKey, versionstamp: cur.versionstamp })
          .check({ key: aKey, versionstamp: aggCur.versionstamp })
          .set(recentKey, s)
          .set(uKey, s)
          .set(aKey, aggNext)
          .commit();
        return res.ok;
      });
    }
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
