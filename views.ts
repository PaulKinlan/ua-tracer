// Pure HTML rendering; storage and network access belong to the entrypoint.
import type { BotVerification } from "./bot-verification.ts";
import type { AssetKind, HitRecord, ProbeRecord, TraceRecord, TraceStats } from "./storage.ts";
import { assetBase } from "./probes.ts";

export function randomBotName(): string {
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

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");
}

// Human-friendly elapsed duration, e.g. "830ms", "4.2s", "3m", "1h 5m".
export function fmtDelta(ms: number): string {
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
export function uaHeadline(ua: string): string {
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

// Correlate an unsolicited probe to a homepage trace. The same crawler that
// fetches /robots.txt usually also loads / (minting a trace) from the same IP
// with the same UA, often within a short window. We match on UA+IP and pick the
// trace closest in time. Returns the trace and how far apart they were (ms),
// or null when no plausible same-agent trace exists.
const CORRELATE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Canonical custom domain. The app is also reachable on its *.deno.net deploy
// URL, but that host should never be indexed: every page carries a canonical
// link to this origin, and requests arriving on a *.deno.net host are 301'd here.
export const CANONICAL_HOST = "uatracer.com";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;
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
/* Visually hidden but available to screen readers and crawlers. Used for the
   per-page <h1> so each page has a unique, descriptive primary heading without
   duplicating the visible wordmark. */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
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
/* Bot IP-range verification: green = IP confirmed in published range,
   red = UA claims a bot but IP is outside its range (likely spoofed),
   grey = bot publishes no ranges so the UA is unfalsifiable. */
.badge.verified { background: #d8f5d8; color: #14532d; border-color: #9fd9a0; }
.badge.unverified { background: #f5dada; color: #7f1d1d; border-color: #e0a3a3; }
.badge.unverifiable { background: #f0eee6; color: #555; border-color: #ccc8be; }
@media (prefers-color-scheme: dark) {
  .badge.yes { background: #16351a; color: #b6e8bb; border-color: #2f6b35; }
  .badge.no { background: #3a1717; color: #f0b4b4; border-color: #6b2f2f; }
  .badge.kind { background: #16351a; color: #b6e8bb; border-color: #2f6b35; }
  .badge.verified { background: #16351a; color: #b6e8bb; border-color: #2f6b35; }
  .badge.unverified { background: #3a1717; color: #f0b4b4; border-color: #6b2f2f; }
  .badge.unverifiable { background: #2a2723; color: #aaa; border-color: #3a362f; }
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
.filter-toggle {
  display: inline-flex; align-items: center; gap: 0.35em; font-size: 0.92em;
  padding: 0.45em 0.7em; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-secondary); cursor: pointer; user-select: none;
}
.filter-toggle:hover { background: var(--border); }
.filter-toggle input[type="checkbox"] { margin: 0; cursor: pointer; }
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

export function pageShell(title: string, body: string, canonicalPath = "/"): string {
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
  <h1 class="sr-only">${escapeHtml(title)}</h1>
  <p class="site-branding-title"><a href="/">ua-tracer</a></p>
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

// Kinds that are recorded but are NOT "Fetched" sub-resource badges. They are rendered as their own
// markers elsewhere (the request rows, and the EXECUTED JS / ES module / posted timing pills), so
// they do not belong in the badge list. Naming them explicitly is the point (ua-tracer-wot): a kind
// outside this list must have a badge label below or the build fails, and a kind inside it is a
// deliberate decision written down rather than a silent drop.
const NON_BADGE_KINDS = ["homepage", "timing", "js-ran", "module-ran"] as const;
// Exported so the guard in tests/unit_views_test.ts can take its expectations from the code rather
// than repeating a fourth list of kinds.
export { NON_BADGE_KINDS };
type BadgeKind = Exclude<AssetKind, typeof NON_BADGE_KINDS[number]>;

// Short labels for the per-trace "Fetched" sub-resource badges. Record<BadgeKind, string> is
// exhaustive on purpose: a kind added to AssetKind and not listed here - and not named in
// NON_BADGE_KINDS - fails typecheck instead of quietly disappearing from the UI.
const SHORT_KIND: Record<BadgeKind, string> = {
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

// The badge render order IS the label map's declaration order, derived rather than repeated. The two
// lists this replaces had to be kept in step by hand, which is how one of them could be missed.
export const KIND_ORDER: readonly BadgeKind[] = Object.keys(SHORT_KIND) as BadgeKind[];
function kindBadges(kinds: AssetKind[]): string {
  const present = KIND_ORDER.filter((k) => kinds.includes(k));
  if (!present.length) return '<span class="muted">—</span>';
  return present.map((k) => `<span class="badge kind">${SHORT_KIND[k] ?? k}</span>`).join("");
}

// Badge for the IP-range verification of a claimed bot. null (non-bot UA) is
// rendered as nothing; the three states map to green/red/grey badges.
function verifiedBadge(v?: BotVerification | null): string {
  if (!v) return "";
  const title = escapeHtml(v.note);
  if (v.status === "verified") {
    return `<span class="badge verified" title="${title}">✓ ${escapeHtml(v.bot)}</span>`;
  }
  if (v.status === "unverified") {
    return `<span class="badge unverified" title="${title}">⚠ fake ${escapeHtml(v.bot)}?</span>`;
  }
  return `<span class="badge unverifiable" title="${title}">? ${
    escapeHtml(v.bot)
  } (no ranges)</span>`;
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
<tr class="pills-row"><td colspan="3"><div class="kinds-cell">${js}${verifiedBadge(t.verified)}${
      kindBadges(t.kinds)
    }</div></td></tr>`;
  }).join("\n");
}

const REQ_TABLE_HEAD =
  "<thead><tr><th scope='col'>Timestamp</th><th scope='col'>User Agent</th><th scope='col'>Assets</th></tr></thead>";

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

export function homepageHtml(opts: HomepageOpts): string {
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
    // Same treatment as "Recent homepage requests": a bold, scannable headline
    // (the distinguishing token like ClaudeBot/1.0, not "Mozilla/5.0
    // (compatible; …") on top, with the full UA wrapped beneath. The old
    // single-line ellipsis buried the important bit mid-string.
    const isNoUa = !ua || ua === "(no user-agent)";
    const fullSafe = escapeHtml(ua);
    const uaCell = isNoUa
      ? `<div class="ua-headline"><span class="muted">(no user-agent)</span></div>`
      : `<div class="ua-headline"><a href="/traces?ua=${
        encodeURIComponent(ua)
      }" class="ua-link" title="${fullSafe}">${
        escapeHtml(uaHeadline(ua))
      }</a></div><div class="ua-full" title="${fullSafe}">${fullSafe}</div>`;
    return `<tr>
  <td class="ua-cell">${uaCell}</td>
  <td class="mono">${g.count}</td>
  <td class="mono">${g.jsRan}</td>
</tr>`;
  }).join("\n");

  const uaSummary = uaGroups.size
    ? `<div class="scrollx"><table>
<thead><tr><th scope="col">User Agent</th><th scope="col">Requests</th><th scope="col">JS ran</th></tr></thead>
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
<p class="current-trace-link" style="text-align:left"><a href="/trace/${
    escapeHtml(id)
  }">See what your user agent just did →</a></p>
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

function tracesUrl(uaFilter: string, jsOnly: boolean, uap: number, p: number): string {
  const params = new URLSearchParams();
  if (uaFilter) params.set("ua", uaFilter);
  if (jsOnly) params.set("js", "1");
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
  jsOnly: boolean;
  totalTraces: number;
  uaPage: number;
  reqPage: number;
  probes: ProbeRecord[];
  pathEntries: readonly (readonly [string, { count: number; uas: number }])[];
}

export function tracesPageHtml(opts: TracesOpts): string {
  const {
    traces,
    allTraces,
    uaEntries,
    uaFilter,
    pathFilter,
    jsOnly,
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
${pager(reqPage, traces.length, REQ_PAGE_SIZE, (p) => tracesUrl(uaFilter, jsOnly, uaPage, p))}`
    : `<p class="empty">${
      uaFilter
        ? `No homepage requests match <code>${escapeHtml(uaFilter)}</code>.`
        : "No traces recorded yet."
    }</p>`;

  // By user agent, paged. Same scannable headline + full-UA-beneath treatment as
  // the homepage leaderboard and "Recent homepage requests" (no mid-string
  // truncation that hid the distinguishing token).
  const uaSlice = uaEntries.slice(uaPage * UA_PAGE_SIZE, (uaPage + 1) * UA_PAGE_SIZE);
  const uaRows = uaSlice.map(([ua, g]) => {
    const isNoUa = !ua || ua === "(no user-agent)";
    const fullSafe = escapeHtml(ua);
    const uaCell = isNoUa
      ? `<div class="ua-headline"><span class="muted">(no user-agent)</span></div>`
      : `<div class="ua-headline"><a href="/traces?ua=${
        encodeURIComponent(ua)
      }" class="ua-link" title="${fullSafe}">${
        escapeHtml(uaHeadline(ua))
      }</a></div><div class="ua-full" title="${fullSafe}">${fullSafe}</div>`;
    return `<tr>
  <td class="ua-cell">${uaCell}</td>
  <td class="mono">${g.count}</td>
  <td class="mono">${g.jsRan}</td>
</tr>`;
  }).join("\n");
  const uaSummary = uaEntries.length
    ? `<div class="scrollx"><table>
<thead><tr><th scope="col">User Agent</th><th scope="col">Requests</th><th scope="col">JS ran</th></tr></thead>
<tbody>${uaRows}</tbody>
</table></div>
${pager(uaPage, uaEntries.length, UA_PAGE_SIZE, (p) => tracesUrl(uaFilter, jsOnly, p, reqPage))}`
    : `<p class="empty">No user agents seen yet.</p>`;

  const filterBar = `
<form method="get" action="/traces" class="filter-bar">
  <input type="search" name="ua" value="${
    escapeHtml(uaFilter)
  }" placeholder="filter by user-agent substring, e.g. ClaudeBot" aria-label="Filter by user agent">
  <label class="filter-toggle" title="Only show traces whose user agent executed JavaScript">
    <input type="checkbox" name="js" value="1" ${jsOnly ? "checked" : ""}>
    JS ran
  </label>
  <button type="submit">Filter</button>
  ${uaFilter || jsOnly ? `<a href="/traces" class="clear-filter">clear</a>` : ""}
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
<thead><tr><th scope="col">Timestamp</th><th scope="col">Path</th><th scope="col">User Agent (click for reverse lookup)</th><th scope="col">Related trace</th></tr></thead>
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
<thead><tr><th scope="col">Path</th><th scope="col">Requests</th><th scope="col">Distinct UAs</th></tr></thead>
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
  }${jsOnly ? " Only showing traces where JavaScript executed." : ""}</p>
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

export function traceDetailHtml(trace: TraceRecord, hits: HitRecord[]): string {
  const id = trace.id;
  const t0 = trace.ts;

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

  const rows = hits.map((h) => {
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
<thead><tr><th scope="col">Resource</th><th scope="col">Initiator</th><th scope="col">Start</th><th scope="col">Duration</th><th scope="col">Timeline</th></tr></thead>
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
<strong>User-Agent:</strong> <span class="mono">${escapeHtml(trace.ua || "—")}</span><br>
<strong>Bot verification:</strong> ${
    trace.verified
      ? `<span class="badge ${trace.verified.status}" title="${escapeHtml(trace.verified.note)}">${
        trace.verified.status === "verified"
          ? "✓ verified " + escapeHtml(trace.verified.bot)
          : trace.verified.status === "unverified"
          ? "⚠ NOT in " + escapeHtml(trace.verified.bot) + " range (spoofed?)"
          : "? " + escapeHtml(trace.verified.bot) + " (no published ranges)"
      }</span> <span class="muted">IP checked against published bot CIDR ranges; ` +
        escapeHtml(trace.verified.note) + `.</span>`
      : `<span class="muted">Not a known bot (no IP-range check applies).</span>`
  }</p>
${summary}
<h2>Server-side request waterfall</h2>
<p>Every request the server received for this trace, in receive order. <code>+ms</code> is the delta from the
homepage request.</p>
<table>
<thead><tr><th scope="col">Received</th><th scope="col">Δ</th><th scope="col">Kind</th><th scope="col">Method</th><th scope="col">User-Agent</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${waterfall}
`;
  return pageShell(`trace ${id}`, body, `/trace/${encodeURIComponent(id)}`);
}
