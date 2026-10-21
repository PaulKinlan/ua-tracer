// Pure view contract: rendering must not open KV or start the HTTP server.
import {
  homepageHtml,
  KIND_ORDER,
  NON_BADGE_KINDS,
  traceDetailHtml,
  tracesPageHtml,
} from "../views.ts";
import { PROBE_KINDS } from "../probes.ts";
import {
  type AssetKind,
  type HitRecord,
  MAX_PROBE_PATH_CHARS,
  MAX_PROBE_UA_CHARS,
  type TraceRecord,
  type TraceStats,
} from "../storage.ts";

Deno.test("legacy oversized probe records have bounded /traces row and path-summary output", () => {
  const path = `/.well-known/${"p".repeat(80_000)}`;
  const ua = "u".repeat(80_000);
  const html = tracesPageHtml({
    traces: [],
    allTraces: [],
    uaEntries: [],
    uaFilter: "",
    pathFilter: "",
    jsOnly: false,
    totalTraces: 0,
    uaPage: 0,
    reqPage: 0,
    probes: [{ path, ua, ts: 1_000, ip: "192.0.2.1", method: "GET" }],
    pathEntries: [[path, { count: 1, uas: 1 }]],
  });
  if (html.includes("p".repeat(MAX_PROBE_PATH_CHARS + 1))) {
    throw new Error("old probe path rendered without a bound");
  }
  if (html.includes("u".repeat(MAX_PROBE_UA_CHARS + 1))) {
    throw new Error("old probe UA rendered without a bound");
  }
  if (html.length > 40_000) throw new Error(`one probe expanded /traces to ${html.length} chars`);
  if (!html.includes(path.slice(0, MAX_PROBE_PATH_CHARS))) {
    throw new Error("truncated path was not displayed");
  }
});

Deno.test("homepage HTML keeps the per-trace secret in nested probe URLs", () => {
  const html = homepageHtml({
    id: "trace-id",
    secret: "private-secret",
    traces: [],
    uaGroups: new Map(),
    uaFilter: "",
    totalTraces: 0,
    origin: "https://uatracer.com",
  });
  if (!html.includes("/r/trace-id/private-secret/style.css")) {
    throw new Error("secret probe path missing");
  }
  if (!html.includes('rel="canonical"')) throw new Error("canonical missing");
});

Deno.test("trace detail escapes request data and renders the JS waterfall", () => {
  const trace: TraceRecord = {
    id: "safe",
    ts: 1000,
    ip: "192.0.2.1",
    ua: "<img src=x>",
    method: "GET",
    headers: {},
  };
  const hits: HitRecord[] = [{
    id: "safe",
    kind: "timing",
    ts: 1100,
    ip: "192.0.2.1",
    ua: "test",
    method: "POST",
    headers: {},
    timing: [{
      name: "https://example.test/style.css",
      entryType: "resource",
      startTime: 1,
      duration: 2,
    }],
  }];
  const html = traceDetailHtml(trace, hits);
  if (html.includes("<img src=x>") || !html.includes("&lt;img src=x&gt;")) {
    throw new Error("UA was not escaped");
  }
  if (!html.includes("Client-side resource waterfall") || !html.includes("style.css")) {
    throw new Error("timing waterfall missing");
  }
});

// ua-tracer-wot: the kind universe used to be hand-enumerated in three places, so a kind added to the
// recorder alone was stored in KV and then dropped from the "Fetched" badges with no compile error
// and no failing test (a Partial<Record> and a plain array cannot see a gap). These assertions take
// their expectations from the recorder and from NON_BADGE_KINDS, so a new kind is covered without
// anyone remembering to extend this file - and a kind that is neither badged nor explicitly excluded
// fails the build (Record<BadgeKind, string> in views.ts) and this test.
function renderedBadges(kinds: AssetKind[]): string[] {
  const trace: TraceStats = {
    id: "t",
    ts: 1,
    ua: "UA",
    ip: "1.2.3.4",
    assetCount: kinds.length,
    jsRan: true,
    kinds,
    verified: null,
  };
  const html = tracesPageHtml({
    traces: [trace],
    allTraces: [trace],
    uaEntries: [],
    uaFilter: "",
    pathFilter: "",
    jsOnly: false,
    totalTraces: 1,
    uaPage: 0,
    reqPage: 0,
    probes: [],
    pathEntries: [],
  });
  const cell = /class="kinds-cell">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  return [...cell.matchAll(/<span class="badge kind">([^<]*)<\/span>/g)].map((m) => m[1]);
}

Deno.test("every kind the recorder can record reaches the Fetched badges, unless explicitly excluded", () => {
  if (PROBE_KINDS.length < 20) {
    throw new Error(
      `PROBE_KINDS parsed as ${PROBE_KINDS.length} - has the recorder changed shape?`,
    );
  }
  const badgeable = PROBE_KINDS.filter((k) => !(NON_BADGE_KINDS as readonly string[]).includes(k));
  const badges = renderedBadges([...PROBE_KINDS]);
  if (badges.length !== badgeable.length) {
    throw new Error(
      `the Fetched badges rendered ${badges.length} of ${badgeable.length} recorded kinds ` +
        `(${badges.join(", ")}) - a recorded kind is being dropped instead of shown`,
    );
  }
});

Deno.test("the badge list and the recorder cannot disagree", () => {
  const badgeKinds = new Set<string>(KIND_ORDER);
  const excluded = NON_BADGE_KINDS as readonly string[];
  const unbadged = PROBE_KINDS.filter((k) => !badgeKinds.has(k) && !excluded.includes(k));
  if (unbadged.length) {
    throw new Error(
      `recorded kinds that are neither badged nor explicitly excluded: ${unbadged.join(", ")} - ` +
        `give it a badge label in views.ts, or name it in NON_BADGE_KINDS as a decision`,
    );
  }
  const unknown = KIND_ORDER.filter((k) => !PROBE_KINDS.includes(k));
  if (unknown.length) {
    throw new Error(`badges for kinds no probe can record: ${unknown.join(", ")}`);
  }
});
