// ua-tracer — determine what a user agent (especially crawlers) actually
// downloads, follows, and executes when it fetches a web page.
//
// Mechanism: every GET / mints a unique trace id and renders an HTML page whose
// assets ALL carry that id in their path (/r/{id}/...). Every later asset
// request can therefore be tied back to the exact homepage hit and its UA.
// Layered probes are referenced FROM assets (not the HTML) to detect whether a
// UA parses CSS, follows CSS-linked resources, and executes JavaScript.
//
// Storage: Deno KV (Deno Deploy isolates restart frequently — never in-memory).

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceRecord {
  id: string;
  ts: number; // ms since epoch (server-receive)
  ua: string;
  ip: string;
  method: string;
  headers: Record<string, string>;
  secret?: string; // per-trace secret gating /r/{id}/{secret}/... probe paths
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
}

type AssetKind =
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

interface ResourceTiming {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  initiatorType?: string;
  transferSize?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortId(): string {
  // URL-safe short random id.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// Build the probe-asset base path. New traces carry a per-request secret so
// only the agent that received the one-time HTML can hit /r/{id}/{secret}/...;
// old traces (no secret) keep the legacy /r/{id}/... form.
function assetBase(id: string, secret?: string): string {
  return secret ? `/r/${id}/${secret}` : `/r/${id}`;
}

// A whimsical random bot-style name for the curl example, so the docs don't
// imply any one crawler. e.g. "MossyHarvesterBot/4.2".
function randomBotName(): string {
  const adjectives = [
    "Mossy",
    "Curious",
    "Quiet",
    "Restless",
    "Velvet",
    "Copper",
    "Wandering",
    "Nimble",
    "Drowsy",
    "Hollow",
    "Amber",
    "Frosted",
    "Crimson",
    "Gentle",
    "Rogue",
  ];
  const nouns = [
    "Harvester",
    "Forager",
    "Lantern",
    "Pebble",
    "Magpie",
    "Otter",
    "Compass",
    "Beacon",
    "Thistle",
    "Falcon",
    "Comet",
    "Willow",
    "Sprocket",
    "Heron",
    "Cipher",
  ];
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const major = Math.floor(Math.random() * 9) + 1;
  const minor = Math.floor(Math.random() * 10);
  return `${pick(adjectives)}${pick(nouns)}Bot/${major}.${minor}`;
}

function clientIp(req: Request, info?: Deno.ServeHandlerInfo): string {
  // Deno Deploy sets x-forwarded-for; fall back to remote addr.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  const addr = info?.remoteAddr;
  if (addr && addr.transport === "tcp") return addr.hostname;
  return "unknown";
}

function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [k, v] of headers.entries()) obj[k] = v;
  return obj;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");
}

// Human-friendly elapsed duration, e.g. "830ms", "4.2s", "3m", "1h 5m".
function fmtDelta(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Extract a short, human-scannable name from a User-Agent string. Crawlers
// almost all begin "Mozilla/5.0 (compatible; …)", so the interesting token is
// buried mid-string; showing the full UA as the primary line makes every row
// look identical at a glance. This pulls out the distinguishing bit:
//   - the "compatible; X" token (ClaudeBot/1.0, Googlebot/2.1, ChatGPT-User/1.0)
//   - else a meaningful Name/Version token (Chrome/120, Edg/120, curl/8.0)
// The full UA is still rendered beneath it.
function uaHeadline(ua: string): string {
  if (!ua) return "(no user-agent)";
  // Bots: "compatible; Name/Ver" or "compatible; Name"
  const compat = ua.match(/compatible;\s*([^;,)]+)/i);
  if (compat) return compat[1].trim();
  // Name/Version tokens, dropping generic engine noise.
  const generic = new Set(["Mozilla", "AppleWebKit", "KHTML", "Gecko"]);
  const tokens = (ua.match(/[A-Za-z][\w.-]*\/[\d.]+/g) ?? [])
    .filter((t) => !generic.has(t.split("/")[0]));
  if (tokens.length) {
    const pref = tokens.find((t) => /(Chrome|Edg|OPR|Firefox|Safari|Version)/.test(t));
    return pref ?? tokens[tokens.length - 1];
  }
  // Fallback: first whitespace-delimited token.
  return ua.split(/\s+/)[0];
}

// ---------------------------------------------------------------------------
// Real tiny binary assets (generated/embedded — no Node Buffer).
// ---------------------------------------------------------------------------

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 1x1 transparent GIF.
const GIF_1x1 = decodeBase64(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
);

// 1x1 PNG. We build a real colored PNG so "image fetched" is unambiguous.
// CRC-32 implementation for valid PNG chunks.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = crc32(body);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc), 4 + body.length);
  return out;
}

// Build a real solid-color PNG of given width/height (RGB).
function makePng(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): Uint8Array<ArrayBuffer> {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR: width, height, bit depth 8, color type 2 (RGB), no interlace.
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(w), 0);
  ihdr.set(u32be(h), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // Raw image data: each row prefixed by filter byte 0, then RGB pixels.
  const rowLen = 1 + w * 3;
  const raw = new Uint8Array(rowLen * h);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter type none
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  // zlib stream with stored (uncompressed) deflate blocks.
  const zlib = deflateStored(raw);
  const png = concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
  return png;
}

// Minimal zlib wrapper using uncompressed deflate blocks (no Node deps).
function deflateStored(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  // zlib header: CMF=0x78, FLG=0x01 (no dict, fastest) -> 0x7801 is valid.
  blocks.push(new Uint8Array([0x78, 0x01]));
  let offset = 0;
  const MAX = 0xffff;
  while (offset < data.length) {
    const chunk = data.subarray(offset, Math.min(offset + MAX, data.length));
    const isFinal = offset + chunk.length >= data.length;
    const header = new Uint8Array(5);
    header[0] = isFinal ? 1 : 0; // BFINAL bit, BTYPE 00 (stored)
    const len = chunk.length;
    const nlen = (~len) & 0xffff;
    header[1] = len & 255;
    header[2] = (len >>> 8) & 255;
    header[3] = nlen & 255;
    header[4] = (nlen >>> 8) & 255;
    blocks.push(header);
    blocks.push(chunk);
    offset += chunk.length;
  }
  // Adler-32 checksum of uncompressed data (big-endian).
  blocks.push(u32be(adler32(data)));
  return concat(blocks);
}

function concat(arrs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

// A real minimal WOFF2 font (signature wOF2), a single blank-glyph font built
// offline with fonttools + woff2_compress. Real, parseable woff2 binary.
const WOFF2_FONT = decodeBase64(
  "d09GMgABAAAAAAEMAAoAAAAAAmgAAADFAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAoALAsGAAE2AiQDBgQgBXIHJhvXAWCeBXY7BzUWYqInhqK5en6X4vnvL3bue3+ngo2Wlj5QmKYUcBoINTu+HpTbxBCidOWVZ0VQjq0feI6n9T9OfXidHEcUceaBnY8SWCB+0oCi5oFurL4clsRyxCxO1DnztRjkgb2yME26CQqNTQs2w8QwBPPPi00AFMSK4yIIn2N/4a/dB/xmYXBNKxB6ipyAANNaEBSAQiDRU0CsCCgXq5ZxE7tNUcrd463chs7fCfStqE+0IglyGD48mw0WyiXowMABAA==",
);

// A real 16x16 ICO favicon (valid image/x-icon), built offline with Pillow.
const ICO_FAVICON = decodeBase64(
  "AAABAAEAEBAAAAAAIABWAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAB1JREFUeJxjTE77+J+BAsBEieZRA0YNGDVgMBkAAE1HAtnWJSmuAAAAAElFTkSuQmCC",
);

// ---------------------------------------------------------------------------
// Logging of hits
// ---------------------------------------------------------------------------

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

async function logHit(rec: HitRecord): Promise<void> {
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
    if (trace.value) {
      const recentKey = recentIndexKey(trace.value.ts, rec.id);
      const uKey = uaIndexKey(trace.value.ua, trace.value.ts, rec.id);
      const aKey = uaAggKey(trace.value.ua);
      // Concurrent sub-requests (css-bg, js-ran, font, …) all update the same
      // stats entry, so use an atomic compare-and-set on the versionstamp with
      // a small retry loop. A plain get→set races and loses updates (e.g. the
      // jsRan flag getting clobbered). The same atomic also mirrors the
      // snapshot to the per-UA index and bumps the per-UA aggregate, so all
      // three views stay consistent.
      for (let attempt = 0; attempt < 8; attempt++) {
        const cur = await kv.get<TraceStats>(recentKey);
        if (!cur.value) break; // entry not seeded (shouldn't happen)
        const s = cur.value;
        const wasJsRan = s.jsRan;
        s.assetCount += 1;
        if (rec.kind === "js-ran") s.jsRan = true;
        if (!s.kinds.includes(rec.kind)) s.kinds.push(rec.kind);
        // Bump the UA aggregate only for the fields that change here: the
        // jsRan counter flips exactly once per trace (false -> true).
        const aggCur = await kv.get<UaAggregate>(aKey);
        const agg = aggCur.value ??
          { ua: trace.value.ua || "(no user-agent)", count: 0, jsRan: 0 };
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
        if (res.ok) break;
        // Lost the race: brief backoff, then retry with fresh value.
        await new Promise((r) => setTimeout(r, 5 + attempt * 5));
      }
    }
  }

  console.log(
    `[hit] trace=${rec.id} kind=${rec.kind} ip=${rec.ip} ua="${rec.ua.slice(0, 80)}"`,
  );
}

async function listHits(id: string): Promise<HitRecord[]> {
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
async function recentTraces(limit = 100): Promise<TraceStats[]> {
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
async function searchTracesByUa(
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
async function uaAggregate(
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
interface ProbeRecord {
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
async function logProbe(path: string, req: Request, ip: string): Promise<void> {
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
async function recentProbes(limit = 200): Promise<ProbeRecord[]> {
  const kv = await getKv();
  const out: ProbeRecord[] = [];
  for await (
    const entry of kv.list<ProbeRecord>({ prefix: ["probe"] }, { limit })
  ) {
    if (entry.value) out.push(entry.value);
  }
  return out;
}

// Correlate an unsolicited probe to a homepage trace. The same crawler that
// fetches /robots.txt usually also loads / (minting a trace) from the same IP
// with the same UA, often within a short window. We match on UA+IP and pick the
// trace closest in time. Returns the trace and how far apart they were (ms),
// or null when no plausible same-agent trace exists.
const CORRELATE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Canonical custom domain. The app is also reachable on its *.deno.net deploy
// URL, but that host should never be indexed: every page carries a canonical
// link to this origin, and requests arriving on a *.deno.net host are 301'd here.
const CANONICAL_HOST = "uatracer.com";
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;
function correlateProbe(
  probe: ProbeRecord,
  traces: TraceStats[],
): { trace: TraceStats; deltaMs: number } | null {
  let best: { trace: TraceStats; deltaMs: number } | null = null;
  for (const t of traces) {
    if (t.ip !== probe.ip) continue;
    if ((t.ua || "") !== (probe.ua || "")) continue;
    const deltaMs = Math.abs(t.ts - probe.ts);
    if (deltaMs > CORRELATE_WINDOW_MS) continue;
    if (!best || deltaMs < best.deltaMs) best = { trace: t, deltaMs };
  }
  return best;
}

// ---------------------------------------------------------------------------
// HTML rendering (page chrome inline — replicating aifoc.us look)
// ---------------------------------------------------------------------------

const INLINE_STYLE = `
:root {
  color-scheme: light dark;
  --color: #000000;
  --background: #fdfcf8;
  --bg-secondary: #f0eee6;
  --border: #e3e0d6;
  --muted: #555;
  --accent-bg: #e7eefb;
  --accent-border: #b9cdf2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color: #e8e4dc;
    --background: #1c1a17;
    --bg-secondary: #2a2723;
    --border: #3a362f;
    --muted: #aaa;
    --accent-bg: #1f2c44;
    --accent-border: #2f4570;
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
  line-height: 1.7;
  color: var(--color);
  background-color: var(--background);
  display: flex;
  flex-direction: column;
}
main { max-width: 860px; width: 100%; margin: auto; padding: 1.5em 1em 4em; }
.site-branding-header { width: 100%; margin-bottom: 2em; padding-top: 1em; }
.site-branding-line {
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid var(--color); padding-bottom: 10px; margin-bottom: 18px;
}
.site-branding-line .tag {
  font-size: 0.8em; text-transform: uppercase; letter-spacing: 1px; color: var(--muted);
}
.site-branding-title {
  font-family: Georgia, "Times New Roman", Times, serif;
  font-size: 3.2em; line-height: 1; font-weight: normal; text-align: center;
  color: var(--color); margin: 0;
}
.site-branding-title a { color: inherit; text-decoration: none; }
.subtitle {
  font-family: Georgia, "Times New Roman", Times, serif;
  text-align: center; color: var(--muted); font-size: 1.15em; margin-top: 0.4em;
}
.current-trace-link {
  text-align: center; margin: 0 0 1em;
}
.current-trace-link a {
  display: inline-block; padding: 0.5em 1.1em; border: 1px solid var(--border);
  border-radius: 999px; background: var(--bg-secondary); text-decoration: none;
  font-weight: 600; font-size: 0.95em;
}
.current-trace-link a:hover { background: var(--border); }
.current-trace-link code { background: transparent; padding: 0; }
.quick-nav { margin: 0 0 2em; }
.quick-nav .qn-group { margin-bottom: 0.7em; }
.quick-nav .qn-group:last-child { margin-bottom: 0; }
.quick-nav .qn-label {
  display: block; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); margin-bottom: 0.4em; font-weight: 600;
}
.quick-nav .qn-pills { display: flex; flex-wrap: wrap; gap: 0.45em; }
.quick-nav a.qn-pill {
  display: inline-flex; align-items: center; gap: 0.4em; padding: 0.4em 0.85em;
  border: 1px solid var(--border); border-radius: 999px; background: var(--bg-secondary);
  color: var(--color); text-decoration: none; font-size: 0.86em; line-height: 1.2;
  white-space: nowrap;
}
.quick-nav a.qn-pill:hover { background: var(--border); }
.quick-nav a.qn-pill.qn-primary { background: var(--accent-bg); border-color: var(--accent-border); }
.quick-nav a.qn-pill svg { width: 14px; height: 14px; flex: 0 0 auto; opacity: 0.75; }
.quick-nav a.qn-pill code { background: transparent; padding: 0; font-size: 0.92em; }
h1, h2, h3 { font-family: Georgia, "Times New Roman", Times, serif; font-weight: normal; }
h2 { font-size: 1.8em; margin: 1.4em 0 0.5em; }
h3 { font-size: 1.3em; margin: 1.2em 0 0.4em; }
p { margin-bottom: 1em; }
a { color: #1a56b0; }
@media (prefers-color-scheme: dark) { a { color: #8ab4f8; } }
.explainer {
  font-family: Georgia, "Times New Roman", Times, serif;
  font-size: 1.1em; background: var(--bg-secondary);
  border: 1px solid var(--border); border-radius: 6px; padding: 1.2em 1.4em; margin: 1.2em 0;
}
table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.92em; }
th, td { text-align: left; padding: 0.55em 0.6em; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-family: -apple-system, sans-serif; text-transform: uppercase; font-size: 0.75em;
  letter-spacing: 0.05em; color: var(--muted); }
tr:hover td { background: var(--bg-secondary); }
.ua { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 0.85em;
  max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
/* Multiline UA cell: bold scannable headline on top (ClaudeBot/1.0, Chrome/120),
   full UA string wrapped beneath in muted small type. Stops every row looking
   identical (they all start "Mozilla/5.0 (compatible; …"). */
.ua-cell { min-width: 0; }
.ua-headline { font-weight: 600; font-size: 0.95em; }
.ua-headline a { color: inherit; text-decoration: none; }
.ua-headline a:hover { text-decoration: underline; }
.ua-full { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 0.75em;
  color: var(--muted); word-break: break-all; line-height: 1.35; margin-top: 0.1em; }
.mono { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 0.85em; }
.badge { display: inline-block; padding: 0.1em 0.55em; border-radius: 999px; font-size: 0.78em;
  font-family: -apple-system, sans-serif; font-weight: 600; border: 1px solid var(--border); }
.badge.yes { background: #d8f5d8; color: #14532d; border-color: #9fd9a0; }
.badge.no { background: #f5dada; color: #7f1d1d; border-color: #e0a3a3; }
/* Kind pills mark a sub-resource the UA actually fetched/triggered, so they
   read as positive (green), like the "JS ran" badge. Absence of a pill means
   the UA did not fetch that resource. */
.badge.kind { background: #d8f5d8; color: #14532d; border-color: #9fd9a0; }
@media (prefers-color-scheme: dark) {
  .badge.yes { background: #16351a; color: #b6e8bb; border-color: #2f6b35; }
  .badge.no { background: #3a1717; color: #f0b4b4; border-color: #6b2f2f; }
  .badge.kind { background: #16351a; color: #b6e8bb; border-color: #2f6b35; }
}
.kinds { display: flex; gap: 0.4em; flex-wrap: wrap; }
.delta { color: var(--muted); font-variant-numeric: tabular-nums; }
.waterfall { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 0.8em; }
.bar { display: inline-block; height: 0.85em; background: #1a56b0; border-radius: 2px; vertical-align: middle; min-width: 2px; }
@media (prefers-color-scheme: dark) { .bar { background: #8ab4f8; } }
footer { max-width: 860px; margin: 2em auto 3em; padding-top: 1em; border-top: 1px solid var(--border);
  text-align: center; font-size: 0.9em; color: var(--muted); }
code { font-family: SFMono-Regular, Consolas, Menlo, monospace; background: var(--bg-secondary);
  padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
.empty { color: var(--muted); font-style: italic; }
.probe-panel { margin: 2em 0 0.5em; padding: 1em 1.2em; border: 1px dashed var(--border);
  border-radius: 8px; background: var(--background); }
.probe-panel h3 { margin: 0 0 0.5em; font-size: 1.1em; }
.probe-panel p { margin-bottom: 0.7em; }
.probe-panel code { font-size: 0.85em; }
.probe-img-row { display: flex; align-items: center; gap: 0.7em; color: var(--muted); font-size: 0.9em; }
.probe-img { border-radius: 6px; display: block; flex: 0 0 auto; }
.filter-bar { display: flex; gap: 0.5em; align-items: center; margin: 0.6em 0 1em; flex-wrap: wrap; }
.filter-bar input[type="search"] { flex: 1; min-width: 240px; padding: 0.5em 0.7em;
  font-size: 0.95em; border: 1px solid var(--border); border-radius: 6px;
  background: var(--background); color: var(--color); }
.filter-bar button { padding: 0.5em 1.1em; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-secondary); color: var(--color); cursor: pointer; font-size: 0.95em; }
.filter-bar button:hover { background: var(--border); }
.filter-bar .clear-filter { font-size: 0.9em; color: var(--muted); }
details summary { cursor: pointer; color: var(--muted); font-size: 0.85em; }
/* The headers expando renders as a full-width row beneath its request row. */
tr.headers-row td { border-top: none; padding-top: 0; padding-bottom: 0.4em; }
tr.headers-row:hover td { background: transparent; }
tr.headers-row pre.headers { margin-top: 0.5em; max-width: 100%; }
pre.headers { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 0.78em;
  background: var(--bg-secondary); padding: 0.8em; border-radius: 4px; overflow-x: auto; margin-top: 0.4em;
  white-space: pre-wrap; word-break: break-all; }
.pager { display: flex; gap: 1em; align-items: center; margin: 0.6em 0; font-size: 0.9em; flex-wrap: wrap; }
.pager .muted { color: var(--muted); }
.scrollx { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }
.kinds-cell { display: flex; gap: 0.3em; flex-wrap: wrap; align-items: center; }
.kinds-cell .badge { font-weight: 500; font-size: 0.72em; }
/* Each request renders as two rows: the main row, then a snug full-width pills
   row (sub-resources + JS state) so variable pill counts don't make the main
   rows different heights. */
tr.req-row td { border-bottom: none; padding-bottom: 0.25em; }
tr.pills-row td { border-top: none; padding-top: 0; padding-bottom: 0.7em; }
tr.pills-row:hover td { background: transparent; }
.see-all { font-size: 0.9em; }
.active-filter { font-size: 0.92em; background: var(--accent-bg); border: 1px solid var(--accent-border);
  border-radius: 6px; padding: 0.5em 0.8em; display: inline-block; }
@media (max-width: 640px) {
  main { padding: 1.2em 0.7em 3em; }
  table { font-size: 0.8em; }
  th, td { padding: 0.4em 0.4em; }
  .ua { max-width: 150px; }
  .site-branding-title { font-size: 1.6em; }
  .filter-bar input[type="search"] { min-width: 0; }
}
`;

// Small inline SVG icon set (no emoji per house style). 14x14, currentColor.
const ICON: Record<string, string> = {
  trace:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15"/></svg>',
  list:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M5 4h9M5 8h9M5 12h9M2 4h.01M2 8h.01M2 12h.01"/></svg>',
  filter:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13L6.5 14V8.5L2 3z"/></svg>',
  bot:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 5V2.5M5.5 9h.01M10.5 9h.01"/></svg>',
  globe:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>',
  doc:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8h4M6 11h4"/></svg>',
  health:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1 8h3l1.5-4 3 8L12 8h3"/></svg>',
  github:
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 00-2.5 15.6c.4.07.55-.17.55-.38v-1.3c-2.2.48-2.67-1.07-2.67-1.07-.36-.92-.88-1.16-.88-1.16-.72-.5.05-.48.05-.48.8.05 1.22.82 1.22.82.71 1.2 1.87.86 2.33.66.07-.52.28-.86.5-1.06-1.76-.2-3.6-.88-3.6-3.9 0-.86.3-1.57.82-2.12-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.81a7.6 7.6 0 014 0c1.53-1.02 2.2-.8 2.2-.8.44 1.1.16 1.9.08 2.1.5.56.82 1.27.82 2.13 0 3.03-1.85 3.7-3.6 3.9.28.24.54.72.54 1.46v2.16c0 .21.15.46.55.38A8 8 0 008 0z"/></svg>',
};

// A categorised quick-links nav shown under the header on the homepage and
// /traces. `currentId` (optional) adds a link straight to the request's trace.
function quickLinks(opts: { currentId?: string; origin?: string }): string {
  const { currentId } = opts;
  const pill = (href: string, icon: string, label: string, primary = false) =>
    `<a class="qn-pill${primary ? " qn-primary" : ""}" href="${href}">${
      ICON[icon] ?? ""
    }<span>${label}</span></a>`;

  const traceGroup = `
  <div class="qn-group">
    <span class="qn-label">This request</span>
    <div class="qn-pills">
      ${
    currentId
      ? pill(`/trace/${encodeURIComponent(currentId)}`, "trace", "View this trace", true)
      : pill("/", "trace", "New trace (load /)", true)
  }
      ${pill("/", "trace", "Re-roll a new trace")}
    </div>
  </div>`;

  const browseGroup = `
  <div class="qn-group">
    <span class="qn-label">Browse &amp; filter</span>
    <div class="qn-pills">
      ${pill("/traces", "list", "All recent requests")}
      ${pill("/traces#by-user-agent", "bot", "By user agent")}
      ${pill("/traces?ua=bot", "filter", "Filter: bot")}
      ${pill("/traces?ua=Googlebot", "filter", "Googlebot")}
      ${pill("/traces?ua=GPTBot", "filter", "GPTBot")}
      ${pill("/traces?ua=ClaudeBot", "filter", "ClaudeBot")}
    </div>
  </div>`;

  // Each pill is a FILTER: it opens the probe log showing every request that
  // asked for that path, not a link that visits the file itself.
  const pathPill = (path: string, label: string) =>
    pill(`/traces?path=${encodeURIComponent(path)}#unsolicited`, "doc", label);
  const wellKnownGroup = `
  <div class="qn-group">
    <span class="qn-label">Well-known &amp; agent files — see every request that asked for each path</span>
    <div class="qn-pills">
      ${pill("/traces#unsolicited", "globe", "All unsolicited requests")}
      ${pathPill("/robots.txt", "robots.txt")}
      ${pathPill("/sitemap.xml", "sitemap.xml")}
      ${pathPill("/llms.txt", "llms.txt")}
      ${pathPill("/.well-known/", ".well-known/*")}
      ${pathPill("/security.txt", "security.txt")}
      ${pathPill("/ai-plugin.json", "ai-plugin.json")}
      ${pathPill("/ai.txt", "ai.txt")}
      ${pathPill("/humans.txt", "humans.txt")}
      ${pathPill("/favicon.ico", "favicon.ico")}
    </div>
  </div>`;

  const metaGroup = `
  <div class="qn-group">
    <span class="qn-label">Meta</span>
    <div class="qn-pills">
      ${pill("/api/health", "health", "Health")}
      ${pill("https://github.com/PaulKinlan/ua-tracer", "github", "Source")}
    </div>
  </div>`;

  return `<nav class="quick-nav" aria-label="Quick links">
${traceGroup}
${browseGroup}
${wellKnownGroup}
${metaGroup}
</nav>`;
}

function pageShell(title: string, body: string, canonicalPath = "/"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="ua-tracer — see what a user agent downloads, follows, and executes.">
<link rel="canonical" href="${CANONICAL_ORIGIN}${canonicalPath}">
<style>${INLINE_STYLE}</style>
</head>
<body>
<main>
<header class="site-branding-header">
  <div class="site-branding-line">
    <span class="tag">ua-tracer</span>
    <span class="tag">by Paul Kinlan</span>
  </div>
  <h1 class="site-branding-title"><a href="/">ua-tracer</a></h1>
  <p class="subtitle">what does a user agent actually fetch, follow & run?</p>
</header>
${body}
<footer>
  <p>ua-tracer &middot; <a href="https://github.com/PaulKinlan/ua-tracer">source on GitHub</a> &middot; styled after <a href="https://aifoc.us">aifoc.us</a></p>
</footer>
</main>
</body>
</html>`;
}

// Short labels for the per-trace "Fetched" sub-resource badges.
const SHORT_KIND: Partial<Record<AssetKind, string>> = {
  css: "CSS",
  js: "JS",
  module: "module",
  img: "img",
  font: "font",
  "css-bg": "css-bg",
  "css-font": "css-font",
  favicon: "favicon",
  "apple-icon": "apple-icon",
  manifest: "manifest",
  "manifest-icon": "mf-icon",
  preload: "preload",
  prefetch: "prefetch",
  "og-image": "og-img",
  "twitter-image": "twitter-img",
  iframe: "iframe",
  "iframe-img": "iframe-img",
  "css-import": "@import",
  "csp-report": "CSP report",
  report: "report-api",
};
const KIND_ORDER: AssetKind[] = [
  "css",
  "js",
  "module",
  "img",
  "font",
  "css-bg",
  "css-font",
  "favicon",
  "apple-icon",
  "manifest",
  "manifest-icon",
  "preload",
  "prefetch",
  "og-image",
  "twitter-image",
  "iframe",
  "iframe-img",
  "css-import",
  "csp-report",
  "report",
];
function kindBadges(kinds: AssetKind[]): string {
  const present = KIND_ORDER.filter((k) => kinds.includes(k));
  if (!present.length) return '<span class="muted">—</span>';
  return present.map((k) => `<span class="badge kind">${SHORT_KIND[k] ?? k}</span>`).join("");
}

// Render the recent-requests rows: a main row (timestamp, UA, assets) plus
// a snug full-width pills row beneath it (JS state + each sub-resource fetched).
// Keeping the pills out of the main columns keeps every main row the same height.
// IP is captured and stored but intentionally not displayed for now — the plan
// is to surface IPs for bots only, not for human visitors.
function traceRows(traces: TraceStats[]): string {
  return traces.map((t) => {
    const js = t.jsRan
      ? '<span class="badge yes">JS ran</span>'
      : '<span class="badge no">no JS</span>';
    const full = t.ua || "";
    const fullSafe = escapeHtml(full);
    // UA cell: a bold scannable headline (links to the filtered list) on top,
    // full UA string wrapped beneath in muted small type. The headline is the
    // distinguishing token (ClaudeBot/1.0, Chrome/120, …) instead of every
    // row starting "Mozilla/5.0 (compatible; …".
    const uaCell = full
      ? `<div class="ua-headline"><a href="/traces?ua=${
        encodeURIComponent(full)
      }" class="ua-link" title="${fullSafe}">${escapeHtml(uaHeadline(full))}</a></div>` +
        `<div class="ua-full" title="${fullSafe}">${fullSafe}</div>`
      : `<div class="ua-headline"><span class="muted">(no user-agent)</span></div>`;
    return `<tr class="req-row">
  <td class="mono"><a href="/trace/${escapeHtml(t.id)}">${fmtTs(t.ts)}</a></td>
  <td class="ua-cell">${uaCell}</td>
  <td class="mono">${t.assetCount}</td>
</tr>
<tr class="pills-row"><td colspan="3"><div class="kinds-cell">${js}${
      kindBadges(t.kinds)
    }</div></td></tr>`;
  }).join("\n");
}

const REQ_TABLE_HEAD =
  "<thead><tr><th>Timestamp</th><th>User Agent</th><th>Assets</th></tr></thead>";

// Render a prev/next pager. `href(p)` builds the link for page p (0-based).
function pager(page: number, total: number, size: number, href: (p: number) => string): string {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return "";
  const prev = page > 0
    ? `<a href="${href(page - 1)}">← prev</a>`
    : `<span class="muted">← prev</span>`;
  const next = page < pages - 1
    ? `<a href="${href(page + 1)}">next →</a>`
    : `<span class="muted">next →</span>`;
  const start = total === 0 ? 0 : page * size + 1;
  const end = Math.min(total, (page + 1) * size);
  return `<div class="pager">${prev}<span class="muted">${start}–${end} of ${total}</span>${next}</div>`;
}

const UA_PAGE_SIZE = 25;
const REQ_PAGE_SIZE = 50;

interface HomepageOpts {
  id: string;
  origin: string;
  secret?: string;
  traces: TraceStats[];
  uaGroups: Map<string, { count: number; jsRan: number }>;
  uaFilter: string;
  totalTraces: number;
}

function homepageHtml(opts: HomepageOpts): string {
  const { id, origin, secret, traces, uaGroups, uaFilter, totalTraces } = opts;
  const base = assetBase(id, secret);
  // Probe assets all reference {id}. Page chrome styling is INLINE only.
  // These <head> links exercise: stylesheet, font preload, favicon,
  // apple-touch-icon, web app manifest, speculative preload/prefetch.
  const probeHead = `
<link rel="stylesheet" href="${base}/style.css">
<link rel="preload" as="font" type="font/woff2" href="${base}/font.woff2" crossorigin>
<link rel="icon" type="image/x-icon" href="${base}/favicon.ico">
<link rel="apple-touch-icon" href="${base}/apple-touch-icon.png">
<link rel="manifest" href="${base}/manifest.json">
<link rel="preload" as="image" href="${base}/preload.png">
<link rel="prefetch" href="${base}/prefetch.png">
<meta property="og:title" content="ua-tracer">
<meta property="og:description" content="See what a user agent downloads, follows, and executes.">
<meta property="og:type" content="website">
<meta property="og:image" content="${origin}${base}/og-image.png">
<meta property="og:url" content="${origin}/">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="ua-tracer">
<meta name="twitter:description" content="See what a user agent downloads, follows, and executes.">
<meta name="twitter:image" content="${origin}${base}/twitter-image.png">
`;
  // Homepage shows a bounded preview (paging lives on /traces, which does not
  // mint a trace on each navigation).
  const shownTraces = traces.slice(0, REQ_PAGE_SIZE);
  const rows = traceRows(shownTraces);

  const tracesHref = uaFilter ? `/traces?ua=${encodeURIComponent(uaFilter)}` : "/traces";
  const table = traces.length
    ? `<div class="scrollx"><table>
${REQ_TABLE_HEAD}
<tbody>${rows}</tbody>
</table></div>${
      traces.length > REQ_PAGE_SIZE
        ? `<p class="see-all"><a href="${tracesHref}">View all recent requests (paged) →</a></p>`
        : ""
    }`
    : `<p class="empty">${
      uaFilter
        ? `No homepage requests match user-agent filter <code>${escapeHtml(uaFilter)}</code>.`
        : `No traces recorded yet. This very page load just created one (<code>${
          escapeHtml(id)
        }</code>) — reload to see it.`
    }</p>`;

  // Per-UA summary: running counts grouped by exact UA string, newest activity
  // surfaced as a leaderboard. Each row links to the filtered view.
  const uaEntries = [...uaGroups.entries()].sort((a, b) => b[1].count - a[1].count);
  const uaRows = uaEntries.slice(0, UA_PAGE_SIZE).map(([ua, g]) => {
    const short = ua.length > 70 ? ua.slice(0, 70) + "…" : ua;
    return `<tr>
  <td><a href="/traces?ua=${encodeURIComponent(ua)}" class="ua" title="${escapeHtml(ua)}">${
      escapeHtml(short)
    }</a></td>
  <td class="mono">${g.count}</td>
  <td class="mono">${g.jsRan}</td>
</tr>`;
  }).join("\n");

  const uaSummary = uaGroups.size
    ? `<div class="scrollx"><table>
<thead><tr><th>User Agent</th><th>Requests</th><th>JS ran</th></tr></thead>
<tbody>${uaRows}</tbody>
</table></div>${
      uaEntries.length > UA_PAGE_SIZE
        ? `<p class="see-all"><a href="/traces">View all ${uaEntries.length} user agents (paged) →</a></p>`
        : ""
    }`
    : `<p class="empty">No user agents seen yet.</p>`;

  // Filtering/browsing happens on /traces (read-only, no minting), so the
  // homepage filter and per-UA links send you there with results shown together.
  const filterBar = `
<form method="get" action="/traces" class="filter-bar">
  <input type="search" name="ua" value="${
    escapeHtml(uaFilter)
  }" placeholder="filter by user-agent substring, e.g. ClaudeBot" aria-label="Filter by user agent">
  <button type="submit">Filter</button>
  ${uaFilter ? `<a href="/" class="clear-filter">clear</a>` : ""}
</form>`;

  const body = `
<section class="explainer">
<p>This page just minted a fresh trace id <code>${escapeHtml(id)}</code>. Every asset it references
lives under <code>${
    escapeHtml(base)
  }/…</code>, so each fetch is tied back to <em>this</em> request and
your User-Agent. Layered probes inside the CSS and JS reveal whether your UA parses CSS, follows
resources linked from CSS, and actually executes JavaScript.</p>
<p><strong>Try it:</strong> point a crawler at this URL, or run a fresh trace with curl —
each load is its own trace:</p>
<pre class="headers">curl -A "${escapeHtml(randomBotName())}" ${escapeHtml(origin)}/</pre>
<p style="margin-bottom:0">…then open the matching row below. A plain <code>curl</code> only records the homepage
hit (it parses no CSS and runs no JS) — that contrast is the whole point.</p>
</section>
${quickLinks({ currentId: id, origin })}

<h2>By user agent</h2>
<p>Running counts across all ${totalTraces} homepage requests, grouped by user agent.
Click one to filter the list below.</p>
${uaSummary}

<h2>Recent homepage requests</h2>
<p>Newest first. Each row is a single load of <code>/</code> by some user agent.${
    uaFilter ? ` Filtered to user agents containing <code>${escapeHtml(uaFilter)}</code>.` : ""
  }</p>
${filterBar}
${table}

<!-- ua-tracer probe assets below: real CSS, JS, image, font, all carrying the trace id -->
<!--
  The element below carries .ua-tracer-probe so a RENDERING engine is forced to
  fetch the CSS-linked resources: the background-image (css-bg.png) and the
  @font-face source (css-font.woff2). Browsers fetch those lazily — only when an
  on-screen element actually uses them — so the probe must be rendered (not
  display:none / not removed from layout) and must contain text in the custom
  font. We keep it visible but quiet.
-->
<section class="probe-panel" aria-hidden="true">
  <h3>Live probe assets</h3>
  <p class="ua-tracer-probe">This line is set in the probe @font-face and shows the CSS background-image swatch on the left. If your user agent fetched <code>css-bg.png</code> and <code>css-font.woff2</code>, it parsed the stylesheet and followed resources linked from inside it.</p>
  <p class="probe-img-row"><img src="${base}/photo.png" width="40" height="40" alt="probe image (PNG referenced from the HTML)" class="probe-img"> <span>A real PNG referenced directly from the HTML.</span></p>
  <p>An iframe is embedded below; loading it (and the image inside it) shows whether the UA descends into frames.</p>
  <iframe src="${base}/iframe" width="220" height="60" title="ua-tracer iframe probe" style="border:1px solid var(--border);border-radius:4px"></iframe>
</section>
<script src="${base}/main.js"></script>
<script type="module" src="${base}/module.js"></script>
`;

  // Inject probeHead into the shell head via a marker swap.
  return pageShell("ua-tracer", body, "/").replace(
    "</head>",
    `${probeHead}</head>`,
  );
}

// ---------------------------------------------------------------------------
// Real asset bodies
// ---------------------------------------------------------------------------

function cssBody(id: string, secret?: string): string {
  const base = assetBase(id, secret);
  // References two further probes: a background image and an @font-face source.
  // The .ua-tracer-probe element in the page renders with this rule, which
  // forces a real engine to fetch both CSS-linked resources:
  //  - background-image -> css-bg.png  (only fetched for a rendered, sized box)
  //  - font-family on text -> @font-face src css-font.woff2
  // font-display:block (not swap) makes engines that load fonts request the
  // woff2 promptly rather than deferring it indefinitely.
  // The probe panel must (a) render a sized box with a CSS background-image so
  // css-bg.png is fetched, and (b) render text in @font-face "uatracerprobe" so
  // css-font.woff2 is fetched. We keep the background-image as a small swatch
  // pinned to the left edge (not tiled across the text) so the body text stays
  // high-contrast in both light and dark mode.
  // @import is at the very top (required by CSS). Fetching import.css proves the
  // UA followed a stylesheet imported from inside another stylesheet.
  return `@import url("${base}/import.css");
/* ua-tracer probe stylesheet for trace ${id} */
@font-face {
  font-family: "uatracerprobe";
  src: url("${base}/css-font.woff2") format("woff2");
  font-display: block;
}
.ua-tracer-probe {
  display: block;
  min-height: 1.6em;
  padding: 0.7em 0.9em 0.7em 3.4em;
  margin: 1.4em 0;
  color: var(--color);
  font-size: 0.9em;
  line-height: 1.5;
  font-family: "uatracerprobe", Georgia, serif;
  /* css-bg.png shown as a 24px swatch on the left only — proves the fetch
     without bleeding under the text. background-color comes from the page. */
  background-image: url("${base}/css-bg.png");
  background-repeat: no-repeat;
  background-position: 0.9em center;
  background-size: 24px 24px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
}
`;
}

function jsBody(id: string, secret?: string): string {
  const base = assetBase(id, secret);
  // On execution: beacon js-ran.gif and POST resource timing to /timing.
  return `// ua-tracer probe script for trace ${id}
(function () {
  try {
    // (a) Prove JS executed: beacon a unique gif.
    new Image().src = ${JSON.stringify(`${base}/js-ran.gif`)} + "?t=" + Date.now();
  } catch (e) {}

  // CSP / Reporting probes. The page is served with a report-only CSP that the
  // page deliberately violates (an inline style + a disallowed image source).
  // Browsers DELIVER report-uri/report-to reports lazily (batched, often only
  // on unload), so headless/crawler runs miss them. To capture the signal
  // reliably we also listen in-page and beacon immediately:
  //  - securitypolicyviolation event fires synchronously on each violation.
  //  - ReportingObserver surfaces queued reports (csp-violation, deprecation…).
  function beacon(url, payload) {
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
      } else {
        fetch(url, { method: "POST", body: payload, headers: { "content-type": "application/json" }, keepalive: true });
      }
    } catch (e) {}
  }
  try {
    document.addEventListener("securitypolicyviolation", function (e) {
      beacon(${JSON.stringify(`${base}/csp-report`)}, JSON.stringify({
        source: "securitypolicyviolation",
        violatedDirective: e.violatedDirective,
        effectiveDirective: e.effectiveDirective,
        blockedURI: e.blockedURI,
        documentURI: e.documentURI,
        disposition: e.disposition,
        lineNumber: e.lineNumber,
        sourceFile: e.sourceFile,
        ua: navigator.userAgent
      }));
    });
    // The inline <style>/style="" violations in <head> fire DURING parse,
    // before this script ran, so the listener above would miss them. Trigger a
    // fresh inline-style violation now (listener is attached) by inserting an
    // element with an inline style attribute, which violates style-src 'self'
    // under the report-only policy and fires securitypolicyviolation.
    var probe = document.createElement("div");
    probe.style.cssText = "position:absolute;left:-9999px";
    probe.setAttribute("style", "position:absolute;left:-9999px;color:rebeccapurple");
    (document.body || document.documentElement).appendChild(probe);
  } catch (e) {}
  try {
    if (typeof ReportingObserver !== "undefined") {
      var ro = new ReportingObserver(function (reports) {
        try {
          beacon(${JSON.stringify(`${base}/report`)}, JSON.stringify({
            source: "ReportingObserver",
            reports: reports.map(function (r) { return { type: r.type, url: r.url, body: r.body }; }),
            ua: navigator.userAgent
          }));
        } catch (e) {}
      }, { buffered: true });
      ro.observe();
    }
  } catch (e) {}

  function send() {
    try {
      var entries = [];
      if (window.performance && performance.getEntriesByType) {
        entries = performance.getEntriesByType("resource").map(function (e) {
          return {
            name: e.name,
            entryType: e.entryType,
            startTime: Math.round(e.startTime * 100) / 100,
            duration: Math.round(e.duration * 100) / 100,
            initiatorType: e.initiatorType,
            transferSize: e.transferSize
          };
        });
      }
      var payload = JSON.stringify({ entries: entries, ua: navigator.userAgent });
      var url = ${JSON.stringify(`${base}/timing`)};
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
      } else {
        fetch(url, { method: "POST", body: payload, headers: { "content-type": "application/json" }, keepalive: true });
      }
    } catch (e) {}
  }
  // Give other resources a moment to load before reporting timing.
  if (document.readyState === "complete") {
    setTimeout(send, 600);
  } else {
    window.addEventListener("load", function () { setTimeout(send, 600); });
  }
})();
`;
}

function manifestBody(id: string, secret?: string): string {
  const base = assetBase(id, secret);
  // A real web app manifest that references its own icon. A UA that fetches
  // manifest-icon.png has parsed the manifest and followed a link from inside
  // it (a second-level follow, like the CSS-linked probes).
  return JSON.stringify(
    {
      name: "ua-tracer probe",
      short_name: "ua-tracer",
      start_url: "/",
      display: "standalone",
      background_color: "#fdfcf8",
      theme_color: "#1a56b0",
      icons: [
        {
          src: `${base}/manifest-icon.png`,
          sizes: "16x16",
          type: "image/png",
        },
      ],
    },
    null,
    2,
  );
}

function moduleBody(id: string, secret?: string): string {
  const base = assetBase(id, secret);
  // An ES module (<script type="module">). Running it beacons module-ran.gif,
  // proving the UA executes module-type scripts (some run classic JS but skip
  // modules, or vice versa).
  return `// ua-tracer ES module probe for trace ${id}
const beacon = ${JSON.stringify(`${base}/module-ran.gif`)};
try {
  new Image().src = beacon + "?t=" + Date.now();
} catch (e) {
  // Non-DOM module runtime: fall back to fetch.
  try {
    fetch(beacon + "?t=" + Date.now(), { method: "GET", keepalive: true });
  } catch (_e) { /* ignore */ }
}
export const ran = true;
`;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function noStore(headers: HeadersInit = {}): Headers {
  const h = new Headers(headers);
  // Defeat caching so crawlers re-fetch and we always log.
  h.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  h.set("pragma", "no-cache");
  return h;
}

async function handleAsset(
  req: Request,
  id: string,
  asset: string,
  ip: string,
  providedSecret?: string,
): Promise<Response> {
  const ua = req.headers.get("user-agent") ?? "";
  const ts = Date.now();
  const headers = headersToObject(req.headers);

  // Verify the per-trace secret. New traces store a secret on the TraceRecord
  // and require it in the URL (/r/{id}/{secret}/...); old traces (no secret
  // field) accept the legacy /r/{id}/... path. A wrong/missing secret on a
  // new trace returns 404 (same as not-found, so probes can't distinguish).
  const kv = await getKv();
  const trace = await kv.get<TraceRecord>(["trace", id]);
  const storedSecret = trace.value?.secret;
  if (providedSecret !== undefined) {
    // New-format URL: /r/{id}/{secret}/{asset}
    if (storedSecret && providedSecret !== storedSecret) {
      return new Response("Not found", { status: 404 });
    }
  } else {
    // Legacy URL: /r/{id}/{asset} — only allowed for traces without a secret.
    if (storedSecret) {
      return new Response("Not found", { status: 404 });
    }
  }

  const map: Record<string, AssetKind> = {
    "style.css": "css",
    "main.js": "js",
    "photo.png": "img",
    "font.woff2": "font",
    "css-bg.png": "css-bg",
    "css-font.woff2": "css-font",
    "js-ran.gif": "js-ran",
    "timing": "timing",
    "favicon.ico": "favicon",
    "apple-touch-icon.png": "apple-icon",
    "manifest.json": "manifest",
    "manifest-icon.png": "manifest-icon",
    "preload.png": "preload",
    "prefetch.png": "prefetch",
    "module.js": "module",
    "module-ran.gif": "module-ran",
    "og-image.png": "og-image",
    "twitter-image.png": "twitter-image",
    "iframe": "iframe",
    "iframe-img.png": "iframe-img",
    "import.css": "css-import",
    "csp-report": "csp-report",
    "report": "report",
  };
  const kind = map[asset];
  if (!kind) {
    return new Response("Not found", { status: 404 });
  }

  // For /timing we read the POST body (resource timing) before logging.
  let timing: ResourceTiming[] | undefined;
  if (asset === "timing" && req.method === "POST") {
    try {
      const text = await req.text();
      if (text) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.entries)) timing = parsed.entries;
      }
    } catch (_e) {
      // ignore malformed payloads
    }
  }

  // CSP / Reporting-API endpoints: capture the posted report body so it shows
  // up in the trace (stored in the hit headers under a synthetic key).
  if ((asset === "csp-report" || asset === "report") && req.method === "POST") {
    try {
      const text = await req.text();
      if (text) headers["x-report-body"] = text.slice(0, 4000);
    } catch (_e) { /* ignore */ }
  }

  await logHit({ id, kind, ts, ua, ip, method: req.method, headers, timing });

  switch (asset) {
    case "style.css":
      return new Response(cssBody(id, storedSecret), {
        headers: noStore({ "content-type": "text/css; charset=utf-8" }),
      });
    case "main.js":
      return new Response(jsBody(id, storedSecret), {
        headers: noStore({
          "content-type": "text/javascript; charset=utf-8",
        }),
      });
    case "photo.png":
      return new Response(makePng(8, 8, 130, 156, 192), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "css-bg.png":
      return new Response(makePng(8, 8, 225, 29, 72), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "js-ran.gif":
    case "module-ran.gif":
      return new Response(GIF_1x1, {
        headers: noStore({ "content-type": "image/gif" }),
      });
    case "font.woff2":
    case "css-font.woff2":
      return new Response(WOFF2_FONT, {
        headers: noStore({ "content-type": "font/woff2" }),
      });
    case "favicon.ico":
      // A real (tiny) ICO so the response is a valid favicon, not just a 200.
      return new Response(ICO_FAVICON, {
        headers: noStore({ "content-type": "image/x-icon" }),
      });
    case "apple-touch-icon.png":
      return new Response(makePng(16, 16, 99, 102, 241), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "preload.png":
      return new Response(makePng(8, 8, 16, 185, 129), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "prefetch.png":
      return new Response(makePng(8, 8, 245, 158, 11), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "manifest-icon.png":
      return new Response(makePng(16, 16, 168, 85, 247), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "og-image.png":
      // Larger PNG so social unfurlers (which validate dimensions) accept it.
      return new Response(makePng(64, 64, 26, 86, 176), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "twitter-image.png":
      return new Response(makePng(64, 64, 29, 161, 242), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "manifest.json":
      // References its own icon (manifest-icon.png) — fetching THAT proves the
      // UA parsed the manifest and followed a resource linked from inside it.
      return new Response(manifestBody(id, storedSecret), {
        headers: noStore({ "content-type": "application/manifest+json" }),
      });
    case "module.js":
      // ES module that imports module-import logic and beacons module-ran.gif.
      return new Response(moduleBody(id, storedSecret), {
        headers: noStore({ "content-type": "text/javascript; charset=utf-8" }),
      });
    case "timing":
      return new Response(JSON.stringify({ ok: true, recorded: timing?.length ?? 0 }), {
        headers: noStore({ "content-type": "application/json" }),
      });
    case "iframe":
      // A nested HTML document referencing its OWN image, so fetching
      // iframe-img.png proves the UA descended into the frame, not just fetched it.
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ua-tracer iframe probe</title></head><body style="font:14px sans-serif;margin:1em"><p>ua-tracer iframe probe for trace <code>${
          escapeHtml(id)
        }</code>. Fetching the image below proves your UA descended into the iframe.</p><img src="${
          assetBase(id, storedSecret)
        }/iframe-img.png" width="16" height="16" alt="image inside the iframe"></body></html>`,
        { headers: noStore({ "content-type": "text/html; charset=utf-8" }) },
      );
    case "iframe-img.png":
      return new Response(makePng(16, 16, 90, 60, 160), {
        headers: noStore({ "content-type": "image/png" }),
      });
    case "import.css":
      return new Response(
        `/* ua-tracer @import target for trace ${id} — fetching this proves the UA followed an @import */\n.ua-tracer-imported{color:rgb(1,2,3)}\n`,
        { headers: noStore({ "content-type": "text/css; charset=utf-8" }) },
      );
    case "csp-report":
    case "report":
      // CSP / Reporting-API endpoints. The posted report body was captured above
      // (x-report-body header) for display in the trace. Just acknowledge.
      return new Response(null, { status: 204, headers: noStore() });
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function handleHomepage(req: Request, ip: string): Promise<Response> {
  const ua = req.headers.get("user-agent") ?? "";
  const headers = headersToObject(req.headers);
  // Derive the public origin for copy-pasteable examples. Honour the proxy's
  // forwarded host/proto (Deno Deploy sets these) and fall back to the URL.
  const reqUrl = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? reqUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? reqUrl.protocol.replace(":", "");
  const origin = `${proto}://${host}`;

  // Anti-spam: if the request carries a valid trace cookie, reuse that trace
  // id instead of minting a new one. This means refreshing the page (or
  // re-visiting within the cookie window) does NOT create a fresh trace, so a
  // human browser cannot pollute the log by hammering F5. Crawlers (curl,
  // ClaudeBot, …) don't send cookies, so they still get a unique trace per
  // hit — preserving the tool's core signal.
  const COOKIE_NAME = "ua-tracer-trace";
  const COOKIE_TTL_SEC = 60 * 60 * 24; // 24h
  let id: string | null = null;
  let secret: string | undefined;
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieMatch = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-zA-Z0-9_-]+)`),
  );
  if (cookieMatch) {
    const candidate = cookieMatch[1];
    const kv = await getKv();
    const existing = await kv.get<TraceRecord>(["trace", candidate]);
    if (existing.value) {
      id = candidate;
      secret = existing.value.secret;
    }
  }

  if (id === null) {
    // Mint a fresh trace.
    id = shortId();
    secret = shortId(); // per-request secret gating /r/{id}/{secret}/...
    const ts = Date.now();
    const rec: TraceRecord = { id, ts, ua, ip, method: req.method, headers, secret };
    const seedStats: TraceStats = {
      id,
      ts,
      ua,
      ip,
      assetCount: 0,
      jsRan: false,
      kinds: [],
    };

    // Persist the trace + recent index in one atomic write. The recent index
    // value is a TraceStats snapshot (not just the id), so the homepage
    // renders the list AND the per-UA counts WITHOUT any per-trace follow-up
    // reads — this is what prevents the KV connection pool from being
    // depleted under crawler load (the previous N+1 list() pattern caused
    // POOL_DEPLETED 503s). The same snapshot is also written to the per-UA
    // index so substring/exact-UA searches cover the whole corpus.
    const kv = await getKv();
    await kv.atomic()
      .set(["trace", id], rec)
      .set(recentIndexKey(ts, id), seedStats)
      .set(uaIndexKey(ua, ts, id), seedStats)
      .commit();
    // Bump the per-UA aggregate (count of homepage traces by this UA). Done
    // with its own CAS because it is a separate key that many traces share.
    const aKey = uaAggKey(ua);
    for (let attempt = 0; attempt < 8; attempt++) {
      const aggCur = await kv.get<UaAggregate>(aKey);
      const agg = aggCur.value ??
        { ua: ua || "(no user-agent)", count: 0, jsRan: 0 };
      const res = await kv.atomic()
        .check({ key: aKey, versionstamp: aggCur.versionstamp })
        .set(aKey, { ua: agg.ua, count: agg.count + 1, jsRan: agg.jsRan })
        .commit();
      if (res.ok) break;
      await new Promise((r) => setTimeout(r, 5 + attempt * 5));
    }
    // Also log the homepage itself as a hit so the trace waterfall has a root.
    await logHit({ id, kind: "homepage", ts, ua, ip, method: req.method, headers });

    console.log(`[homepage] trace=${id} ip=${ip} ua="${ua.slice(0, 80)}"`);
  } else {
    // Reusing an existing trace — do NOT log a new homepage hit (the original
    // hit is already the root of the waterfall).
    console.log(`[homepage] reuse trace=${id} ip=${ip} ua="${ua.slice(0, 80)}"`);
  }

  // Optional UA filter (case-insensitive substring) from ?ua=…
  const uaFilter = reqUrl.searchParams.get("ua")?.trim() ?? "";

  // Recent activity (newest first) for the unfiltered "Recent homepage requests"
  // list. This stays a bounded recency scan — it is NOT a search, just "what
  // just happened". When a filter is active we instead search the whole corpus.
  const recent = await recentTraces(200);

  // Full-corpus per-UA leaderboard (previously derived from only the recent 200,
  // which under-counted UAs and hid long-tail crawlers entirely).
  const { entries: uaEntriesAll, total: totalTracesAll } = await uaAggregate();
  const uaGroups = new Map<string, { count: number; jsRan: number }>(uaEntriesAll);

  // Search the entire corpus when a filter is present; otherwise show recent.
  const filtered: TraceStats[] = uaFilter ? (await searchTracesByUa(uaFilter)).traces : recent;

  // Reporting probes: the page carries an inline <style>, which VIOLATES the
  // report-only policy style-src 'self' (report-only never blocks, so the page
  // still renders). A UA that honours CSP/Reporting will POST a violation report
  // to the trace-scoped endpoint, which we log. report-uri is the legacy form;
  // report-to + Reporting-Endpoints + Report-To are the modern Reporting API.
  // report-only policy: it never blocks, but the page violates it (inline
  // <style> + inline style="" attributes) so any UA honouring CSP reporting
  // generates a violation. We deliver reports three ways for maximum coverage:
  //   1. report-uri  (legacy; still the most widely delivered)
  //   2. report-to + Reporting-Endpoints/Report-To (modern Reporting API)
  //   3. in-page securitypolicyviolation listener that beacons immediately
  //      (header delivery is batched/lazy and routinely missed by crawlers).
  const ab = assetBase(id, secret);
  const reportHeaders: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "reporting-endpoints": `ua-tracer="${ab}/report"`,
    "report-to": `{"group":"ua-tracer","max_age":86400,"endpoints":[{"url":"${ab}/report"}]}`,
    "content-security-policy-report-only":
      `style-src 'self'; report-uri ${ab}/csp-report; report-to ua-tracer`,
    // (Re)issue the trace cookie so refreshing reuses this id. SameSite=Lax
    // keeps it out of cross-site contexts; Secure is added at runtime when
    // the request arrived over HTTPS (see below).
    "set-cookie": `${COOKIE_NAME}=${id}; Path=/; Max-Age=${COOKIE_TTL_SEC}; SameSite=Lax${
      proto === "https" ? "; Secure" : ""
    }`,
  };
  return new Response(
    homepageHtml({
      id,
      origin,
      secret,
      traces: filtered.slice(0, 100),
      uaGroups,
      uaFilter,
      totalTraces: totalTracesAll,
    }),
    { headers: noStore(reportHeaders) },
  );
}

// /traces — a read-only list of recent homepage requests. Unlike "/", it does
// NOT mint a new trace or reference any probe assets, so you can browse the log
// without adding noise. Quick-access bookmark for "show me everything recent".
function tracesUrl(uaFilter: string, uap: number, p: number): string {
  const params = new URLSearchParams();
  if (uaFilter) params.set("ua", uaFilter);
  if (uap) params.set("uap", String(uap));
  if (p) params.set("p", String(p));
  const qs = params.toString();
  return qs ? `/traces?${qs}` : "/traces";
}

interface TracesOpts {
  traces: TraceStats[]; // full filtered list
  allTraces: TraceStats[]; // unfiltered, for probe→trace correlation
  uaEntries: [string, { count: number; jsRan: number }][]; // full sorted
  uaFilter: string;
  pathFilter: string;
  totalTraces: number;
  uaPage: number;
  reqPage: number;
  probes: ProbeRecord[];
  pathEntries: readonly (readonly [string, { count: number; uas: number }])[];
}

function tracesPageHtml(opts: TracesOpts): string {
  const {
    traces,
    allTraces,
    uaEntries,
    uaFilter,
    pathFilter,
    totalTraces,
    uaPage,
    reqPage,
    probes,
    pathEntries,
  } = opts;
  // Preserve the ua filter when linking by path, and vice versa.
  const probeFilterUrl = (ua: string, path: string) => {
    const params = new URLSearchParams();
    if (ua) params.set("ua", ua);
    if (path) params.set("path", path);
    const qs = params.toString();
    return (qs ? `/traces?${qs}` : "/traces") + "#unsolicited";
  };

  // Recent requests, paged.
  const reqSlice = traces.slice(reqPage * REQ_PAGE_SIZE, (reqPage + 1) * REQ_PAGE_SIZE);
  const rows = traceRows(reqSlice);
  const table = traces.length
    ? `<div class="scrollx"><table>
${REQ_TABLE_HEAD}
<tbody>${rows}</tbody>
</table></div>
${pager(reqPage, traces.length, REQ_PAGE_SIZE, (p) => tracesUrl(uaFilter, uaPage, p))}`
    : `<p class="empty">${
      uaFilter
        ? `No homepage requests match <code>${escapeHtml(uaFilter)}</code>.`
        : "No traces recorded yet."
    }</p>`;

  // By user agent, paged.
  const uaSlice = uaEntries.slice(uaPage * UA_PAGE_SIZE, (uaPage + 1) * UA_PAGE_SIZE);
  const uaRows = uaSlice.map(([ua, g]) => {
    const short = ua.length > 70 ? ua.slice(0, 70) + "…" : ua;
    return `<tr>
  <td><a href="/traces?ua=${encodeURIComponent(ua)}" class="ua" title="${escapeHtml(ua)}">${
      escapeHtml(short)
    }</a></td>
  <td class="mono">${g.count}</td>
  <td class="mono">${g.jsRan}</td>
</tr>`;
  }).join("\n");
  const uaSummary = uaEntries.length
    ? `<div class="scrollx"><table>
<thead><tr><th>User Agent</th><th>Requests</th><th>JS ran</th></tr></thead>
<tbody>${uaRows}</tbody>
</table></div>
${pager(uaPage, uaEntries.length, UA_PAGE_SIZE, (p) => tracesUrl(uaFilter, p, reqPage))}`
    : `<p class="empty">No user agents seen yet.</p>`;

  const filterBar = `
<form method="get" action="/traces" class="filter-bar">
  <input type="search" name="ua" value="${
    escapeHtml(uaFilter)
  }" placeholder="filter by user-agent substring, e.g. ClaudeBot" aria-label="Filter by user agent">
  <button type="submit">Filter</button>
  ${uaFilter ? `<a href="/traces" class="clear-filter">clear</a>` : ""}
</form>`;

  const probeRows = probes.slice(0, 200).map((pr) => {
    const ua = pr.ua || "(no user-agent)";
    const rel = correlateProbe(pr, allTraces);
    const relCell = rel
      ? `<a href="/trace/${escapeHtml(rel.trace.id)}" title="Same UA+IP loaded / ${
        rel.deltaMs === 0
          ? "at the same moment"
          : `${fmtDelta(rel.deltaMs)} ${rel.trace.ts >= pr.ts ? "after" : "before"} this probe`
      }"><code>${escapeHtml(rel.trace.id)}</code> <span class="muted">(${
        rel.trace.ts >= pr.ts ? "+" : "−"
      }${fmtDelta(rel.deltaMs)})</span></a>`
      : `<span class="muted">—</span>`;
    return `<tr>
  <td class="mono">${fmtTs(pr.ts)}</td>
  <td class="mono"><a href="${probeFilterUrl(uaFilter, pr.path)}" title="Filter to this path">${
      escapeHtml(pr.path)
    }</a></td>
  <td><a class="ua" href="${
      probeFilterUrl(ua, pathFilter)
    }" title="Reverse lookup: all requests from ${escapeHtml(ua)}">${
      escapeHtml(pr.ua || "—")
    }</a></td>
  <td class="mono">${relCell}</td>
</tr>`;
  }).join("\n");
  const probesSection = probes.length
    ? `<div class="scrollx"><table>
<thead><tr><th>Timestamp</th><th>Path</th><th>User Agent (click for reverse lookup)</th><th>Related trace</th></tr></thead>
<tbody>${probeRows}</tbody>
</table></div>`
    : `<p class="empty">No unsolicited probe requests${
      uaFilter || pathFilter ? " match the current filter" : " recorded yet"
    }.</p>`;

  // By path: which well-known/unsolicited paths got hit, and by how many UAs.
  const pathRows = pathEntries.slice(0, 60).map(([p, g]) =>
    `<tr>
  <td class="mono"><a href="${probeFilterUrl(uaFilter, p)}" title="Show requests to ${
      escapeHtml(p)
    }">${escapeHtml(p)}</a></td>
  <td class="mono">${g.count}</td>
  <td class="mono">${g.uas}</td>
</tr>`
  ).join("\n");
  const pathSummary = pathEntries.length
    ? `<div class="scrollx"><table>
<thead><tr><th>Path</th><th>Requests</th><th>Distinct UAs</th></tr></thead>
<tbody>${pathRows}</tbody>
</table></div>`
    : `<p class="empty">No unsolicited paths fetched yet.</p>`;

  const body = `
${quickLinks({})}
<section class="explainer">
<p>All recent homepage requests, newest first. This page does <strong>not</strong> mint a new
trace (unlike <a href="/">/</a>), so you can browse the log without adding noise.</p>
</section>

<h2 id="recent-requests">Recent homepage requests</h2>
<p>Filter by user agent and the matching requests appear right below.${
    uaFilter
      ? ` Showing requests whose user agent contains <code>${escapeHtml(uaFilter)}</code>.`
      : ""
  }</p>
${filterBar}
${table}

<h2 id="by-user-agent">By user agent</h2>
<p>Running counts across all ${totalTraces} homepage requests (${uaEntries.length} distinct
agents). Click one to set the filter above.</p>
${uaSummary}

<h2 id="unsolicited">Unsolicited / well-known requests</h2>
<p>Paths a user agent fetched on its own that ua-tracer never links to: robots.txt, sitemap.xml,
<code>/.well-known/*</code>, llms.txt, the root favicon, and similar. Reveals what an agent probes
on its own initiative.</p>
${
    uaFilter || pathFilter
      ? `<p class="active-filter">Filtered${
        pathFilter ? ` to path <code>${escapeHtml(pathFilter)}</code>` : ""
      }${uaFilter ? ` to user agent <code>${escapeHtml(uaFilter)}</code>` : ""}.
  <a href="/traces#unsolicited">clear filters</a></p>`
      : ""
  }

<h3>By path</h3>
<p>Each unsolicited path with its request count and how many distinct user agents hit it.
Click a path to see the individual requests; click a user agent below to reverse-look-up everything
that UA did.</p>
${pathSummary}

<h3>Requests (${probes.length} shown)</h3>
<p>The <strong>Related trace</strong> column links a probe to a homepage trace from the same
user agent and IP within 30 minutes (the same crawler that fetched a well-known file usually also
loaded <code>/</code>). The offset shows how long before/after the probe that trace was minted.</p>
${probesSection}
<p style="margin-top:1.5em"><a href="/">← back to the live tracer (mints a new trace)</a></p>`;
  return pageShell("recent traces · ua-tracer", body, "/traces");
}

async function handleTraces(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const uaFilter = url.searchParams.get("ua")?.trim() ?? "";
  const pathFilter = url.searchParams.get("path")?.trim() ?? "";
  const uaPage = Math.max(0, parseInt(url.searchParams.get("uap") ?? "0", 10) || 0);
  const reqPage = Math.max(0, parseInt(url.searchParams.get("p") ?? "0", 10) || 0);
  // Recent traces feed ONLY the probe→trace correlation (a time-window
  // lookup against recent probes), so a bounded recency scan is correct here.
  const allTraces = await recentTraces(200);
  // Full-corpus search + leaderboard for the actual list and per-UA counts.
  const { entries: uaEntriesAll, total: totalTracesAll } = await uaAggregate();
  const uaEntries = uaFilter
    ? uaEntriesAll.filter(([ua]) => (ua || "").toLowerCase().includes(uaFilter.toLowerCase()))
    : uaEntriesAll;
  const uaGroups = new Map<string, { count: number; jsRan: number }>(uaEntriesAll);
  const filtered = uaFilter ? (await searchTracesByUa(uaFilter)).traces : allTraces;

  const allProbes = await recentProbes(400);
  // Apply the same ua filter (reverse lookup: see a UA's well-known activity)
  // and an optional path filter (reverse lookup: which UAs hit /robots.txt).
  const probes = allProbes.filter((pr) => {
    const uaOk = !uaFilter || (pr.ua || "").toLowerCase().includes(uaFilter.toLowerCase());
    const pathOk = !pathFilter || pr.path.toLowerCase().includes(pathFilter.toLowerCase());
    return uaOk && pathOk;
  });
  // "By path" summary over the (ua-filtered) probe set so each well-known path
  // shows how many requests and distinct UAs hit it.
  const pathGroups = new Map<string, { count: number; uas: Set<string> }>();
  const uaScopedProbes = allProbes.filter((pr) =>
    !uaFilter || (pr.ua || "").toLowerCase().includes(uaFilter.toLowerCase())
  );
  for (const pr of uaScopedProbes) {
    const g = pathGroups.get(pr.path) ?? { count: 0, uas: new Set<string>() };
    g.count++;
    g.uas.add(pr.ua || "(no user-agent)");
    pathGroups.set(pr.path, g);
  }
  const pathEntries = [...pathGroups.entries()]
    .map(([p, g]) => [p, { count: g.count, uas: g.uas.size }] as const)
    .sort((a, b) => b[1].count - a[1].count);

  console.log(
    `[traces] list: ${allTraces.length} traces, ${uaEntries.length} UAs, ${allProbes.length} probes (${probes.length} shown), uaFilter="${uaFilter}" pathFilter="${pathFilter}" uap=${uaPage} p=${reqPage}`,
  );
  return new Response(
    tracesPageHtml({
      traces: filtered,
      allTraces,
      uaEntries,
      uaFilter,
      pathFilter,
      totalTraces: totalTracesAll,
      uaPage,
      reqPage,
      probes,
      pathEntries,
    }),
    { headers: noStore({ "content-type": "text/html; charset=utf-8" }) },
  );
}

const KIND_LABEL: Record<AssetKind, string> = {
  homepage: "homepage",
  css: "CSS",
  js: "JS",
  img: "image",
  font: "font (HTML)",
  "css-bg": "CSS background-image",
  "css-font": "CSS @font-face",
  "js-ran": "JS executed beacon",
  timing: "client timing POST",
  favicon: "favicon",
  "apple-icon": "apple-touch-icon",
  manifest: "web app manifest",
  "manifest-icon": "manifest icon",
  preload: "preload (image)",
  prefetch: "prefetch",
  module: "ES module",
  "module-ran": "ES module executed",
  "og-image": "Open Graph image",
  "twitter-image": "Twitter card image",
  iframe: "iframe document",
  "iframe-img": "image inside iframe",
  "css-import": "CSS @import (nested stylesheet)",
  "csp-report": "CSP violation report (POST)",
  report: "Reporting API report (POST)",
};

async function handleTrace(id: string): Promise<Response> {
  const kv = await getKv();
  const trace = await kv.get<TraceRecord>(["trace", id]);
  if (!trace.value) {
    return new Response(
      pageShell(
        "trace not found",
        `<h2>Trace not found</h2><p>No trace with id <code>${
          escapeHtml(id)
        }</code>.</p><p><a href="/">← back</a></p>`,
        "/traces",
      ),
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const hits = await listHits(id);
  const t0 = trace.value.ts;

  const kinds = new Set(hits.map((h) => h.kind));
  const followedCssBg = kinds.has("css-bg");
  const followedCssFont = kinds.has("css-font");
  const jsRan = kinds.has("js-ran");
  const moduleRan = kinds.has("module-ran");
  const timingHit = hits.find((h) => h.kind === "timing" && h.timing);

  // Distinguish how a CSP/Reporting report was delivered. Header-based delivery
  // (report-uri / Reporting-Endpoints) needs NO JS but is batched/lazy and
  // rarely flushed by crawlers. Our in-page listeners (securitypolicyviolation
  // / ReportingObserver) beacon immediately and are tagged with a `source`.
  const reportHits = hits.filter((h) => h.kind === "csp-report" || h.kind === "report");
  const reportBodies = reportHits.map((h) => h.headers["x-report-body"] ?? "");
  const reportViaJs = reportBodies.some((b) =>
    b.includes("securitypolicyviolation") || b.includes("ReportingObserver")
  );
  const reportViaHeader = reportHits.some((h) => {
    const b = h.headers["x-report-body"] ?? "";
    const ct = (h.headers["content-type"] ?? "").toLowerCase();
    // A header-delivered report is NOT one of our JS beacons.
    return (ct.includes("csp-report") || ct.includes("reports+json")) &&
      !b.includes("securitypolicyviolation") && !b.includes("ReportingObserver");
  });

  function chk(b: boolean, label: string): string {
    return `<span class="badge ${b ? "yes" : "no"}">${b ? "✓" : "✗"} ${label}</span>`;
  }

  const summary = `
<section class="explainer">
<h3 style="margin-top:0">What this user agent did</h3>
<p style="font-size:0.95em;margin-bottom:0.6em">Directly-referenced assets:</p>
<div class="kinds" style="margin-bottom:0.6em">
  ${chk(kinds.has("css"), "fetched CSS")}
  ${chk(kinds.has("js"), "fetched JS")}
  ${chk(kinds.has("img"), "fetched image")}
  ${chk(kinds.has("font"), "fetched font (HTML)")}
</div>
<p style="font-size:0.95em;margin-bottom:0.6em">Document-level link hints:</p>
<div class="kinds" style="margin-bottom:0.6em">
  ${chk(kinds.has("favicon"), "fetched favicon")}
  ${chk(kinds.has("apple-icon"), "fetched apple-touch-icon")}
  ${chk(kinds.has("manifest"), "fetched web manifest")}
  ${chk(kinds.has("preload"), "fetched preload")}
  ${chk(kinds.has("prefetch"), "fetched prefetch")}
</div>
<p style="font-size:0.95em;margin-bottom:0.6em">Second-level follows (proves it parsed the linking file):</p>
<div class="kinds" style="margin-bottom:0.6em">
  ${chk(followedCssBg, "followed CSS background-image")}
  ${chk(followedCssFont, "followed CSS @font-face")}
  ${chk(kinds.has("manifest-icon"), "followed manifest icon")}
  ${chk(kinds.has("css-import"), "followed CSS @import")}
</div>
<p style="font-size:0.95em;margin-bottom:0.6em">Frames (does it descend into iframes?):</p>
<div class="kinds" style="margin-bottom:0.6em">
  ${chk(kinds.has("iframe"), "fetched iframe document")}
  ${chk(kinds.has("iframe-img"), "descended into iframe (loaded inner image)")}
</div>
<p style="font-size:0.95em;margin-bottom:0.6em">Reporting (a report-only CSP is violated by inline styles; reports can arrive via HTTP headers with no JS, or via in-page beacons):</p>
<div class="kinds" style="margin-bottom:0.6em">
  ${chk(kinds.has("csp-report") || kinds.has("report"), "sent a CSP/Reporting report (any path)")}
  ${chk(reportViaHeader, "delivered via report-uri/Report-To header (no JS)")}
  ${chk(reportViaJs, "delivered via in-page beacon (securitypolicyviolation / ReportingObserver)")}
</div>
<p style="font-size:0.95em;margin-bottom:0.6em">Social embed (Open Graph / Twitter card images):</p>
<div class="kinds" style="margin-bottom:0.6em">
  ${chk(kinds.has("og-image"), "fetched og:image")}
  ${chk(kinds.has("twitter-image"), "fetched twitter:image")}
</div>
<p style="font-size:0.95em;margin-bottom:0.6em">JavaScript execution:</p>
<div class="kinds">
  ${chk(jsRan, "EXECUTED classic JS")}
  ${chk(moduleRan, "EXECUTED ES module")}
  ${chk(!!timingHit, "posted client timing")}
</div>
</section>`;

  const rows = hits.map((h, i) => {
    const delta = h.ts - t0;
    // The request row, then a full-width row beneath it holding the headers
    // expando so it spans the whole table instead of being squashed into the
    // last (narrow) column.
    return `<tr>
  <td class="mono">${fmtTs(h.ts)}</td>
  <td class="delta mono">+${delta} ms</td>
  <td><span class="badge kind">${KIND_LABEL[h.kind]}</span></td>
  <td class="mono">${escapeHtml(h.method)}</td>
  <td><span class="ua" title="${escapeHtml(h.ua)}">${escapeHtml(h.ua || "—")}</span></td>
</tr>
<tr class="headers-row">
  <td colspan="5">
    <details>
      <summary>request headers (${Object.keys(h.headers).length})</summary>
      <pre class="headers">${escapeHtml(JSON.stringify(h.headers, null, 2))}</pre>
    </details>
  </td>
</tr>`;
  }).join("\n");

  // Client-side waterfall if JS ran and posted timing.
  let waterfall = "";
  if (timingHit?.timing && timingHit.timing.length) {
    const entries = timingHit.timing.slice().sort((a, b) => a.startTime - b.startTime);
    const maxEnd = Math.max(...entries.map((e) => e.startTime + e.duration), 1);
    const scale = 600 / maxEnd; // px
    const bars = entries.map((e) => {
      const left = Math.round(e.startTime * scale);
      const width = Math.max(2, Math.round(e.duration * scale));
      const name = e.name.split("/").slice(-1)[0] || e.name;
      return `<tr class="waterfall">
  <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${
        escapeHtml(e.name)
      }">${escapeHtml(name)}</td>
  <td class="mono">${e.initiatorType ?? ""}</td>
  <td class="mono">${e.startTime.toFixed(0)}ms</td>
  <td class="mono">${e.duration.toFixed(0)}ms</td>
  <td style="width:620px"><span class="bar" style="margin-left:${left}px;width:${width}px"></span></td>
</tr>`;
    }).join("\n");
    waterfall = `
<h2>Client-side resource waterfall</h2>
<p>Reported by <code>performance.getEntriesByType('resource')</code> after JS ran in the UA. This proves a real
browser-grade engine, not just a downloader.</p>
<table>
<thead><tr><th>Resource</th><th>Initiator</th><th>Start</th><th>Duration</th><th>Timeline</th></tr></thead>
<tbody>${bars}</tbody>
</table>`;
  } else if (jsRan) {
    waterfall =
      `<h2>Client-side resource waterfall</h2><p class="empty">JS executed (beacon hit) but no resource-timing payload was posted (UA may block sendBeacon/fetch or strip the body).</p>`;
  }

  const body = `
<p><a href="/">← all traces</a></p>
<h2>Trace <code>${escapeHtml(id)}</code></h2>
<p><strong>First seen:</strong> ${fmtTs(t0)}<br>
<strong>User-Agent:</strong> <span class="mono">${escapeHtml(trace.value.ua || "—")}</span></p>
${summary}
<h2>Server-side request waterfall</h2>
<p>Every request the server received for this trace, in receive order. <code>+ms</code> is the delta from the
homepage request.</p>
<table>
<thead><tr><th>Received</th><th>Δ</th><th>Kind</th><th>Method</th><th>User-Agent</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${waterfall}
`;
  return new Response(pageShell(`trace ${id}`, body, `/trace/${encodeURIComponent(id)}`), {
    headers: noStore({ "content-type": "text/html; charset=utf-8" }),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// Unsolicited probe paths a UA may fetch without us ever linking them. Returns
// a sensible response if `path` is recognised, else null.
function wellKnownResponse(path: string, origin: string): Response | null {
  const p = path.toLowerCase();
  const txt = (body: string) =>
    new Response(body, {
      headers: noStore({ "content-type": "text/plain; charset=utf-8" }),
    });
  if (p === "/robots.txt") {
    return txt(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  }
  // NOTE: /sitemap.xml is handled in the router (it is async — it reads recent
  // traces to build a real sitemap), not here.
  if (p === "/llms.txt" || p === "/llms-full.txt") {
    return txt(
      `# ua-tracer\n\nSee what a user agent fetches, follows, and executes.\n\n- ${origin}/\n`,
    );
  }
  if (
    p.startsWith("/.well-known/") || p === "/ai.txt" || p === "/humans.txt" ||
    p === "/security.txt" || p === "/apple-app-site-association"
  ) {
    return txt("ua-tracer: this path is tracked but not otherwise served.\n");
  }
  return null;
}

// A real sitemap: the home and traces pages, interesting filter views, and the
// most recent trace-detail pages. Built dynamically from KV so it stays current.
async function buildSitemap(origin: string): Promise<string> {
  const recent = await recentTraces(200);
  const now = new Date().toISOString();
  const urls: { loc: string; priority: string; lastmod?: string }[] = [];

  // Core pages. (No #fragment URLs — sitemaps ignore fragments.)
  urls.push({ loc: `${origin}/`, priority: "1.0", lastmod: now });
  urls.push({ loc: `${origin}/traces`, priority: "0.9", lastmod: now });

  // Interesting filter views: well-known paths and notable crawlers.
  const wellKnownPaths = [
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
    "/.well-known/",
    "/security.txt",
    "/ai-plugin.json",
    "/ai.txt",
    "/humans.txt",
    "/favicon.ico",
  ];
  for (const wk of wellKnownPaths) {
    urls.push({
      loc: `${origin}/traces?path=${encodeURIComponent(wk)}`,
      priority: "0.5",
    });
  }
  // Notable crawler filters (from observed UAs plus a known list).
  const knownBots = [
    "Googlebot",
    "GPTBot",
    "ClaudeBot",
    "Claude-Web",
    "PerplexityBot",
    "Bingbot",
    "Bytespider",
    "Amazonbot",
    "CCBot",
    "Applebot",
    "facebookexternalhit",
  ];
  const seenBots = new Set<string>(knownBots);
  for (const t of recent) {
    const ua = t.ua || "";
    // Pull a coarse bot token out of observed UAs so the sitemap reflects
    // whatever has actually been hitting the site.
    const m = ua.match(/([A-Za-z][A-Za-z0-9-]*[Bb]ot)/);
    if (m) seenBots.add(m[1]);
  }
  for (const bot of seenBots) {
    urls.push({
      loc: `${origin}/traces?ua=${encodeURIComponent(bot)}`,
      priority: "0.4",
    });
  }

  // The most recent trace-detail pages (cap to keep the sitemap lean).
  for (const t of recent.slice(0, 50)) {
    urls.push({
      loc: `${origin}/trace/${encodeURIComponent(t.id)}`,
      priority: "0.3",
      lastmod: new Date(t.ts).toISOString(),
    });
  }

  const body = urls.map((u) =>
    `  <url><loc>${escapeHtml(u.loc)}</loc>${
      u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""
    }<priority>${u.priority}</priority></url>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

async function handler(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = clientIp(req, info);
  console.log(
    `[req] ${req.method} ${path} ip=${ip} ua="${
      (req.headers.get("user-agent") ?? "").slice(0, 80)
    }"`,
  );

  // Health check. Exempt from the canonical redirect so uptime monitors can
  // hit the deploy URL directly without chasing a 301.
  if (path === "/api/health") {
    return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
      headers: { "content-type": "application/json" },
    });
  }

  // Canonical-domain redirect: anything arriving on the *.deno.net deploy host
  // is 301'd to the custom domain so search engines never index the deploy URL.
  if (url.hostname.endsWith(".deno.net") || url.hostname.endsWith(".deno.dev")) {
    return new Response(null, {
      status: 301,
      headers: { location: `${CANONICAL_ORIGIN}${path}${url.search}` },
    });
  }

  if (path === "/favicon.ico") {
    // Untraced root favicon (the per-trace probe lives at /r/{id}/favicon.ico).
    // Logged as an unsolicited probe: which UAs fetch the site favicon at all.
    await logProbe(path, req, ip);
    return new Response(ICO_FAVICON, {
      headers: { "content-type": "image/x-icon", "cache-control": "max-age=86400" },
    });
  }

  // Asset probes: /r/{id}/{secret}/{asset} (new) or /r/{id}/{asset} (legacy)
  const assetMatchSecret = path.match(/^\/r\/([^/]+)\/([^/]+)\/(.+)$/);
  if (assetMatchSecret) {
    const [, id, secret, asset] = assetMatchSecret;
    return await handleAsset(req, id, asset, ip, secret);
  }
  const assetMatch = path.match(/^\/r\/([^/]+)\/(.+)$/);
  if (assetMatch) {
    const [, id, asset] = assetMatch;
    return await handleAsset(req, id, asset, ip);
  }

  // Trace detail: /trace/{id}
  const traceMatch = path.match(/^\/trace\/([^/]+)$/);
  if (traceMatch) {
    return await handleTrace(traceMatch[1]);
  }

  // Read-only recent-traces list (does NOT mint a new trace).
  if ((path === "/traces" || path === "/traces/") && req.method === "GET") {
    return await handleTraces(req);
  }

  // Homepage.
  if (path === "/" && req.method === "GET") {
    return await handleHomepage(req, ip);
  }

  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const origin = `${proto}://${host}`;

  // Real, dynamic sitemap (home, /traces, interesting filters, recent traces).
  // Also logged as a probe so we can see which UAs request the sitemap.
  if (path === "/sitemap.xml" || path === "/sitemap_index.xml") {
    await logProbe(path, req, ip);
    return new Response(await buildSitemap(origin), {
      headers: noStore({ "content-type": "application/xml; charset=utf-8" }),
    });
  }

  // Unsolicited probe paths (robots, /.well-known/*, llms.txt, …): a UA may
  // fetch these on its own initiative. Log + serve a sensible response.
  const probeResp = wellKnownResponse(path, origin);
  if (probeResp) {
    await logProbe(path, req, ip);
    return probeResp;
  }

  return new Response("Not found", { status: 404 });
}

// Only start the server when this file is the entrypoint — importing it (e.g.
// from the backfill script) must NOT call Deno.serve().
if (import.meta.main) {
  console.log("ua-tracer starting…");
  Deno.serve(handler);
}
