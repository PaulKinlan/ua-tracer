// Legacy-schema backfill contract. The recent index holds a TraceStats snapshot
// now but used to hold a bare trace id; `runBackfill` upgrades those entries in
// place and (re)builds the per-UA index and aggregate. Since it runs against
// production KV, the parts worth pinning are: it rebuilds from the source of
// truth, it is idempotent, and it never crashes on a dangling entry.

import { clearKv, testKv } from "./testenv.ts";
import { rebuildStats, runBackfill } from "../backfill.ts";
import {
  type HitRecord,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
  uaAggKey,
  type UaAggregate,
} from "../server.ts";

const UA = "LegacyBot/1.0";
const ID = "legacy001";

function seedTrace(ts: number): TraceRecord {
  return { id: ID, ts, ua: UA, ip: "203.0.113.9", method: "GET", headers: {} };
}

function seedHit(kind: HitRecord["kind"], ts: number): [Deno.KvKey, HitRecord] {
  return [
    ["hit", ID, String(ts)],
    { id: ID, kind, ts, ua: UA, ip: "203.0.113.9", method: "GET", headers: {} },
  ];
}

Deno.test("rebuildStats folds the stored hits into a stats snapshot", async () => {
  await clearKv();
  const kv = await testKv();
  const ts = 1_700_000_000_000;
  await kv.set(["trace", ID], seedTrace(ts));
  // The homepage root must not be counted as a sub-request.
  for (
    const [key, hit] of [
      seedHit("homepage", ts),
      seedHit("css", ts + 1),
      seedHit("js-ran", ts + 2),
      seedHit("css", ts + 3),
    ]
  ) {
    await kv.set(key, hit);
  }
  const s = await rebuildStats(kv, ID);
  if (!s) throw new Error("rebuildStats returned null for a stored trace");
  if (s.assetCount !== 3) throw new Error(`assetCount ${s.assetCount}`);
  if (s.jsRan !== true) throw new Error("jsRan not derived from the js-ran hit");
  if (s.kinds.length !== 2 || !s.kinds.includes("css") || !s.kinds.includes("js-ran")) {
    throw new Error(`kinds ${s.kinds.join(",")}`);
  }
  if (s.ua !== UA || s.ts !== ts || s.id !== ID) throw new Error(JSON.stringify(s));
});

Deno.test("rebuildStats returns null when the trace row is gone", async () => {
  await clearKv();
  const kv = await testKv();
  if (await rebuildStats(kv, "missing") !== null) throw new Error("expected null");
});

Deno.test("runBackfill upgrades a legacy bare-id recent entry and rebuilds the indexes", async () => {
  await clearKv();
  const kv = await testKv();
  const ts = 1_700_000_000_000;
  const legacyKey = recentIndexKey(ts, ID);
  await kv.set(["trace", ID], seedTrace(ts));
  await kv.set(seedHit("css", ts + 1)[0], seedHit("css", ts + 1)[1]);
  await kv.set(seedHit("js-ran", ts + 2)[0], seedHit("js-ran", ts + 2)[1]);
  // Legacy schema: the value is the bare id string.
  await kv.set(legacyKey, ID);

  const result = await runBackfill(kv);
  if (result.scanned !== 1) throw new Error(`scanned ${result.scanned}`);
  if (result.rebuilt !== 1 || result.upgraded !== 1) {
    throw new Error(`rebuilt/upgraded ${result.rebuilt}/${result.upgraded}`);
  }
  if (result.aggregates !== 1) throw new Error(`aggregates ${result.aggregates}`);

  const upgraded = (await kv.get<TraceStats>(legacyKey)).value;
  if (typeof upgraded !== "object" || upgraded?.assetCount !== 2 || upgraded.jsRan !== true) {
    throw new Error(`recent entry not upgraded: ${JSON.stringify(upgraded)}`);
  }
  const agg = (await kv.get<UaAggregate>(uaAggKey(UA))).value;
  if (agg?.count !== 1 || agg.jsRan !== 1 || agg.ua !== UA) {
    throw new Error(`aggregate ${JSON.stringify(agg)}`);
  }
  let uaEntries = 0;
  for await (const _entry of kv.list({ prefix: ["ua", "legacybot/1.0"] })) uaEntries++;
  if (uaEntries !== 1) throw new Error(`per-UA index entries ${uaEntries}`);
});

Deno.test("runBackfill is idempotent", async () => {
  await clearKv();
  const kv = await testKv();
  const ts = 1_700_000_000_000;
  await kv.set(["trace", ID], seedTrace(ts));
  await kv.set(seedHit("js-ran", ts + 1)[0], seedHit("js-ran", ts + 1)[1]);
  await kv.set(recentIndexKey(ts, ID), ID);

  await runBackfill(kv);
  const second = await runBackfill(kv);
  if (second.rebuilt !== 0 || second.upgraded !== 0) {
    throw new Error(`second run rebuilt/upgraded ${second.rebuilt}/${second.upgraded}`);
  }
  const agg = (await kv.get<UaAggregate>(uaAggKey(UA))).value;
  if (agg?.count !== 1 || agg.jsRan !== 1) {
    throw new Error(`aggregate drifted: ${JSON.stringify(agg)}`);
  }
  let uaEntries = 0;
  for await (const _entry of kv.list({ prefix: ["ua", "legacybot/1.0"] })) uaEntries++;
  if (uaEntries !== 1) throw new Error(`duplicated per-UA entries: ${uaEntries}`);
});

Deno.test("runBackfill skips a dangling legacy entry without inventing data", async () => {
  await clearKv();
  const kv = await testKv();
  await kv.set(recentIndexKey(1_700_000_000_000, "ghost"), "ghost");
  const result = await runBackfill(kv);
  if (result.scanned !== 1 || result.written !== 0 || result.aggregates !== 0) {
    throw new Error(JSON.stringify(result));
  }
  if ((await kv.get<UaAggregate>(uaAggKey("ghost"))).value !== null) {
    throw new Error("unexpected aggregate");
  }
});

Deno.test("runBackfill leaves current-schema entries alone but still indexes them", async () => {
  await clearKv();
  const kv = await testKv();
  const ts = 1_700_000_000_000;
  const current: TraceStats = {
    id: "current001",
    ts,
    ua: "ModernBot/2.0",
    ip: "203.0.113.9",
    assetCount: 4,
    jsRan: true,
    kinds: ["css", "js-ran"],
  };
  await kv.set(recentIndexKey(ts, "current001"), current);
  const result = await runBackfill(kv);
  if (result.rebuilt !== 0) throw new Error(`rebuilt ${result.rebuilt}`);
  if (result.written !== 1) throw new Error(`written ${result.written}`);
  const stored = (await kv.get<TraceStats>(recentIndexKey(ts, "current001"))).value;
  if (stored?.assetCount !== 4) throw new Error("current entry was rewritten");
  const agg = (await kv.get<UaAggregate>(uaAggKey("ModernBot/2.0"))).value;
  if (agg?.count !== 1 || agg.jsRan !== 1) throw new Error(JSON.stringify(agg));
});
