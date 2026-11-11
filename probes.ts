import type { AssetKind } from "./storage.ts";

// Probe URL contract, generated resource bodies and tiny binary response assets.

// Build the probe-asset base path. New traces carry a per-request secret so
// only the agent that received the one-time HTML can hit /r/{id}/{secret}/...;
// old traces (no secret) keep the legacy /r/{id}/... form.
export function assetBase(id: string, secret?: string): string {
  return secret ? `/r/${id}/${secret}` : `/r/${id}`;
}

// Invariant I6 (tm-probe-body-reflects-path, ua-tracer-82v): generated CSS
// reflects path segments, so a segment must not be able to break out of a
// url("...") string or close a /* */ comment early. CSS has no escape syntax
// inside comments, so the safe transform replaces every byte outside the
// router's segment alphabet with a CSS hex escape: inside a string the escape
// resolves to the original character, and inside a comment it is inert text
// that can never form `*/` (the replacement emits only `\`, hex digits and
// spaces — never `*`, `/` or a quote). The router gate in server.ts already
// admits only [0-9a-zA-Z_-]{1,64} segments, so for current callers this is a
// no-op belt-and-braces layer that keeps I6 true even if a caller skips it.
export function cssSafeSegment(segment: string): string {
  return segment.replace(
    /[^0-9a-zA-Z_-]/g,
    (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")} `,
  );
}

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 1x1 transparent GIF.
export const GIF_1x1 = decodeBase64(
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
export function makePng(
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

// A real, decodable minimal WOFF2 font: two glyphs (.notdef and one solid
// rectangle), a valid glyf table (66 bytes) and a cmap that maps ONLY the
// private-use codepoint U+E000 to the rectangle. Built with fontTools
// FontBuilder and compressed with fontTools' WOFF2 encoder; verified to LOAD in
// Chrome (document.fonts status "loaded", FontFace.check true).
//
// Two properties are load-bearing and were both wrong before (ua-tracer-hik):
//  - the glyf table must be non-empty. A font whose every glyph is empty
//    reconstructs to a zero-length glyf table, which every OTS-based engine
//    (Chrome, Firefox) rejects with "glyf: zero-length table" - the previous
//    body was exactly that, so the @font-face never loaded even though the
//    fetch was recorded.
//  - it must NOT cover ASCII. The probe paragraph is set in this face with a
//    Georgia fallback; a face that covered Latin would draw its own rectangle
//    shapes over the text. With no ASCII coverage the engine falls back per
//    character (measured: identical rendered width with and without the face in
//    the stack), while the U+E000 mapping keeps the face genuinely usable and
//    the cmap non-empty (a face that maps nothing can be treated as unusable).
// tests/unit_probes_test.ts parses this body and fails if the glyf length drops
// back to zero or the container stops being self-consistent.
export const WOFF2_FONT = decodeBase64(
  "d09GMgABAAAAAAFQAAoAAAAAAvwAAAEIAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANApESgE2AiQDBgsGAAQgBYE9BywbRgIAHgd2M9eFxTBJM3xRiIevaXt/d3NH7Yo+PpZSmnAIj1UIG4VCImQcjA86dja0LnWhnt9ldvM9gPMFadqZ9ggE9GIUxxxF+lDWP5AhbD7bsJtPfLoLMmSJyEuO+6scXaxSKJkBHh3RauX1Xq75BvC6mpCxYINysY4SB62+x5frIQAkUJAxgWlAAUmUUsaryfI+WU3gpG5u3vZWzlfwPRAIfha6sab3/0fIf/C7NvGJRzXxlRpkCYR3ueg2QH1DAABieiGQjEiQmdSBRw54ch2SyqQAA/PmZFFGhTU7NU3GHCUDu24+cN/I12qaZXnXpizZB0fgIVkyGlXVvLdN7gghSESq7gMA",
);

// A real 16x16 ICO favicon (valid image/x-icon), built offline with Pillow.
export const ICO_FAVICON = decodeBase64(
  "AAABAAEAEBAAAAAAIABWAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAB1JREFUeJxjTE77+J+BAsBEieZRA0YNGDVgMBkAAE1HAtnWJSmuAAAAAElFTkSuQmCC",
);

// ---------------------------------------------------------------------------
// Bot IP-range verification
// ---------------------------------------------------------------------------
//
// A User-Agent string is trivially spoofable, so "is this really Googlebot?"
// can only be answered by checking the source IP against the ranges the bot
// operator publishes. Some operators (Google, OpenAI, Bing) publish CIDR
// ranges; we fetch and cache them and match the client IP. Others (Anthropic's
// ClaudeBot, ChatGPT-User) publish NO ranges, so their UA is *unfalsifiable* —
// we tag it "unverifiable" rather than pretend we know.

export function cssBody(id: string, secret?: string): string {
  const base = assetBase(
    cssSafeSegment(id),
    secret === undefined ? undefined : cssSafeSegment(secret),
  );
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
/* ua-tracer probe stylesheet for trace ${cssSafeSegment(id)} */
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

export function jsBody(id: string, secret?: string): string {
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

export function manifestBody(id: string, secret?: string): string {
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

export function moduleBody(id: string, secret?: string): string {
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

// Asset paths map to the frozen hit kinds used in KV and detail views.
//
// This map is the RECORDED kind universe (ua-tracer-wot): the badge lists in views.ts derive from it,
// so a kind added here cannot be silently dropped from the UI. It used to be a local inside
// assetKind(), which let three places hold the kind set independently - this map, SHORT_KIND and
// KIND_ORDER - and a kind added to only one of them was recorded in KV and then vanished from the
// Fetched badges with no compile error and no failing test.
export const PROBE_KIND_BY_ASSET: Record<string, AssetKind> = {
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

// Every kind a probe can actually record, in the order the map declares them. DERIVED, so it cannot
// drift from the recorder the way a hand-written second list does.
export const PROBE_KINDS: readonly AssetKind[] = [...new Set(Object.values(PROBE_KIND_BY_ASSET))];

export function assetKind(asset: string): AssetKind | undefined {
  return PROBE_KIND_BY_ASSET[asset];
}
