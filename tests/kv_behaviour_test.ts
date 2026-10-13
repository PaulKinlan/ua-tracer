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
import {
  type AssetKind,
  casRetry,
  commitHit,
  hitKeyFor,
  logHit,
  MAX_RECORD_BYTES,
} from "../storage.ts";
import { runBackfill } from "../backfill.ts";

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

Deno.test("an unknown-trace secret probe is served without persisting an orphan hit", async () => {
  await clearKv();
  const res = await handler(req("/r/unknowntrace/somesecret/style.css"));
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  await res.text();
  const kv = await testKv();
  let hits = 0;
  for await (const _entry of kv.list<HitRecord>({ prefix: ["hit", "unknowntrace"] })) hits++;
  if (hits !== 0) throw new Error(`unknown trace wrote ${hits} orphan hit(s)`);
  // No trace record means no stats entry is invented.
  if (await countPrefix(["recent"]) !== 0) throw new Error("stats entry created for unknown trace");
});

// ---- ua-tracer-3re: a hit's RECORD and its INCREMENT are one transaction ----
// Before the fold the record was written first and the increment landed in a later
// CAS, so a rebuild recomputing from the records could see a record whose +1 was
// still in flight and count it a second time (ua-tracer-qvu). These pin the fold,
// the give-up degradation (loud, and repairable by the backfill pass) and the
// payload bound that keeps an over-limit record from taking the probe with it.

const TRACE_TS = 1_700_000_500_000;

function traceRow(id: string, ts: number, ua = UA): TraceRecord {
  return { id, ts, ua, ip: IP, method: "GET", headers: {} };
}

function hitRec(id: string, kind: HitRecord["kind"], ts: number): HitRecord {
  return { id, kind, ts, ua: UA, ip: IP, method: "GET", headers: {} };
}

async function seedStats(id: string, ts: number, ua = UA): Promise<Deno.Kv> {
  const kv = await testKv();
  await kv.set(["trace", id], traceRow(id, ts, ua));
  await kv.set(recentIndexKey(ts, id), {
    id,
    ts,
    ua,
    ip: IP,
    assetCount: 0,
    jsRan: false,
    kinds: [],
    verified: null,
  });
  return kv;
}

async function hitCount(id: string): Promise<number> {
  const kv = await testKv();
  let n = 0;
  for await (const _entry of kv.list({ prefix: ["hit", id] })) n++;
  return n;
}

function encoded(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** A KV whose every atomic refuses to commit, so a CAS deadline is exhausted fast. */
function refusingKv(kv: Deno.Kv): Deno.Kv {
  const chain = {
    check: () => chain,
    set: () => chain,
    commit: () => Promise.resolve({ ok: false }),
  };
  return new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "atomic") return () => chain;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

Deno.test("a hit's record and its count are committed by one transaction", async () => {
  await clearKv();
  const id = "t3re1";
  const kv = await seedStats(id, TRACE_TS);
  const outcome = await commitHit(
    kv,
    hitRec(id, "css", TRACE_TS + 1),
    ["hit", id, "k1"],
    traceRow(id, TRACE_TS),
  );
  if (outcome !== "committed") throw new Error(`outcome ${outcome}`);
  if (!(await kv.get(["hit", id, "k1"])).value) {
    throw new Error("the record did not land together with the increment");
  }
  if ((await stats(id, TRACE_TS))?.assetCount !== 1) {
    throw new Error(`assetCount ${(await stats(id, TRACE_TS))?.assetCount}`);
  }
  const mirror = (await kv.get<TraceStats>(uaIndexKey(UA, TRACE_TS, id))).value;
  if (mirror?.assetCount !== 1) throw new Error(`per-UA mirror ${mirror?.assetCount}`);
});

Deno.test("a hit whose commit cannot land keeps its record, says so, and is repaired", async () => {
  await clearKv();
  const id = "t3re2";
  const kv = await seedStats(id, TRACE_TS);
  const warnings: string[] = [];
  const outcome = await commitHit(
    refusingKv(kv),
    hitRec(id, "css", TRACE_TS + 1),
    ["hit", id, "k2"],
    traceRow(id, TRACE_TS),
    { deadlineMs: 5, warn: (line) => warnings.push(line) },
  );
  if (outcome !== "recorded-alone") throw new Error(`outcome ${outcome}`);
  if (await hitCount(id) !== 1) throw new Error("the raw evidence was lost on give-up");
  if ((await stats(id, TRACE_TS))?.assetCount !== 0) {
    throw new Error("the count moved without its record");
  }
  const said = warnings.join(" | ");
  if (!said.includes(id)) throw new Error(`the warning does not name the trace: ${said}`);
  if (!said.includes("deno task backfill")) {
    throw new Error(`the warning does not name the repair command: ${said}`);
  }
  // Composition with plx: the short count is recoverable FROM the record, which is
  // what makes a bounded give-up an acceptable failure mode.
  const repaired = await runBackfill(kv, {
    settleMs: 0,
    now: () => TRACE_TS + 1_000_000,
    delay: () => Promise.resolve(),
  });
  if (repaired.unsettled !== 0) throw new Error(`unsettled ${repaired.unsettled}`);
  if ((await stats(id, TRACE_TS))?.assetCount !== 1) {
    throw new Error(`count not repaired: ${(await stats(id, TRACE_TS))?.assetCount}`);
  }
});

Deno.test("an over-limit payload is dropped so the probe is counted, not lost", async () => {
  await clearKv();
  const id = "t3re3";
  const kv = await seedStats(id, TRACE_TS);
  // Comfortably over the 64 KiB value cap, which is what a client can post to /timing.
  const fat: HitRecord = {
    ...hitRec(id, "timing", TRACE_TS + 1),
    timing: Array.from({ length: 400 }, (_, i) => ({
      name: `https://uatracer.com/r/t/${"p".repeat(120)}-${i}.css`,
      entryType: "resource",
      startTime: i,
      duration: 1.5,
      initiatorType: "link",
      transferSize: 1024,
      decodedBodySize: 2048,
      encodedBodySize: 1024,
      responseStatus: 200,
      nextHopProtocol: "h2",
      renderBlockingStatus: "blocking",
    })),
  };
  if (encoded(fat) <= 65536) throw new Error(`fixture is not over the cap: ${encoded(fat)}`);
  const warnings: string[] = [];
  const outcome = await commitHit(
    kv,
    fat,
    ["hit", id, "k3"],
    traceRow(id, TRACE_TS),
    { warn: (line) => warnings.push(line) },
  );
  if (outcome !== "committed") throw new Error(`outcome ${outcome}`);
  const stored = (await kv.get<HitRecord>(["hit", id, "k3"])).value;
  if (!stored) throw new Error("the probe was lost to the value cap");
  if (encoded(stored) > MAX_RECORD_BYTES) {
    throw new Error(`stored record is still ${encoded(stored)} bytes`);
  }
  if (!stored.headers["x-payload-truncated"]) {
    throw new Error("the truncation is not marked in the record");
  }
  if (!warnings.join(" ").includes("exceeded the KV value limit")) {
    throw new Error("the degradation was not loud");
  }
  if ((await stats(id, TRACE_TS))?.assetCount !== 1) {
    throw new Error("the probe was not counted");
  }
});

Deno.test("casRetry reports whether it committed and honours an injected deadline", async () => {
  await clearKv();
  const kv = await testKv();
  const committed = await casRetry(
    "test",
    async () => (await kv.atomic().set(["probe", "x"], 1).commit()).ok,
    50,
  );
  if (!committed) throw new Error("a successful commit must report true");
  const started = performance.now();
  const gaveUp = await casRetry("test", () => Promise.resolve(false), 5);
  const elapsed = performance.now() - started;
  if (gaveUp) throw new Error("a give-up must report false");
  if (elapsed > 500) throw new Error(`an injected 5ms deadline took ${elapsed}ms`);
});

// The property the fold buys, under concurrency, with the repair pass running at the
// same time: the counter can lag the records (a give-up) but can never exceed them.
Deno.test("concurrent hits plus a repair pass never count more than the records", async () => {
  await clearKv();
  const id = "t3re5";
  const kv = await seedStats(id, TRACE_TS);
  const hits = Array.from({ length: 12 }, (_, i) =>
    commitHit(
      kv,
      hitRec(id, "css", TRACE_TS + 1 + i),
      ["hit", id, `c${i}`],
      traceRow(id, TRACE_TS),
      { deadlineMs: 10_000 },
    ));
  const repairing = runBackfill(kv, {
    settleMs: 0,
    now: () => TRACE_TS + 1_000_000,
    delay: () => Promise.resolve(),
  });
  await Promise.all([...hits, repairing]);

  const records = await hitCount(id);
  const live = (await stats(id, TRACE_TS))?.assetCount ?? 0;
  if (live > records) {
    throw new Error(`count ${live} exceeds ${records} records: the overcount is back`);
  }
  // Settle: one more pass and the count is exactly the record set.
  await runBackfill(kv, {
    settleMs: 0,
    now: () => TRACE_TS + 2_000_000,
    delay: () => Promise.resolve(),
  });
  const settled = (await stats(id, TRACE_TS))?.assetCount ?? 0;
  if (settled !== records) {
    throw new Error(`after repair the count is ${settled} for ${records} records`);
  }
});

Deno.test("a homepage hit and a hit with no trace row record alone, moving no counter", async () => {
  await clearKv();
  const id = "t3re6";
  await seedStats(id, TRACE_TS);
  await logHit(hitRec(id, "homepage", TRACE_TS));
  await logHit(hitRec("ghost3re", "css", TRACE_TS + 1));
  if ((await stats(id, TRACE_TS))?.assetCount !== 0) {
    throw new Error("a homepage hit moved assetCount");
  }
  if (await hitCount(id) !== 1) throw new Error("the homepage record is missing");
  if (await hitCount("ghost3re") !== 1) {
    throw new Error("a hit with no trace row lost its record");
  }
  if (await countPrefix(["recent"]) !== 1) {
    throw new Error("a hit with no trace row invented a stats entry");
  }
});

// ---- ua-tracer-swf (P1): an unseeded stats entry must not lose the record ----
// The old code returned success on the unseeded branch WITHOUT executing the atomic,
// so the record was never written while the caller was told it had committed: a
// permanently lost probe, reported as a success.

Deno.test("a hit whose trace has no stats entry still lands its record", async () => {
  await clearKv();
  const kv = await testKv();
  const { id } = await mintOnce();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value!;

  // Reproduce the state exactly: the trace row is there, the recent-index entry is not.
  await kv.delete(recentIndexKey(trace.ts, id));
  if (await stats(id, trace.ts)) throw new Error("setup: the stats entry was not removed");

  const rec: HitRecord = {
    id,
    kind: "css",
    ts: Date.now(),
    ua: UA,
    ip: IP,
    method: "GET",
    headers: {},
  };
  const hitKey: Deno.KvKey = ["hit", id, "swf0000000000000000000001"];
  const warnings: string[] = [];
  const outcome = await commitHit(kv, rec, hitKey, trace, {
    warn: (line) => warnings.push(line),
    deadlineMs: 50,
  });

  if (outcome === "committed") {
    throw new Error("claimed a commit that never happened (ua-tracer-swf)");
  }
  if (!(await kv.get(hitKey)).value) {
    throw new Error("the hit record was lost (ua-tracer-swf)");
  }
  const joined = warnings.join("\n");
  if (!joined.includes(id)) throw new Error(`the warning does not name the trace: ${joined}`);
  if (!joined.includes("backfill")) {
    throw new Error(`the warning does not name the repair command: ${joined}`);
  }
});

// ---- ua-tracer-emp (P2 residual): no path out of commitHit may throw ----
// If KV rejected the record and the identity-only retry also failed, the old fallback
// awaited `kv.set` with the very record KV had rejected, so the TypeError escaped as an
// unhandled 500 and the probe was lost with it.

Deno.test("a KV that rejects the record cannot throw out of commitHit", async () => {
  await clearKv();
  const kv = await testKv();
  const { id } = await mintOnce();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value!;

  const written: Array<{ key: Deno.KvKey; value: HitRecord }> = [];
  const rejecting = {
    get: (key: Deno.KvKey) => kv.get(key),
    set: (key: Deno.KvKey, value: HitRecord) => {
      written.push({ key, value });
      return Promise.resolve({ ok: true, versionstamp: "v9" });
    },
    atomic: () => {
      const chain = {
        check: () => chain,
        set: () => chain,
        commit: () => Promise.reject(new TypeError("value too large")),
      };
      return chain;
    },
  } as unknown as Deno.Kv;

  const rec: HitRecord = {
    id,
    kind: "css",
    ts: Date.now(),
    ua: UA,
    ip: IP,
    method: "GET",
    headers: { "x-huge": "h".repeat(70_000) },
  };
  const hitKey: Deno.KvKey = ["hit", id, "emp0000000000000000000001"];
  const warnings: string[] = [];
  const outcome = await commitHit(rejecting, rec, hitKey, trace, {
    warn: (line) => warnings.push(line),
    deadlineMs: 5,
  });

  if (outcome !== "recorded-alone") throw new Error(`outcome ${outcome}`);
  if (!written.length) throw new Error("the fallback wrote nothing");
  const last = written[written.length - 1];
  if (JSON.stringify(last.key) !== JSON.stringify(hitKey)) {
    throw new Error(`the fallback wrote to ${JSON.stringify(last.key)}, not the hit key`);
  }
  const stored = last.value;
  if (JSON.stringify(stored).length > 4096) {
    throw new Error(
      `the fallback stored ${JSON.stringify(stored).length} bytes, which KV can refuse`,
    );
  }
  if (Object.keys(stored.headers).length) {
    throw new Error("the fallback kept headers KV had rejected");
  }
  if (!warnings.join("\n").includes("backfill")) {
    throw new Error(`no repair command in the warnings: ${warnings.join("\n")}`);
  }
});

Deno.test("a header over the value cap is trimmed before the write, not rejected", async () => {
  await clearKv();
  const kv = await testKv();
  const { id } = await mintOnce();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value!;
  const rec: HitRecord = {
    id,
    kind: "css",
    ts: Date.now(),
    ua: UA,
    ip: IP,
    method: "GET",
    headers: { "x-huge": "h".repeat(70_000) },
  };
  const hitKey: Deno.KvKey = ["hit", id, "hdr0000000000000000000001"];
  const warnings: string[] = [];
  const outcome = await commitHit(kv, rec, hitKey, trace, {
    warn: (line) => warnings.push(line),
  });
  if (outcome !== "committed") throw new Error(`outcome ${outcome}`);
  const stored = (await kv.get<HitRecord>(hitKey)).value;
  if (!stored) throw new Error("nothing was stored");
  if (JSON.stringify(stored).length > MAX_RECORD_BYTES) {
    throw new Error(`stored ${JSON.stringify(stored).length} bytes, over the budget`);
  }
  if (!stored.headers["x-payload-truncated"]) {
    throw new Error(`the trim is not marked: ${JSON.stringify(stored.headers)}`);
  }
});

// ---- ua-tracer-6sn: a hit's key is an identity, not a timestamp ----
// The key's timestamp segment orders hits within a trace, but two hits for one trace can
// sample the same microsecond. Before this the later write simply overwrote the earlier
// record: a lost probe with nothing recording the loss.

Deno.test("two hits in the same microsecond bucket both survive", async () => {
  await clearKv();
  const kv = await testKv();
  const { id } = await mintOnce();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value!;

  // The same bucket, deliberately - not by hoping two calls land in the same microsecond.
  const bucket = BigInt(trace.ts) * 1000000n + 4242n;
  const first = hitKeyFor(id, bucket);
  const second = hitKeyFor(id, bucket);
  if (JSON.stringify(first) === JSON.stringify(second)) {
    throw new Error("the hit key is still a pure timestamp (ua-tracer-6sn)");
  }

  const record = (kind: AssetKind): HitRecord => ({
    id,
    kind,
    ts: trace.ts,
    ua: UA,
    ip: IP,
    method: "GET",
    headers: {},
  });
  await commitHit(kv, record("css"), first, trace, { warn: () => {} });
  await commitHit(kv, record("js-ran"), second, trace, { warn: () => {} });

  // TWO records under two distinct keys. `mintOnce` already wrote the trace's homepage
  // record, so the prefix holds that one plus these two.
  for (const key of [first, second]) {
    if (!(await kv.get(key)).value) throw new Error(`no record at ${JSON.stringify(key)}`);
  }
  if (await countPrefix(["hit", id]) !== 3) {
    throw new Error(
      `expected the homepage record plus two, found ${await countPrefix(["hit", id])}`,
    );
  }
  if ((await stats(id, trace.ts))?.assetCount !== 2) {
    throw new Error(`assetCount ${(await stats(id, trace.ts))?.assetCount}, expected 2`);
  }
});

Deno.test("keys written before the change stay readable and are counted", async () => {
  await clearKv();
  const kv = await testKv();
  const { id } = await mintOnce();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value!;

  // A key in the OLD shape, exactly as a deploy before this change wrote it.
  const legacyKey: Deno.KvKey = ["hit", id, BigInt(trace.ts).toString().padStart(25, "0")];
  const legacy: HitRecord = {
    id,
    kind: "css",
    ts: trace.ts,
    ua: UA,
    ip: IP,
    method: "GET",
    headers: {},
  };
  await kv.set(legacyKey, legacy);
  // A new hit, which lands a suffixed key beside it.
  await logHit({ ...legacy, kind: "css" });

  // The same prefix scan finds both, which is what every reader uses. The homepage record
  // from `mintOnce` is a third, which is exactly the point: the scan is prefix-based and
  // does not care which shape a key has.
  if (await countPrefix(["hit", id]) !== 3) {
    throw new Error("a legacy and a suffixed key were not both listed");
  }
  // And the repair pass, which re-derives counts from the records, counts BOTH: a legacy
  // key and a suffixed key are treated identically.
  const repaired = await runBackfill(kv, {
    settleMs: 0,
    now: () => trace.ts + 1_000_000,
    delay: () => Promise.resolve(),
  });
  if (repaired.unsettled !== 0) throw new Error(`unsettled ${repaired.unsettled}`);
  if ((await stats(id, trace.ts))?.assetCount !== 2) {
    throw new Error(`repaired assetCount ${(await stats(id, trace.ts))?.assetCount}, expected 2`);
  }
});

Deno.test("a pre-existing hit record is never rewritten by a new one", async () => {
  await clearKv();
  const kv = await testKv();
  const { id } = await mintOnce();
  const trace = (await kv.get<TraceRecord>(["trace", id])).value!;
  const legacyKey: Deno.KvKey = ["hit", id, BigInt(trace.ts).toString().padStart(25, "0")];
  const legacy: HitRecord = {
    id,
    kind: "css",
    ts: trace.ts,
    ua: UA,
    ip: IP,
    method: "GET",
    headers: { "x-origin": "written-before-6sn" },
  };
  await kv.set(legacyKey, legacy);

  await logHit({ ...legacy, kind: "css", headers: {} });

  // No migration, no rewrite: the old record is byte-for-byte what was written.
  const after = (await kv.get<HitRecord>(legacyKey)).value;
  if (JSON.stringify(after) !== JSON.stringify(legacy)) {
    throw new Error(`the legacy record changed: ${JSON.stringify(after)}`);
  }
});
