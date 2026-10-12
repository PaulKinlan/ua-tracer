// HTTP contract tests. These drive the real request handler (`handler`, the
// exact function `Deno.serve` is given) against the in-memory KV, so routing,
// status codes, security headers, the probe/secret gating and the KV writes are
// all exercised end to end — without a server, without the network, and without
// touching production KV.

import {
  clearKv,
  countPrefix,
  req,
  testKv,
  traceBaseFromHtml,
  traceIdFromSetCookie,
} from "./testenv.ts";
import {
  handler,
  type HitRecord,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
} from "../server.ts";

const UA = "TestAgent/1.0";
const IP = "203.0.113.7";

/** Mint a trace through the real homepage and dig the probe base out of it. */
async function mint(ua = UA, ip = IP) {
  const res = await handler(
    req("/", { headers: { "user-agent": ua, "x-forwarded-for": ip } }),
  );
  const html = await res.text();
  return { res, html, ...traceBaseFromHtml(html) };
}

async function hitsOf(id: string): Promise<HitRecord[]> {
  const kv = await testKv();
  const hits: HitRecord[] = [];
  for await (const entry of kv.list<HitRecord>({ prefix: ["hit", id] })) hits.push(entry.value);
  return hits;
}

async function statsOf(id: string, ts: number): Promise<TraceStats | null> {
  const kv = await testKv();
  return (await kv.get<TraceStats>(recentIndexKey(ts, id))).value;
}

Deno.test("GET / mints a trace, gates the probe base with a secret, sets the cookie", async () => {
  await clearKv();
  const { res, html, id, secret } = await mint();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (res.headers.get("content-type") !== "text/html; charset=utf-8") {
    throw new Error(`content-type ${res.headers.get("content-type")}`);
  }
  if (!html.includes(`/r/${id}/${secret}/style.css`)) {
    throw new Error("homepage does not reference the secret-gated stylesheet");
  }
  if (traceIdFromSetCookie(res) !== id) throw new Error("cookie does not carry the trace id");
  const ror = res.headers.get("content-security-policy-report-only") ?? "";
  if (!ror.includes(`/r/${id}/${secret}/csp-report`)) {
    throw new Error(`report-uri missing from report-only CSP: ${ror}`);
  }
  if (!res.headers.get("reporting-endpoints")?.includes(`/r/${id}/${secret}/report`)) {
    throw new Error("Reporting-Endpoints not scoped to the trace");
  }
  const kv = await testKv();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value;
  if (!trace || trace.secret !== secret || trace.ua !== UA || trace.ip !== IP) {
    throw new Error(`trace record wrong: ${JSON.stringify(trace)}`);
  }
  const root = await hitsOf(id);
  if (root.length !== 1 || root[0].kind !== "homepage") {
    throw new Error(`expected one homepage hit, got ${JSON.stringify(root.map((h) => h.kind))}`);
  }
});

Deno.test("the homepage links direct assets and no CSS/JS-only probe", async () => {
  await clearKv();
  const { html, id, secret } = await mint();
  const base = `/r/${id}/${secret}`;
  for (
    const direct of [
      "style.css",
      "main.js",
      "module.js",
      "photo.png",
      "font.woff2",
      "favicon.ico",
      "apple-touch-icon.png",
      "manifest.json",
      "preload.png",
      "prefetch.png",
      "og-image.png",
      "twitter-image.png",
      "iframe",
    ]
  ) {
    if (!html.includes(`${base}/${direct}`)) throw new Error(`homepage missing ${direct}`);
  }
  // These are reached ONLY from inside CSS/JS/manifest/iframe. If any appeared
  // in the HTML the layered-probe signal would be worthless.
  for (
    const layered of [
      "css-bg.png",
      "css-font.woff2",
      "import.css",
      "js-ran.gif",
      "manifest-icon.png",
      "iframe-img.png",
    ]
  ) {
    if (html.includes(`${base}/${layered}`)) {
      throw new Error(`homepage must not link the layered probe ${layered}`);
    }
  }
});

Deno.test("the stylesheet carries the CSS-linked probes and the script the JS beacon", async () => {
  await clearKv();
  const { id, secret } = await mint();
  const base = `/r/${id}/${secret}`;

  const css = await handler(req(`${base}/style.css`));
  if (css.status !== 200) throw new Error(`style.css ${css.status}`);
  if (css.headers.get("content-type") !== "text/css; charset=utf-8") {
    throw new Error(`style.css content-type ${css.headers.get("content-type")}`);
  }
  const cssText = await css.text();
  for (const ref of ["css-bg.png", "css-font.woff2", "import.css"]) {
    if (!cssText.includes(`${base}/${ref}`)) throw new Error(`stylesheet missing ${ref}`);
  }

  const js = await handler(req(`${base}/main.js`));
  const jsText = await js.text();
  if (!jsText.includes(`${base}/js-ran.gif`)) throw new Error("script missing the js-ran beacon");

  const manifest = await handler(req(`${base}/manifest.json`));
  const manifestBody = await manifest.text();
  if (!manifestBody.includes(`${base}/manifest-icon.png`)) {
    throw new Error("manifest does not reference its own icon");
  }
  JSON.parse(manifestBody);
});

Deno.test("repeating GET / with the trace cookie reuses the trace instead of minting one", async () => {
  await clearKv();
  const first = await mint();
  const second = await handler(
    req("/", {
      headers: { "user-agent": UA, "cookie": `ua-tracer-trace=${first.id}` },
    }),
  );
  await second.text();
  if (traceIdFromSetCookie(second) !== first.id) throw new Error("second visit minted a new id");
  if (await countPrefix(["trace"]) !== 1) throw new Error("cookie reuse created a second trace");
  const hits = await hitsOf(first.id);
  if (hits.filter((h) => h.kind === "homepage").length !== 1) {
    throw new Error("reuse logged a second homepage hit");
  }
});

Deno.test("GET /traces is read-only: it mints nothing and lists what exists", async () => {
  await clearKv();
  const { id } = await mint();
  const before = await countPrefix(["trace"]);
  const res = await handler(req("/traces"));
  const html = await res.text();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (!html.includes(id)) throw new Error("existing trace not listed");
  if (await countPrefix(["trace"]) !== before) throw new Error("/traces minted a trace");
  const slash = await handler(req("/traces/"));
  await slash.text();
  if (slash.status !== 200) throw new Error(`/traces/ status ${slash.status}`);
  if (await countPrefix(["trace"]) !== before) throw new Error("/traces/ minted a trace");
});

Deno.test("an asset hit is logged with its kind and folded into the trace stats", async () => {
  await clearKv();
  const { id, secret } = await mint();
  const kv = await testKv();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value!;

  const res = await handler(req(`/r/${id}/${secret}/js-ran.gif`));
  if (res.status !== 200) throw new Error(`js-ran.gif ${res.status}`);
  if (res.headers.get("content-type") !== "image/gif") {
    throw new Error(`gif content-type ${res.headers.get("content-type")}`);
  }
  if ((await res.arrayBuffer()).byteLength === 0) throw new Error("empty gif body");

  const hits = await hitsOf(id);
  if (hits.length !== 2) throw new Error(`hits ${hits.length}`);
  const s = await statsOf(id, trace.ts);
  if (!s || s.assetCount !== 1 || s.jsRan !== true || !s.kinds.includes("js-ran")) {
    throw new Error(`stats ${JSON.stringify(s)}`);
  }
});

Deno.test("a wrong or absent secret 404s and logs nothing", async () => {
  await clearKv();
  const { id } = await mint();
  const before = (await hitsOf(id)).length;
  for (const path of [`/r/${id}/deadbeef/style.css`, `/r/${id}/style.css`]) {
    const res = await handler(req(path));
    if (res.status !== 404) throw new Error(`${path} -> ${res.status}`);
  }
  const after = (await hitsOf(id)).length;
  if (after !== before) throw new Error("a rejected probe was still logged");
});

Deno.test("a legacy trace (no secret) still serves the /r/{id}/ probe path", async () => {
  await clearKv();
  const kv = await testKv();
  const ts = Date.now();
  const legacy: TraceRecord = {
    id: "legacyid",
    ts,
    ua: UA,
    ip: IP,
    method: "GET",
    headers: {},
  };
  const seed: TraceStats = {
    id: "legacyid",
    ts,
    ua: UA,
    ip: IP,
    assetCount: 0,
    jsRan: false,
    kinds: [],
  };
  await kv.set(["trace", "legacyid"], legacy);
  await kv.set(recentIndexKey(ts, "legacyid"), seed);

  const res = await handler(req("/r/legacyid/style.css"));
  if (res.status !== 200) throw new Error(`legacy stylesheet ${res.status}`);
  const css = await res.text();
  if (!css.includes("/r/legacyid/import.css")) {
    throw new Error("legacy stylesheet did not use the legacy probe base");
  }
  if ((await hitsOf("legacyid")).length !== 1) throw new Error("legacy hit not logged");
});

Deno.test("an unknown asset name 404s even with a valid secret", async () => {
  await clearKv();
  const { id, secret } = await mint();
  const res = await handler(req(`/r/${id}/${secret}/not-an-asset`));
  if (res.status !== 404) throw new Error(`status ${res.status}`);
});

Deno.test("HEAD returns the GET headers with an empty body", async () => {
  await clearKv();
  const get = await handler(req("/traces"));
  const head = await handler(req("/traces", { method: "HEAD" }));
  if (head.status !== get.status) throw new Error(`${head.status} != ${get.status}`);
  if (head.headers.get("content-type") !== get.headers.get("content-type")) {
    throw new Error("HEAD content-type differs from GET");
  }
  if ((await head.text()) !== "") throw new Error("HEAD returned a body");
  await get.text();
});

Deno.test("the *.deno.net deploy host 301s to uatracer.com, with /api/health exempt", async () => {
  await clearKv();
  const res = await handler(req("/traces?ua=x", { host: "ua-tracer.deno.net" }));
  if (res.status !== 301) throw new Error(`status ${res.status}`);
  if (res.headers.get("location") !== "https://uatracer.com/traces?ua=x") {
    throw new Error(`location ${res.headers.get("location")}`);
  }
  await res.text();
  const health = await handler(req("/api/health", { host: "ua-tracer.deno.net" }));
  if (health.status !== 200) throw new Error(`health on deploy host ${health.status}`);
  const body = await health.json();
  if (body.ok !== true || typeof body.ts !== "number") throw new Error(JSON.stringify(body));
});

Deno.test("unsolicited well-known paths are served and logged as probes", async () => {
  await clearKv();
  const robots = await handler(req("/robots.txt"));
  if (robots.status !== 200) throw new Error(`robots.txt ${robots.status}`);
  if (!(await robots.text()).includes("Sitemap: https://uatracer.com/sitemap.xml")) {
    throw new Error("robots.txt lost its Sitemap line");
  }
  const ai = await handler(req("/.well-known/ai.txt"));
  if (ai.status !== 200) throw new Error(`/.well-known/ai.txt ${ai.status}`);
  await ai.text();
  const favicon = await handler(req("/favicon.ico"));
  if (favicon.headers.get("content-type") !== "image/x-icon") {
    throw new Error(`favicon content-type ${favicon.headers.get("content-type")}`);
  }
  await favicon.arrayBuffer();

  const kv = await testKv();
  const paths: string[] = [];
  for await (const entry of kv.list<{ path: string }>({ prefix: ["probe"] })) {
    paths.push(entry.value.path);
  }
  for (const p of ["/robots.txt", "/.well-known/ai.txt", "/favicon.ico"]) {
    if (!paths.includes(p)) throw new Error(`probe not logged: ${p} (got ${paths.join(",")})`);
  }
  // A probe is not a trace: none of this may mint one.
  if (await countPrefix(["trace"]) !== 0) throw new Error("a well-known path minted a trace");

  const traces = await handler(req("/traces?path=robots.txt"));
  if (!(await traces.text()).includes("robots.txt")) {
    throw new Error("the unsolicited log does not show the robots.txt probe");
  }
});

Deno.test("/sitemap.xml is real XML listing the canonical pages", async () => {
  await clearKv();
  const res = await handler(req("/sitemap.xml"));
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (!(res.headers.get("content-type") ?? "").includes("application/xml")) {
    throw new Error(`content-type ${res.headers.get("content-type")}`);
  }
  const xml = await res.text();
  for (
    const loc of ["<loc>https://uatracer.com/</loc>", "<loc>https://uatracer.com/traces</loc>"]
  ) {
    if (!xml.includes(loc)) throw new Error(`sitemap missing ${loc}`);
  }
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) throw new Error("not XML");
});

Deno.test("/trace/{id} renders the waterfall, and an unknown id 404s", async () => {
  await clearKv();
  const { id, secret } = await mint();
  await (await handler(req(`/r/${id}/${secret}/style.css`))).text();

  const res = await handler(req(`/trace/${id}`));
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const html = await res.text();
  if (!html.includes("TestAgent/1.0")) throw new Error("trace page lost the UA");
  if (!html.includes("CSS")) throw new Error("trace page lost the asset-kind summary");

  const missing = await handler(req("/trace/doesnotexist"));
  if (missing.status !== 404) throw new Error(`unknown trace -> ${missing.status}`);
  await missing.text();
});

Deno.test("a non-GET/HEAD request to / is not treated as a homepage hit", async () => {
  await clearKv();
  const res = await handler(req("/", { method: "POST" }));
  if (res.status !== 404) throw new Error(`POST / -> ${res.status}`);
  await res.text();
  if (await countPrefix(["trace"]) !== 0) throw new Error("POST / minted a trace");
});

Deno.test("a CSP / Reporting-API report POST is captured on the hit and acked with 204", async () => {
  await clearKv();
  const { id, secret } = await mint();
  for (
    const [asset, payload] of [["csp-report", "securitypolicyviolation"], [
      "report",
      "ReportingObserver",
    ]] as const
  ) {
    const res = await handler(
      req(`/r/${id}/${secret}/${asset}`, {
        method: "POST",
        body: JSON.stringify({ source: payload }),
      }),
    );
    // A 204 with no body is what the Reporting API expects; a 200 here would be
    // a behaviour change, so pin it.
    if (res.status !== 204) throw new Error(`${asset} -> ${res.status}`);
    await res.text();
    const hit = (await hitsOf(id)).find((h) => h.kind === asset);
    if (!hit) throw new Error(`${asset} hit not logged`);
    if (!hit.headers["x-report-body"]?.includes(payload)) {
      throw new Error(`${asset} body not captured`);
    }
  }
});

Deno.test("a timing POST records the client resource entries", async () => {
  await clearKv();
  const { id, secret } = await mint();
  const entries = [
    { name: "a", entryType: "resource", startTime: 1, duration: 2 },
    { name: "b", entryType: "resource", startTime: 3, duration: 4 },
  ];
  const res = await handler(
    req(`/r/${id}/${secret}/timing`, {
      method: "POST",
      body: JSON.stringify({ entries }),
    }),
  );
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const body = await res.json();
  if (body.recorded !== 2) throw new Error(JSON.stringify(body));
  const hit = (await hitsOf(id)).find((h) => h.kind === "timing");
  if (hit?.timing?.length !== 2) throw new Error(`timing not stored: ${JSON.stringify(hit)}`);
});

Deno.test("an unparseable timing body is ignored rather than fatal", async () => {
  await clearKv();
  const { id, secret } = await mint();
  const res = await handler(
    req(`/r/${id}/${secret}/timing`, { method: "POST", body: "not json" }),
  );
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const body = await res.json();
  if (body.recorded !== 0) throw new Error(JSON.stringify(body));
});
