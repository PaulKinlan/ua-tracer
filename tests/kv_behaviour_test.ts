// KV write-path contracts. The denormalised snapshots (recent index, per-UA
// index, per-UA aggregate) are updated from concurrent sub-requests through an
// atomic compare-and-set loop; these tests are the regression guard for that
// loop losing an update (the bug the CAS exists to prevent: a clobbered jsRan
// flag or a short assetCount).

import { clearKv, countPrefix, req, testKv, traceBaseFromHtml } from "./testenv.ts";
import {
  handler,
  type HitRecord,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
  uaAggKey,
  type UaAggregate,
  uaIndexKey,
} from "../server.ts";

const UA = "ConcurrentBot/9.9";
const IP = "198.51.100.4";

async function mintOnce(ua = UA) {
  const res = await handler(req("/", { headers: { "user-agent": ua, "x-forwarded-for": IP } }));
  const html = await res.text();
  return traceBaseFromHtml(html);
}

async function stats(id: string, ts: number): Promise<TraceStats | null> {
  const kv = await testKv();
  return (await kv.get<TraceStats>(recentIndexKey(ts, id))).value;
}

Deno.test("concurrent sub-requests all land in one stats snapshot", async () => {
  await clearKv();
  const kv = await testKv();
  const { id, secret } = await mintOnce();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value!;
  const base = `/r/${id}/${secret}`;

  // 12 concurrent hits: 7 distinct kinds plus duplicates, mirroring what a real
  // browser fires (css, js, images and repeated beacons) all at once.
  const paths = [
    "style.css",
    "main.js",
    "photo.png",
    "font.woff2",
    "js-ran.gif",
    "js-ran.gif",
    "js-ran.gif",
    "css-bg.png",
    "css-font.woff2",
    "iframe",
    "module.js",
    "module-ran.gif",
  ];
  const responses = await Promise.all(paths.map((p) => handler(req(`${base}/${p}`))));
  for (const res of responses) {
    if (res.status !== 200) throw new Error(`probe ${res.status}`);
    await res.arrayBuffer();
  }

  const s = await stats(id, trace.ts);
  if (!s) throw new Error("stats entry vanished");
  if (s.assetCount !== paths.length) {
    throw new Error(`assetCount ${s.assetCount}, want ${paths.length} (lost an update)`);
  }
  if (s.jsRan !== true) throw new Error("jsRan was clobbered by a concurrent update");
  for (
    const kind of [
      "css",
      "js",
      "img",
      "font",
      "js-ran",
      "css-bg",
      "css-font",
      "iframe",
      "module",
      "module-ran",
    ]
  ) {
    if (!s.kinds.includes(kind as TraceStats["kinds"][number])) {
      throw new Error(`kinds missing ${kind}: ${s.kinds.join(",")}`);
    }
  }
  // The per-UA index snapshot is mirrored in the same atomic, so it must agree.
  const mirrored = (await kv.get<TraceStats>(uaIndexKey(trace.ua, trace.ts, id))).value;
  if (!mirrored || mirrored.assetCount !== s.assetCount || mirrored.jsRan !== s.jsRan) {
    throw new Error(`ua index snapshot out of sync: ${JSON.stringify(mirrored)}`);
  }
});

Deno.test("the per-UA aggregate counts traces and flips jsRan exactly once", async () => {
  await clearKv();
  const kv = await testKv();
  const minted = [];
  for (let i = 0; i < 3; i++) minted.push(await mintOnce(UA));

  const readAgg = async () => (await kv.get<UaAggregate>(uaAggKey(UA))).value;
  let agg = await readAgg();
  if (agg?.count !== 3) throw new Error(`aggregate count ${agg?.count}`);
  if (agg.jsRan !== 0) throw new Error(`aggregate jsRan ${agg.jsRan} before any JS hit`);

  // JS runs on exactly one of the three traces.
  const hit = await handler(req(`/r/${minted[1].id}/${minted[1].secret}/js-ran.gif`));
  if (hit.status !== 200) throw new Error(`js-ran ${hit.status}`);
  await hit.arrayBuffer();

  agg = await readAgg();
  if (agg?.count !== 3) throw new Error(`count changed to ${agg?.count}`);
  if (agg.jsRan !== 1) throw new Error(`jsRan ${agg.jsRan}, want exactly 1`);

  // A second js-ran beacon for the same trace must not double-count.
  const again = await handler(req(`/r/${minted[1].id}/${minted[1].secret}/js-ran.gif`));
  await again.arrayBuffer();
  agg = await readAgg();
  if (agg?.jsRan !== 1) throw new Error(`second beacon double-counted: ${agg?.jsRan}`);
});

Deno.test("the UA display name keeps the original casing", async () => {
  await clearKv();
  await mintOnce("CasingBot/1.0");
  const kv = await testKv();
  const agg = (await kv.get<UaAggregate>(uaAggKey("CasingBot/1.0"))).value;
  if (agg?.ua !== "CasingBot/1.0") throw new Error(`display name ${agg?.ua}`);
});

Deno.test("a probe carrying a secret for an unknown trace id is served, not 404", async () => {
  await clearKv();
  const res = await handler(req("/r/unknowntrace/somesecret/style.css"));
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  await res.text();
  const kv = await testKv();
  let hits = 0;
  for await (const _entry of kv.list<HitRecord>({ prefix: ["hit", "unknowntrace"] })) hits++;
  if (hits !== 1) throw new Error(`expected the hit to be logged, got ${hits}`);
  // No trace record means no stats entry is invented.
  if (await countPrefix(["recent"]) !== 0) throw new Error("stats entry created for unknown trace");
});
