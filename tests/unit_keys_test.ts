// KV index-key contracts. The browse pages, the search and the per-UA
// leaderboard are all `kv.list({prefix})` scans, so the *shape and ordering* of
// these keys is the query contract — a key change silently reorders or hides
// data without any type error. These tests pin the shape and, behaviourally, the
// newest-first ordering that the pages assume.

import { clearKv, testKv } from "./testenv.ts";
import { normUa, recentIndexKey, type TraceStats, uaAggKey, uaIndexKey } from "../server.ts";

Deno.test("normUa lowercases, trims, and buckets an empty UA", () => {
  if (normUa("  Mozilla/5.0  ") !== "mozilla/5.0") throw new Error(normUa("  Mozilla/5.0  "));
  if (normUa("") !== "(no user-agent)") throw new Error(normUa(""));
  if (normUa("   ") !== "(no user-agent)") throw new Error(normUa("   "));
});

Deno.test("index keys carry their reverse-timestamp segment in a fixed width", () => {
  const r = recentIndexKey(1700000000000, "abc");
  if (r[0] !== "recent" || r[2] !== "abc") throw new Error(JSON.stringify(r));
  if (r[1].length !== 20) throw new Error(`reverse key width ${r[1].length}`);

  const u = uaIndexKey("MyBot/1", 1700000000000, "abc");
  if (u[0] !== "ua" || u[1] !== "mybot/1" || u[3] !== "abc") throw new Error(JSON.stringify(u));

  const a = uaAggKey("MyBot/1");
  if (a[0] !== "ua-agg" || a[1] !== "mybot/1") throw new Error(JSON.stringify(a));
});

Deno.test("a newer trace sorts before an older one under the same prefix", () => {
  const older = recentIndexKey(1000, "a").join("|");
  const newer = recentIndexKey(2000, "b").join("|");
  if (!(newer < older)) throw new Error(`reverse keys not newest-first: ${newer} !< ${older}`);

  const uaOlder = uaIndexKey("U", 1000, "a").join("|");
  const uaNewer = uaIndexKey("U", 2000, "b").join("|");
  if (!(uaNewer < uaOlder)) throw new Error(`ua index not newest-first: ${uaNewer} !< ${uaOlder}`);
});

Deno.test("kv.list over the recent index yields traces newest-first", async () => {
  await clearKv();
  const kv = await testKv();
  const stats = (id: string, ts: number): TraceStats => ({
    id,
    ts,
    ua: "OrderBot/1",
    ip: "1.1.1.1",
    assetCount: 0,
    jsRan: false,
    kinds: [],
  });
  for (const [id, ts] of [["old", 1000], ["mid", 2000], ["new", 3000]] as const) {
    await kv.set(recentIndexKey(ts, id), stats(id, ts));
  }
  const seen: string[] = [];
  for await (const entry of kv.list<TraceStats>({ prefix: ["recent"] })) {
    seen.push(entry.value.id);
  }
  if (seen.join(",") !== "new,mid,old") throw new Error(`recent order: ${seen.join(",")}`);
});

Deno.test("UA buckets are case-insensitive, so a filter finds every casing", async () => {
  await clearKv();
  const kv = await testKv();
  for (const [i, ua] of ["CaseBot/1", "casebot/1", "CASEBOT/1"].entries()) {
    const s: TraceStats = {
      id: `c${i}`,
      ts: 1000 + i,
      ua,
      ip: "1.1.1.1",
      assetCount: 0,
      jsRan: false,
      kinds: [],
    };
    await kv.set(uaIndexKey(ua, s.ts, s.id), s);
  }
  let n = 0;
  for await (const _entry of kv.list({ prefix: ["ua", normUa("CaseBot/1")] })) n++;
  if (n !== 3) throw new Error(`expected 3 traces in one bucket, got ${n}`);
});
