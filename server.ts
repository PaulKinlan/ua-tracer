import {
  CANONICAL_ORIGIN,
  escapeHtml,
  homepageHtml,
  pageShell,
  traceDetailHtml,
  tracesPageHtml,
} from "./views.ts";
export { escapeHtml, fmtDelta, fmtTs, uaHeadline } from "./views.ts";
import {
  assetBase,
  assetKind,
  cssBody,
  GIF_1x1,
  ICO_FAVICON,
  jsBody,
  makePng,
  manifestBody,
  moduleBody,
  WOFF2_FONT,
} from "./probes.ts";
import { classifyBot } from "./bot-verification.ts";
import {
  getKv,
  listHits,
  logHit,
  logProbe,
  recentProbes,
  recentTraces,
  redactHeaders,
  type ResourceTiming,
  searchTracesByUa,
  seedTrace,
  shortId,
  type TraceRecord,
  type TraceStats,
  uaAggregate,
} from "./storage.ts";
export { cidrContains4, classifyBot, ipv4ToInt } from "./bot-verification.ts";
export type { BotVerification } from "./bot-verification.ts";
export { getKv, normUa, recentIndexKey, uaAggKey, uaIndexKey } from "./storage.ts";
export type { HitRecord, TraceRecord, TraceStats, UaAggregate } from "./storage.ts";
import { registerRepairCron, repairHealth } from "./crons.ts";

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

// Request helpers and HTTP routes; persistence, bot checks, probe payloads,
// and HTML rendering are owned by their respective modules.

// `::ffff:1.2.3.4` -> `1.2.3.4`, anything else unchanged. The runtime reports
// IPv4 peers IPv4-mapped over IPv6; classifyBot applies the same normalisation
// for its own direct callers.
function unmapIpv4(ip: string): string {
  return ip.replace(/^::ffff:/, "");
}

// The connection peer: the address the runtime accepted the TCP connection from.
// It is the one client address nobody can choose for themselves, so it is the
// only value a bot-verification verdict may be based on.
function peerIp(info?: Deno.ServeHandlerInfo): string | null {
  const addr = info?.remoteAddr;
  if (!addr || addr.transport !== "tcp") return null;
  return unmapIpv4(addr.hostname);
}

// The IP recorded against a request and written to the logs: the connection peer
// when the runtime gave us one, otherwise whatever the request claims about
// itself (x-forwarded-for, then x-real-ip) so a handler called without connection
// metadata still records something. Deno Deploy adds no forwarding header of its
// own — measured on the live deployment 2026-10-13: a request sending none
// arrives with none, and a client-supplied x-forwarded-for arrives verbatim, so
// neither the first nor the last element of a chain is platform-set — therefore a
// claimed address is client-controlled text. It may be recorded; it must never
// decide a verdict. `handleHomepage` takes its verification IP from `peerIp`.
export function clientIp(req: Request, info?: Deno.ServeHandlerInfo): string {
  const peer = peerIp(info);
  if (peer) return peer;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return unmapIpv4(xff.split(",")[0].trim());
  const real = req.headers.get("x-real-ip");
  if (real) return unmapIpv4(real.trim());
  return "unknown";
}

function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [k, v] of headers.entries()) obj[k] = v;
  return redactHeaders(obj);
}

// Common HTTP headers for responses from the route handlers.
function noStore(headers: HeadersInit = {}): Headers {
  const h = new Headers(headers);
  // Defeat caching so crawlers re-fetch and we always log.
  h.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  h.set("pragma", "no-cache");
  // Baseline defensive security headers applied to every response. These do
  // not interfere with the trace/probe logic (assets are first-party, inline
  // <style> is permitted by style-src 'unsafe-inline'). An enforced CSP here
  // is separate from the per-trace Content-Security-Policy-Report-Only probe,
  // which still fires violation reports for UAs that honour CSP reporting.
  if (!h.has("content-security-policy")) {
    h.set(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self'; script-src 'self'; frame-src 'self'; connect-src 'self'; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'",
    );
  }
  h.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("x-frame-options", "SAMEORIGIN");
  h.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  );
  return h;
}

// --- bounding the probe REQUEST BODY (ua-tracer-0ms, narrowed scope) -------------
// Reading is the FIRST unbounded step: `await req.text()` holds the whole POST in
// memory before any bound can be applied to it, so one large post is absorbed at full
// size even though the record it produces is tiny. The bound therefore belongs at the
// read: a declared length over the limit is refused before the body is touched, and a
// body that exceeds it while streaming is abandoned mid-read.
//
// The limit must sit BELOW the stored-value cap (65536 bytes, measured), because a
// body this app accepts becomes a KV value: a limit above the value cap would let a
// perfectly "accepted" body produce a record the KV cannot store, which is the failure
// that loses the probe. 32 KiB leaves room for the record's headers and UA while being
// generous for the real thing - a browser's resource-timing post is ~17 entries, about
// 1 KiB.
//
// A refused body still leaves its probe in the trace, marked as refused. Losing the
// evidence is the failure this whole area exists to prevent, so an over-limit post
// costs the payload, never the fact that the probe happened.
export const MAX_PROBE_BODY_BYTES = 32 * 1024;

/** Read a request body, refusing anything over `limit`. `null` means refused, not empty. */
export async function readBoundedBody(
  req: Request,
  limit = MAX_PROBE_BODY_BYTES,
): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel()
    }
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** What an over-limit probe body gets, instead of being absorbed. */
export function payloadTooLarge(limit = MAX_PROBE_BODY_BYTES): Response {
  return new Response(
    JSON.stringify({ ok: false, error: "payload too large", limit }),
    { status: 413, headers: noStore({ "content-type": "application/json" }) },
  );
}

// --- bounding the client-supplied timing payload (ua-tracer-0ms) -----------------
// Resource timings are attacker-shaped: the array length and every field are the
// client's choice. They become part of a KV value, whose cap is 65536 bytes
// (measured), so they are bounded here rather than at the write: an over-cap write
// throws, and before this the probe was lost entirely - no record, no count, and
// nothing saying so. Entries are dropped from the END (the earliest resources are
// the ones the waterfall is about), every dropped/truncated entry is reported in
// the record's headers and in a warning, and the response's `recorded` count tells
// the client what was kept. The bounds are deliberately generous: a real browser
// run posts ~17 entries of ~30 bytes each, which passes through untouched.
export const MAX_TIMING_ENTRIES = 200;
export const MAX_TIMING_BYTES = 24 * 1024;
const MAX_TIMING_NAME_CHARS = 512;
const MAX_TIMING_FIELD_CHARS = 64;

export interface BoundedTiming {
  timing: ResourceTiming[];
  /** entries the client sent that are not stored (over the bound, or unusable) */
  dropped: number;
  /** entries the client sent */
  total: number;
  /** entries stored with their resource name shortened */
  namesTruncated: number;
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Project one client entry onto the fields this app stores and renders. This is
 * lossless for the real client (probes.ts posts exactly these six) and it means an
 * entry carrying megabytes of unrelated JSON contributes nothing.
 */
function timingEntry(raw: unknown): { entry: ResourceTiming; truncated: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const name = String(src.name ?? "");
  const entry: ResourceTiming = {
    name: name.slice(0, MAX_TIMING_NAME_CHARS),
    entryType: String(src.entryType ?? "").slice(0, MAX_TIMING_FIELD_CHARS),
    startTime: finiteNumber(src.startTime),
    duration: finiteNumber(src.duration),
  };
  if (src.initiatorType != null) {
    entry.initiatorType = String(src.initiatorType).slice(0, MAX_TIMING_FIELD_CHARS);
  }
  if (src.transferSize != null) entry.transferSize = finiteNumber(src.transferSize);
  return { entry, truncated: name.length > MAX_TIMING_NAME_CHARS };
}

/** The bound in one place, so the marker, the warning and the tests agree. */
export function boundTiming(entries: readonly unknown[]): BoundedTiming {
  const timing: ResourceTiming[] = [];
  let namesTruncated = 0;
  let bytes = 0;
  for (const raw of entries) {
    if (timing.length >= MAX_TIMING_ENTRIES) break;
    const parsed = timingEntry(raw);
    if (!parsed) continue;
    const size = JSON.stringify(parsed.entry).length;
    if (bytes + size > MAX_TIMING_BYTES) break;
    bytes += size;
    if (parsed.truncated) namesTruncated++;
    timing.push(parsed.entry);
  }
  return {
    timing,
    dropped: entries.length - timing.length,
    total: entries.length,
    namesTruncated,
  };
}

/** One sentence carrying the counts, used for both the marker and the warning. */
export function timingNote(bounded: BoundedTiming): string {
  const parts: string[] = [];
  if (bounded.dropped > 0) {
    parts.push(`dropped ${bounded.dropped} of ${bounded.total} resource timings`);
  }
  if (bounded.namesTruncated > 0) {
    parts.push(`shortened ${bounded.namesTruncated} resource name(s)`);
  }
  return `${
    parts.join("; ")
  } (kept ${bounded.timing.length}; budget ${MAX_TIMING_BYTES} bytes / ${MAX_TIMING_ENTRIES} entries)`;
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

  const kind = assetKind(asset);
  if (!kind) {
    return new Response("Not found", { status: 404 });
  }

  // For /timing we read the POST body (resource timing) before logging. TWO bounds
  // apply, in this order (ua-tracer-0ms):
  //  - the READ is bounded, so an over-limit body is refused with a 4xx instead of being
  //    absorbed; the probe is still recorded below, marked as refused; and
  //  - the payload that does get read is bounded again before it is STORED, so a body
  //    this app accepted cannot become a record the KV cannot hold - entries are dropped
  //    from the end and reported in x-timing-truncated.
  // Either way the probe is recorded: an over-limit post costs the payload, never the
  // fact that the probe happened.
  let timing: ResourceTiming[] | undefined;
  let timingBodyRefused = false;
  if (asset === "timing" && req.method === "POST") {
    try {
      const text = await readBoundedBody(req);
      if (text === null) {
        timingBodyRefused = true;
        headers["x-timing-rejected"] =
          `request body over ${MAX_PROBE_BODY_BYTES} bytes - not read, timing payload dropped`;
        console.warn(
          `[timing] trace=${id} refused a request body over ${MAX_PROBE_BODY_BYTES} bytes`,
        );
      } else if (text) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.entries)) {
          const bounded = boundTiming(parsed.entries);
          timing = bounded.timing;
          if (bounded.dropped > 0 || bounded.namesTruncated > 0) {
            // Visible in the trace itself, not only in a log nobody reads: the
            // marker rides in the hit record's headers, which the trace view shows.
            headers["x-timing-truncated"] = timingNote(bounded);
            console.warn(`[timing] trace=${id} ${timingNote(bounded)}`);
          }
        }
      }
    } catch (_e) {
      // ignore malformed payloads
    }
  }

  // CSP / Reporting-API endpoints: capture the posted report body so it shows
  // up in the trace (stored in the hit headers under a synthetic key). Bounded for
  // the same reason as /timing, and refused bodies are still recorded.
  let reportBodyRefused = false;
  if ((asset === "csp-report" || asset === "report") && req.method === "POST") {
    try {
      const text = await readBoundedBody(req);
      if (text === null) {
        reportBodyRefused = true;
        headers["x-report-rejected"] = `request body over ${MAX_PROBE_BODY_BYTES} bytes - not read`;
        console.warn(
          `[report] trace=${id} refused a request body over ${MAX_PROBE_BODY_BYTES} bytes`,
        );
      } else if (text) {
        headers["x-report-body"] = text.slice(0, 4000);
      }
    } catch (_e) { /* ignore */ }
  }

  // Serve assets even for an unknown trace (bot probes rely on this), but do
  // not persist a hit with no owner. A trace disappearing after this lookup is
  // still handled by logHit's race-tolerant storage fallback.
  if (trace.value) await logHit({ id, kind, ts, ua, ip, method: req.method, headers, timing });

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
      if (timingBodyRefused) return payloadTooLarge();
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
      // (x-report-body header) for display in the trace. An over-limit body is
      // refused with a 4xx instead of being absorbed - but the hit is already
      // logged above, so the trace still shows the probe happened.
      if (reportBodyRefused) return payloadTooLarge();
      return new Response(null, { status: 204, headers: noStore() });
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function handleHomepage(
  req: Request,
  ip: string,
  trustedIp: string | null,
): Promise<Response> {
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
    // IP-range verification against published bot ranges (Google, OpenAI,
    // Bing). ClaudeBot/ChatGPT-User publish no ranges and are tagged
    // "unverifiable" — their UA is unfalsifiable. The IP is `trustedIp`, the
    // connection peer, or null when the runtime reported none: the client must
    // not be able to mint its own verdict from a header it wrote itself.
    const verified = await classifyBot(trustedIp, ua);
    const rec: TraceRecord = {
      id,
      ts,
      ua,
      ip,
      method: req.method,
      headers,
      secret,
      verified,
    };
    const seedStats: TraceStats = {
      id,
      ts,
      ua,
      ip,
      assetCount: 0,
      jsRan: false,
      kinds: [],
      verified,
    };

    await seedTrace(rec, seedStats);
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
async function handleTraces(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const uaFilter = url.searchParams.get("ua")?.trim() ?? "";
  const pathFilter = url.searchParams.get("path")?.trim() ?? "";
  const jsOnly = url.searchParams.get("js") === "1";
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
  const filtered = (uaFilter ? (await searchTracesByUa(uaFilter)).traces : allTraces)
    .filter((t) => !jsOnly || t.jsRan);

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
      jsOnly,
      totalTraces: totalTracesAll,
      uaPage,
      reqPage,
      probes,
      pathEntries,
    }),
    { headers: noStore({ "content-type": "text/html; charset=utf-8" }) },
  );
}

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
  return new Response(traceDetailHtml(trace.value, hits), {
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

  // NOTE: individual /trace/{id} detail pages are deliberately NOT listed.
  // They are ephemeral (a new one appears every few seconds), each is thin, and
  // advertising thousands of ever-changing URLs wastes crawler budget and
  // churns the sitemap. They remain crawlable via the in-page links on /
  // and /traces, so a shared trace link still resolves; we just don't bulk-
  // submit them as the site's canonical surface.

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

async function routeHandler(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
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
    // `build` is the revision this isolate is running, straight from the
    // platform ("the ID of the revision that is currently running", Deno Deploy
    // runtime env). It changes on every deploy, so a live check can tell a
    // silent failed or lagging deploy from a live one, and can pin two checks to
    // the same revision. It does NOT name the git commit: mapping a build id to
    // a commit is done in the Deno Deploy console, because no deployment
    // credentials exist on a project VM. null off-platform, where it is unset.
    // (DENO_DEPLOYMENT_ID is deliberately not exposed: it identifies the whole
    // configuration set rather than the revision.)
    //
    // `repair` (ua-tracer-2t9) is additive and non-secret: when the scheduled snapshot
    // repair last ran, its counts, and whether an unsettled or failing run is the last
    // thing it did. `ok` is false when the schedule is expected but not running, so a
    // job that has stopped firing - or never fired - is a FAILURE here rather than a
    // timestamp that quietly goes stale. A run that never happened is reported as
    // "never-ran" rather than folded into "ok".
    const repair = await repairHealth(await getKv());
    return new Response(
      JSON.stringify({
        ok: !repair.stale,
        ts: Date.now(),
        build: Deno.env.get("DENO_DEPLOY_BUILD_ID") ?? null,
        repair,
      }),
      { headers: { "content-type": "application/json" } },
    );
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
  if (
    (path === "/traces" || path === "/traces/") && (req.method === "GET" || req.method === "HEAD")
  ) {
    return await handleTraces(req);
  }

  // Homepage.
  if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
    return await handleHomepage(req, ip, peerIp(info));
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

// HTTP semantics: a HEAD request should return the same headers as GET (same
// status, same content-type, same security headers) with an empty body. Many
// monitoring tools and some crawlers issue HEAD; returning 404 for it was a
// broken signal. We route the request through the normal handler (so it still
// gets the full set of response headers) and then drop the body.
export async function handler(req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
  const res = await routeHandler(req, info);
  if (req.method === "HEAD") {
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
}

// Only start the server when this file is the entrypoint — importing it (e.g.
// from the backfill script) must NOT call Deno.serve().
//
// The scheduled snapshot repair (ua-tracer-2t9) is registered in the same block, and
// that placement is load-bearing in both directions:
//  - Deno Deploy discovers `Deno.cron()` definitions by evaluating the ENTRY module's
//    top-level code, so a registration hidden behind a runtime branch that is false in
//    production would make the whole feature inert;
//  - a test suite that imports this file is not the entry module, so `import.meta.main`
//    is false and the registration CANNOT happen in a test process at all — the suites
//    are structurally incapable of registering a cron rather than usually harmless.
if (import.meta.main) {
  const registration = registerRepairCron();
  if (!registration.registered) {
    console.log(`[cron] snapshot repair not scheduled: ${registration.reason}`);
  }
  console.log("ua-tracer starting…");
  Deno.serve(handler);
}
