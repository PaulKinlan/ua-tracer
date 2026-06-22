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
async function getKv(): Promise<Deno.Kv> {
  if (!_kv) _kv = await Deno.openKv();
  return _kv;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TraceRecord {
  id: string;
  ts: number; // ms since epoch (server-receive)
  ua: string;
  ip: string;
  method: string;
  headers: Record<string, string>;
}

// Denormalized per-trace stats, updated as hits arrive. Lets the homepage
// render the list + per-UA counts with O(1) reads per trace instead of an
// expensive list() over every trace's hits (which exhausted the KV pool under
// crawler load — POOL_DEPLETED 503s).
interface TraceStats {
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
  | "twitter-image";

interface HitRecord {
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
function recentIndexKey(ts: number, id: string): [string, string, string] {
  const reverseKey = (Number.MAX_SAFE_INTEGER - ts).toString().padStart(20, "0");
  return ["recent", reverseKey, id];
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
      // Concurrent sub-requests (css-bg, js-ran, font, …) all update the same
      // stats entry, so use an atomic compare-and-set on the versionstamp with
      // a small retry loop. A plain get→set races and loses updates (e.g. the
      // jsRan flag getting clobbered).
      for (let attempt = 0; attempt < 8; attempt++) {
        const cur = await kv.get<TraceStats>(recentKey);
        if (!cur.value) break; // entry not seeded (shouldn't happen)
        const s = cur.value;
        s.assetCount += 1;
        if (rec.kind === "js-ran") s.jsRan = true;
        if (!s.kinds.includes(rec.kind)) s.kinds.push(rec.kind);
        const res = await kv.atomic()
          .check({ key: recentKey, versionstamp: cur.versionstamp })
          .set(recentKey, s)
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
}
@media (prefers-color-scheme: dark) {
  :root {
    --color: #e8e4dc;
    --background: #1c1a17;
    --bg-secondary: #2a2723;
    --border: #3a362f;
    --muted: #aaa;
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
.mono { font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 0.85em; }
.badge { display: inline-block; padding: 0.1em 0.55em; border-radius: 999px; font-size: 0.78em;
  font-family: -apple-system, sans-serif; font-weight: 600; border: 1px solid var(--border); }
.badge.yes { background: #d8f5d8; color: #14532d; border-color: #9fd9a0; }
.badge.no { background: #f5dada; color: #7f1d1d; border-color: #e0a3a3; }
.badge.kind { background: var(--bg-secondary); color: var(--color); }
@media (prefers-color-scheme: dark) {
  .badge.yes { background: #16351a; color: #b6e8bb; border-color: #2f6b35; }
  .badge.no { background: #3a1717; color: #f0b4b4; border-color: #6b2f2f; }
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
`;

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="ua-tracer — see what a user agent downloads, follows, and executes.">
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

interface HomepageOpts {
  id: string;
  origin: string;
  traces: TraceStats[];
  uaGroups: Map<string, { count: number; jsRan: number }>;
  uaFilter: string;
  totalTraces: number;
}

function homepageHtml(opts: HomepageOpts): string {
  const { id, origin, traces, uaGroups, uaFilter, totalTraces } = opts;
  const base = `/r/${id}`;
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
  const rows = traces.map((t) => {
    const ran = t.jsRan;
    const count = t.assetCount;
    return `<tr>
  <td class="mono"><a href="/trace/${escapeHtml(t.id)}">${fmtTs(t.ts)}</a></td>
  <td><span class="ua" title="${escapeHtml(t.ua)}">${escapeHtml(t.ua || "—")}</span></td>
  <td class="mono">${escapeHtml(t.ip)}</td>
  <td class="mono">${count}</td>
  <td>${ran ? '<span class="badge yes">JS ran</span>' : '<span class="badge no">no JS</span>'}</td>
</tr>`;
  }).join("\n");

  const table = traces.length
    ? `<table>
<thead><tr><th>Timestamp</th><th>User Agent</th><th>IP</th><th>Assets</th><th>JS?</th></tr></thead>
<tbody>${rows}</tbody>
</table>`
    : `<p class="empty">${
      uaFilter
        ? `No homepage requests match user-agent filter <code>${escapeHtml(uaFilter)}</code>.`
        : `No traces recorded yet. This very page load just created one (<code>${
          escapeHtml(id)
        }</code>) — reload to see it.`
    }</p>`;

  // Per-UA summary: running counts grouped by exact UA string, newest activity
  // surfaced as a leaderboard. Each row links to the filtered view.
  const uaRows = [...uaGroups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([ua, g]) => {
      const short = ua.length > 70 ? ua.slice(0, 70) + "…" : ua;
      return `<tr>
  <td><a href="/?ua=${encodeURIComponent(ua)}" class="ua" title="${escapeHtml(ua)}">${
        escapeHtml(short)
      }</a></td>
  <td class="mono">${g.count}</td>
  <td class="mono">${g.jsRan}</td>
</tr>`;
    }).join("\n");

  const uaSummary = uaGroups.size
    ? `<table>
<thead><tr><th>User Agent</th><th>Requests</th><th>JS ran</th></tr></thead>
<tbody>${uaRows}</tbody>
</table>`
    : `<p class="empty">No user agents seen yet.</p>`;

  const filterBar = `
<form method="get" action="/" class="filter-bar">
  <input type="search" name="ua" value="${
    escapeHtml(uaFilter)
  }" placeholder="filter by user-agent substring, e.g. ClaudeBot" aria-label="Filter by user agent">
  <button type="submit">Filter</button>
  ${uaFilter ? `<a href="/" class="clear-filter">clear</a>` : ""}
</form>`;

  const body = `
<section class="explainer">
<p>This page just minted a fresh trace id <code>${escapeHtml(id)}</code>. Every asset it references
lives under <code>/r/${
    escapeHtml(id)
  }/…</code>, so each fetch is tied back to <em>this</em> request and
your User-Agent. Layered probes inside the CSS and JS reveal whether your UA parses CSS, follows
resources linked from CSS, and actually executes JavaScript.</p>
<p><strong>Try it:</strong> point a crawler at this URL, or run a fresh trace with curl —
each load is its own trace:</p>
<pre class="headers">curl -A "ClaudeBot/1.0" ${escapeHtml(origin)}/</pre>
<p style="margin-bottom:0">…then open the matching row below. A plain <code>curl</code> only records the homepage
hit (it parses no CSS and runs no JS) — that contrast is the whole point.</p>
</section>

<h2>By user agent</h2>
<p>Running counts across the last ${totalTraces} homepage requests, grouped by user agent.
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
</section>
<script src="${base}/main.js"></script>
<script type="module" src="${base}/module.js"></script>
`;

  // Inject probeHead into the shell head via a marker swap.
  return pageShell("ua-tracer", body).replace(
    "</head>",
    `${probeHead}</head>`,
  );
}

// ---------------------------------------------------------------------------
// Real asset bodies
// ---------------------------------------------------------------------------

function cssBody(id: string): string {
  const base = `/r/${id}`;
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
  return `/* ua-tracer probe stylesheet for trace ${id} */
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

function jsBody(id: string): string {
  const base = `/r/${id}`;
  // On execution: beacon js-ran.gif and POST resource timing to /timing.
  return `// ua-tracer probe script for trace ${id}
(function () {
  try {
    // (a) Prove JS executed: beacon a unique gif.
    new Image().src = ${JSON.stringify(`${base}/js-ran.gif`)} + "?t=" + Date.now();
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

function manifestBody(id: string): string {
  const base = `/r/${id}`;
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

function moduleBody(id: string): string {
  const base = `/r/${id}`;
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
): Promise<Response> {
  const ua = req.headers.get("user-agent") ?? "";
  const ts = Date.now();
  const headers = headersToObject(req.headers);

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

  await logHit({ id, kind, ts, ua, ip, method: req.method, headers, timing });

  switch (asset) {
    case "style.css":
      return new Response(cssBody(id), {
        headers: noStore({ "content-type": "text/css; charset=utf-8" }),
      });
    case "main.js":
      return new Response(jsBody(id), {
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
      return new Response(manifestBody(id), {
        headers: noStore({ "content-type": "application/manifest+json" }),
      });
    case "module.js":
      // ES module that imports module-import logic and beacons module-ran.gif.
      return new Response(moduleBody(id), {
        headers: noStore({ "content-type": "text/javascript; charset=utf-8" }),
      });
    case "timing":
      return new Response(JSON.stringify({ ok: true, recorded: timing?.length ?? 0 }), {
        headers: noStore({ "content-type": "application/json" }),
      });
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function handleHomepage(req: Request, ip: string): Promise<Response> {
  const id = shortId();
  const ts = Date.now();
  const ua = req.headers.get("user-agent") ?? "";
  const headers = headersToObject(req.headers);
  // Derive the public origin for copy-pasteable examples. Honour the proxy's
  // forwarded host/proto (Deno Deploy sets these) and fall back to the URL.
  const reqUrl = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? reqUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? reqUrl.protocol.replace(":", "");
  const origin = `${proto}://${host}`;
  const rec: TraceRecord = { id, ts, ua, ip, method: req.method, headers };
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
  // value is a TraceStats snapshot (not just the id), so the homepage renders
  // the list AND the per-UA counts WITHOUT any per-trace follow-up reads —
  // this is what prevents the KV connection pool from being depleted under
  // crawler load (the previous N+1 list() pattern caused POOL_DEPLETED 503s).
  const kv = await getKv();
  await kv.atomic()
    .set(["trace", id], rec)
    .set(recentIndexKey(ts, id), seedStats)
    .commit();
  // Also log the homepage itself as a hit so the trace waterfall has a root.
  await logHit({ id, kind: "homepage", ts, ua, ip, method: req.method, headers });

  console.log(`[homepage] trace=${id} ip=${ip} ua="${ua.slice(0, 80)}"`);

  // Optional UA filter (case-insensitive substring) from ?ua=…
  const uaFilter = reqUrl.searchParams.get("ua")?.trim() ?? "";

  // Single cheap read: recent stats straight from the index (no N+1).
  const allTraces = await recentTraces(200);

  // Per-UA running counts (grouped by exact UA string).
  const uaGroups = new Map<string, { count: number; jsRan: number }>();
  for (const t of allTraces) {
    const key = t.ua || "(no user-agent)";
    const g = uaGroups.get(key) ?? { count: 0, jsRan: 0 };
    g.count++;
    if (t.jsRan) g.jsRan++;
    uaGroups.set(key, g);
  }

  const filtered = uaFilter
    ? allTraces.filter((t) => (t.ua || "").toLowerCase().includes(uaFilter.toLowerCase()))
    : allTraces;

  return new Response(
    homepageHtml({
      id,
      origin,
      traces: filtered.slice(0, 100),
      uaGroups,
      uaFilter,
      totalTraces: allTraces.length,
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
<strong>User-Agent:</strong> <span class="mono">${escapeHtml(trace.value.ua || "—")}</span><br>
<strong>IP:</strong> <span class="mono">${escapeHtml(trace.value.ip)}</span></p>
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
  return new Response(pageShell(`trace ${id}`, body), {
    headers: noStore({ "content-type": "text/html; charset=utf-8" }),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handler(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = clientIp(req, info);
  console.log(
    `[req] ${req.method} ${path} ip=${ip} ua="${
      (req.headers.get("user-agent") ?? "").slice(0, 80)
    }"`,
  );

  // Health check.
  if (path === "/api/health") {
    return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (path === "/favicon.ico") {
    // Untraced root favicon (the per-trace probe lives at /r/{id}/favicon.ico).
    return new Response(ICO_FAVICON, {
      headers: { "content-type": "image/x-icon", "cache-control": "max-age=86400" },
    });
  }

  // Asset probes: /r/{id}/{asset}
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

  // Homepage.
  if (path === "/" && req.method === "GET") {
    return await handleHomepage(req, ip);
  }

  return new Response("Not found", { status: 404 });
}

console.log("ua-tracer starting…");
Deno.serve(handler);
