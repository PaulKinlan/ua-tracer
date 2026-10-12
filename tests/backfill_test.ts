// Backfill / repair contract. The recent index used to hold a bare trace id;
// it holds a TraceStats snapshot now. What this file pins is no longer "we trust
// a current snapshot": the pass RECOMPUTES every snapshot from the durable
// records (["trace", id] + ["hit", id, ...]), repairs a snapshot that disagrees
// with them, preserves the bot verdict, keeps the per-UA aggregate equal to the
// fold of the per-UA index, stays idempotent, and is honest about a trace it
// could not show settled. All of it runs against an isolated KV with an injected
// clock and delay, so no test depends on the machine's time or on another
// agent's files.

import { clearKv, testKv } from "./testenv.ts";
import {
  backfillExitCode,
  DEFAULT_SETTLE_MS,
  DEFAULT_VERIFY_PACING_MS,
  rebuildStats,
  runBackfill,
} from "../backfill.ts";
import {
  type HitRecord,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
  uaAggKey,
  type UaAggregate,
  uaIndexKey,
} from "../server.ts";
import { CAS_DEADLINE_MS } from "../storage.ts";

const UA = "LegacyBot/1.0";
const ID = "legacy001";
const NOW = 1_800_000_000_000; // fixed "now": no test reads the machine clock
const OLD = NOW - 3_600_000; // an hour before NOW: comfortably past the settle window
const NO_WAIT = { now: () => NOW, delay: () => Promise.resolve() };
const VERIFIED = {
  bot: "Googlebot",
  status: "verified" as const,
  note: "203.0.113.9 is inside a published range",
};

function trace(id: string, ts: number, ua = UA, verified?: typeof VERIFIED): TraceRecord {
  return { id, ts, ua, ip: "203.0.113.9", method: "GET", headers: {}, verified };
}

function hit(id: string, kind: HitRecord["kind"], ts: number, ua = UA): [Deno.KvKey, HitRecord] {
  return [
    ["hit", id, String(ts)],
    { id, kind, ts, ua, ip: "203.0.113.9", method: "GET", headers: {} },
  ];
}

async function seedHits(
  kv: Deno.Kv,
  id: string,
  kinds: [HitRecord["kind"], number][],
  ua = UA,
) {
  for (const [kind, ts] of kinds) {
    const [key, rec] = hit(id, kind, ts, ua);
    await kv.set(key, rec);
  }
}

function stats(
  id: string,
  assetCount: number,
  jsRan: boolean,
  kinds: TraceStats["kinds"],
  ts = OLD,
  ua = "ModernBot/2.0",
): TraceStats {
  return { id, ts, ua, ip: "203.0.113.9", assetCount, jsRan, kinds, verified: null };
}

Deno.test("rebuildStats folds the stored hits into a stats snapshot, verdict included", async () => {
  await clearKv();
  const kv = await testKv();
  await kv.set(["trace", ID], trace(ID, OLD, UA, VERIFIED));
  // The homepage root must not be counted as a sub-request.
  await seedHits(kv, ID, [["homepage", OLD], ["css", OLD + 1], ["js-ran", OLD + 2], [
    "css",
    OLD + 3,
  ]]);

  const s = await rebuildStats(kv, ID);
  if (!s) throw new Error("rebuildStats returned null for a stored trace");
  if (s.assetCount !== 3) throw new Error(`assetCount ${s.assetCount}`);
  if (s.jsRan !== true) throw new Error("jsRan not derived from the js-ran hit");
  if (s.kinds.length !== 2 || !s.kinds.includes("css") || !s.kinds.includes("js-ran")) {
    throw new Error(`kinds ${s.kinds.join(",")}`);
  }
  if (s.ua !== UA || s.ts !== OLD || s.id !== ID) throw new Error(JSON.stringify(s));
  // The verdict is not derivable from hits: it comes from the trace record, and
  // a rebuild that drops it would wipe it on every repair.
  if (JSON.stringify(s.verified) !== JSON.stringify(VERIFIED)) {
    throw new Error(`verified lost: ${JSON.stringify(s.verified)}`);
  }
});

Deno.test("rebuildStats returns null when the trace row is gone", async () => {
  await clearKv();
  const kv = await testKv();
  if (await rebuildStats(kv, "missing") !== null) throw new Error("expected null");
});

Deno.test("runBackfill upgrades a legacy bare-id recent entry and rebuilds the indexes", async () => {
  await clearKv();
  const kv = await testKv();
  const legacyKey = recentIndexKey(OLD, ID);
  await kv.set(["trace", ID], trace(ID, OLD));
  await seedHits(kv, ID, [["css", OLD + 1], ["js-ran", OLD + 2]]);
  // Legacy schema: the value is the bare id string.
  await kv.set(legacyKey, ID);

  const result = await runBackfill(kv, NO_WAIT);
  if (result.scanned !== 1) throw new Error(`scanned ${result.scanned}`);
  if (result.rebuilt !== 1 || result.upgraded !== 1) {
    throw new Error(`rebuilt/upgraded ${result.rebuilt}/${result.upgraded}`);
  }
  if (result.aggregates !== 1) throw new Error(`aggregates ${result.aggregates}`);
  if (result.unsettled !== 0) throw new Error(`unsettled ${result.unsettled}`);

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
  await kv.set(["trace", ID], trace(ID, OLD));
  await seedHits(kv, ID, [["js-ran", OLD + 1]]);
  await kv.set(recentIndexKey(OLD, ID), ID);

  await runBackfill(kv, NO_WAIT);
  const second = await runBackfill(kv, NO_WAIT);
  // Recomputing is not repairing: a pass that changes nothing must say so, or
  // the second-run assertion below (and any future gate) cannot mean anything.
  if (second.rebuilt !== 0 || second.upgraded !== 0) {
    throw new Error(`second run rebuilt/upgraded ${second.rebuilt}/${second.upgraded}`);
  }
  if (second.aggregates !== 0 || second.unsettled !== 0) {
    throw new Error(`second run aggregates/unsettled ${second.aggregates}/${second.unsettled}`);
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
  await kv.set(recentIndexKey(OLD, "ghost"), "ghost");
  const result = await runBackfill(kv, NO_WAIT);
  if (result.scanned !== 1 || result.written !== 0 || result.aggregates !== 0) {
    throw new Error(JSON.stringify(result));
  }
  if ((await kv.get<UaAggregate>(uaAggKey("ghost"))).value !== null) {
    throw new Error("unexpected aggregate");
  }
});

Deno.test("runBackfill reconstructs a current-schema snapshot from its hits", async () => {
  await clearKv();
  const kv = await testKv();
  const id = "current001";
  const key = recentIndexKey(OLD, id);
  await kv.set(["trace", id], trace(id, OLD, "ModernBot/2.0", VERIFIED));
  await seedHits(
    kv,
    id,
    [["homepage", OLD], ["css", OLD + 1], ["js-ran", OLD + 2]],
    "ModernBot/2.0",
  );
  // A snapshot that disagrees with the records - exactly what a dropped
  // incremental update leaves behind, and what this pass exists to repair.
  await kv.set(key, stats(id, 99, false, []));

  const result = await runBackfill(kv, NO_WAIT);
  if (result.rebuilt !== 1 || result.unsettled !== 0) {
    throw new Error(JSON.stringify(result));
  }
  const stored = (await kv.get<TraceStats>(key)).value;
  if (stored?.assetCount !== 2 || stored.jsRan !== true) {
    throw new Error(`not reconstructed: ${JSON.stringify(stored)}`);
  }
  if (JSON.stringify(stored.kinds) !== JSON.stringify(["css", "js-ran"])) {
    throw new Error(`kinds ${JSON.stringify(stored.kinds)}`);
  }
  if (JSON.stringify(stored.verified) !== JSON.stringify(VERIFIED)) {
    throw new Error(`verdict not preserved: ${JSON.stringify(stored.verified)}`);
  }
  const mirrored = (await kv.get<TraceStats>(uaIndexKey("ModernBot/2.0", OLD, id))).value;
  if (JSON.stringify(mirrored) !== JSON.stringify(stored)) {
    throw new Error(`per-UA index not mirrored: ${JSON.stringify(mirrored)}`);
  }
  const agg = (await kv.get<UaAggregate>(uaAggKey("ModernBot/2.0"))).value;
  if (agg?.count !== 1 || agg.jsRan !== 1) throw new Error(JSON.stringify(agg));
});

// The qvu hazard, as the loop actually experiences it: a hit that was already
// counted by the rebuild has its own +1 land after the rebuild's write, so the
// stored snapshot is the fresh recompute plus one. A pass that stopped at its
// first comparison, or that re-committed a remembered value, would leave that
// overcount in place forever.
Deno.test("the verify loop repairs a snapshot an in-flight hit overcounts after the write", async () => {
  await clearKv();
  const kv = await testKv();
  const id = "race001";
  const key = recentIndexKey(OLD, id);
  await kv.set(["trace", id], trace(id, OLD));
  await seedHits(kv, id, [["homepage", OLD], ["css", OLD + 1], ["js-ran", OLD + 2]]);
  // A snapshot that is short by every sub-request: the pass repairs it first,
  // and the strike below then reproduces the overcount on top of the repair.
  await kv.set(key, stats(id, 0, false, []));

  let struck = false;
  const result = await runBackfill(kv, {
    now: () => NOW,
    delay: async () => {
      if (struck) return;
      struck = true;
      const cur = await kv.get<TraceStats>(key);
      if (cur.value) await kv.set(key, { ...cur.value, assetCount: cur.value.assetCount + 1 });
    },
  });

  const stored = (await kv.get<TraceStats>(key)).value;
  if (stored?.assetCount !== 2) {
    throw new Error(`overcount survived: assetCount ${stored?.assetCount}`);
  }
  if (result.unsettled !== 0) throw new Error(`unsettled ${result.unsettled}`);
});

// A writer that strikes after every correction must not read as a clean pass.
Deno.test("the verify loop is bounded and loud when a trace never settles", async () => {
  await clearKv();
  const kv = await testKv();
  const id = "hot001";
  const key = recentIndexKey(OLD, id);
  await kv.set(["trace", id], trace(id, OLD));
  await seedHits(kv, id, [["css", OLD + 1]]);
  await kv.set(key, stats(id, 0, false, []));

  const lines: string[] = [];
  const result = await runBackfill(kv, {
    now: () => NOW,
    maxRounds: 2,
    log: (line) => lines.push(line),
    delay: async () => {
      const cur = await kv.get<TraceStats>(key);
      if (cur.value) await kv.set(key, { ...cur.value, assetCount: cur.value.assetCount + 1 });
    },
  });

  if (result.unsettled !== 1) throw new Error(`unsettled ${result.unsettled}`);
  const reported = lines.find((l) => l.includes("UNSETTLED") && l.includes(id));
  if (!reported) throw new Error(`no UNSETTLED line for ${id}: ${lines.join(" | ")}`);
  if (!/attempt/.test(reported)) throw new Error(`no attempt count: ${reported}`);
  if (backfillExitCode(result) !== 1) throw new Error("a failed repair pass must not exit 0");
  if (backfillExitCode({ ...result, unsettled: 0 }) !== 0) {
    throw new Error("clean pass must exit 0");
  }
});

Deno.test("a pass defers a trace that received a hit inside the settle window", async () => {
  await clearKv();
  const kv = await testKv();
  const id = "fresh001";
  const key = recentIndexKey(NOW - 1_000, id);
  await kv.set(["trace", id], trace(id, NOW - 1_000));
  await seedHits(kv, id, [["css", NOW - 900]]);
  const corrupt: TraceStats = stats(id, 50, false, [], NOW - 1_000, UA);
  await kv.set(key, corrupt);

  const deferred = await runBackfill(kv, NO_WAIT);
  if (deferred.deferred !== 1 || deferred.rebuilt !== 0) {
    throw new Error(`expected a deferral: ${JSON.stringify(deferred)}`);
  }
  const untouched = (await kv.get<TraceStats>(key)).value;
  if (untouched?.assetCount !== 50) throw new Error("a deferred trace must not be touched");

  // The threshold is a policy knob, not a blind spot: forcing it off repairs it.
  const forced = await runBackfill(kv, { ...NO_WAIT, settleMs: 0 });
  if (forced.rebuilt !== 1 || forced.deferred !== 0) {
    throw new Error(`expected a repair: ${JSON.stringify(forced)}`);
  }
  const repaired = (await kv.get<TraceStats>(key)).value;
  if (repaired?.assetCount !== 1) throw new Error(`assetCount ${repaired?.assetCount}`);
});

Deno.test("the per-UA aggregate is recomputed as the fold of the per-UA index", async () => {
  await clearKv();
  const kv = await testKv();
  const idA = "foldA";
  const idB = "foldB";
  await kv.set(["trace", idA], trace(idA, OLD));
  await kv.set(["trace", idB], trace(idB, OLD));
  await seedHits(kv, idA, [["js-ran", OLD + 1]]);
  await seedHits(kv, idB, [["css", OLD + 1]]);
  await kv.set(recentIndexKey(OLD, idA), stats(idA, 1, true, ["js-ran"], OLD, UA));
  await kv.set(recentIndexKey(OLD, idB), stats(idB, 1, false, ["css"], OLD, UA));
  // A deliberately wrong aggregate: the pass must derive it, not preserve it.
  await kv.set(uaAggKey(UA), { ua: UA, count: 99, jsRan: 0 });

  const result = await runBackfill(kv, NO_WAIT);
  if (result.aggregates !== 1) throw new Error(`aggregates ${result.aggregates}`);
  const agg = (await kv.get<UaAggregate>(uaAggKey(UA))).value;
  if (agg?.count !== 2 || agg.jsRan !== 1) {
    throw new Error(`aggregate not folded: ${JSON.stringify(agg)}`);
  }
});

// The correctness argument above rests on the pacing, so the pacing is pinned.
Deno.test("the verification pacing is never shorter than the writers' retry deadline", async () => {
  if (DEFAULT_VERIFY_PACING_MS < CAS_DEADLINE_MS) {
    throw new Error(`pacing ${DEFAULT_VERIFY_PACING_MS} < deadline ${CAS_DEADLINE_MS}`);
  }
  if (DEFAULT_SETTLE_MS < 60_000) {
    throw new Error(`settle window ${DEFAULT_SETTLE_MS} is too short to avoid live traces`);
  }
  await clearKv();
  const kv = await testKv();
  const waits: number[] = [];
  await runBackfill(kv, {
    now: () => NOW,
    delay: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  if (waits.length === 0) throw new Error("the pass never paced its verification");
  for (const ms of waits) {
    if (ms < CAS_DEADLINE_MS) throw new Error(`paced ${ms}ms, shorter than the retry deadline`);
  }
});
