// `backfill-verified` contract: it re-tags every stored trace with the IP-range
// classification derived from that trace's own IP + UA, and mirrors the result
// into the denormalised recent/UA snapshots. Those snapshots are what the browse
// pages render, so a missed mirror is a visible wrong badge. A verdict is only
// minted from an address the client could not have written (ua-tracer-4c9), which
// makes the recorded request headers part of the contract too.

import { clearKv, seedBotRanges, testKv } from "./testenv.ts";
import { runBackfillVerified, storedIpSource } from "../backfill-verified.ts";
import {
  type BotVerification,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
  uaIndexKey,
} from "../server.ts";

const TS = 1_700_000_000_000;
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1)";

/**
 * A trace as the request path records one. The headers are realistic — every HTTP request
 * has some — because the backfill reads provenance out of them: no forwarding header here
 * means the stored address can only have come from the connection peer.
 */
function trace(id: string, ua: string, ip: string, ts = TS): TraceRecord {
  return { id, ts, ua, ip, method: "GET", headers: { "user-agent": ua } };
}

/** A trace written before the peer-based request path: the client's header is its address. */
function traceFromHeader(
  id: string,
  ua: string,
  ip: string,
  headerName: "x-forwarded-for" | "x-real-ip" = "x-forwarded-for",
  ts = TS,
): TraceRecord {
  return {
    id,
    ts,
    ua,
    ip,
    method: "GET",
    headers: { "user-agent": ua, [headerName]: ip },
  };
}

function stats(t: TraceRecord): TraceStats {
  return { id: t.id, ts: t.ts, ua: t.ua, ip: t.ip, assetCount: 0, jsRan: false, kinds: [] };
}

async function seed(kv: Deno.Kv, t: TraceRecord, withSnapshots: boolean) {
  await kv.set(["trace", t.id], t);
  if (withSnapshots) {
    await kv.set(recentIndexKey(t.ts, t.id), stats(t));
    await kv.set(uaIndexKey(t.ua, t.ts, t.id), stats(t));
  }
}

Deno.test(
  "backfill-verified re-tags each trace and mirrors it into both snapshots",
  async () => {
    await clearKv();
    const kv = await testKv();
    // Seed the published range so classification needs no network.
    await seedBotRanges({ "Googlebot": ["66.249.64.0/19"] });

    const real = trace("real", "Mozilla/5.0 (compatible; Googlebot/2.1)", "66.249.66.9");
    const spoof = trace("spoof", "Googlebot/2.1", "203.0.113.9", TS + 1);
    const human = trace("human", "Mozilla/5.0 Chrome/120", "203.0.113.9", TS + 2);
    const unfalsifiable = trace("unfals", "ChatGPT-User/1.0", "203.0.113.9", TS + 3);
    const noSnapshot = trace("nosnap", "Googlebot/2.1", "66.249.66.20", TS + 4);
    const all = [real, spoof, human, unfalsifiable, noSnapshot];
    for (const t of all) await seed(kv, t, t.id !== "nosnap");

    const result = await runBackfillVerified(kv);
    if (result.scanned !== 5 || result.updated !== 5) throw new Error(JSON.stringify(result));

    const expect: Record<string, BotVerification | null> = {
      real: { bot: "Googlebot", status: "verified", note: "" },
      spoof: { bot: "Googlebot", status: "unverified", note: "" },
      human: null,
      unfals: { bot: "ChatGPT-User", status: "unverifiable", note: "" },
      nosnap: { bot: "Googlebot", status: "verified", note: "" },
    };
    for (const t of all) {
      const stored = (await kv.get<TraceRecord>(["trace", t.id])).value;
      const want = expect[t.id];
      const gotStatus = stored?.verified?.status ?? null;
      if (gotStatus !== (want?.status ?? null)) {
        throw new Error(
          `${t.id}: verified ${JSON.stringify(stored?.verified)} want ${JSON.stringify(want)}`,
        );
      }
      if (want && stored?.verified?.bot !== want.bot) {
        throw new Error(`${t.id}: bot ${stored?.verified?.bot} want ${want.bot}`);
      }
      const recent = (await kv.get<TraceStats>(recentIndexKey(t.ts, t.id))).value;
      const uaSnap = (await kv.get<TraceStats>(uaIndexKey(t.ua, t.ts, t.id))).value;
      if (t.id === "nosnap") {
        if (recent || uaSnap) throw new Error("a snapshot was invented for a trace that had none");
        continue;
      }
      if (!recent || !uaSnap) throw new Error(`${t.id}: snapshot missing after the run`);
      for (const [label, s] of [["recent", recent], ["ua", uaSnap]] as const) {
        if ((s.verified ?? null)?.status !== want?.status) {
          throw new Error(`${t.id} ${label} snapshot not re-tagged: ${JSON.stringify(s.verified)}`);
        }
      }
      // Re-tagging must not disturb the denormalised counters.
      if (recent.assetCount !== 0 || recent.jsRan !== false) {
        throw new Error(`${t.id}: counters disturbed`);
      }
    }

    if (result.tally["verified Googlebot"] !== 2) throw new Error(JSON.stringify(result.tally));
    if (result.tally["unverified Googlebot"] !== 1) throw new Error(JSON.stringify(result.tally));
    if (result.tally["unverifiable ChatGPT-User"] !== 1) {
      throw new Error(JSON.stringify(result.tally));
    }
    if (result.tally["(not a bot)"] !== 1) throw new Error(JSON.stringify(result.tally));

    // Idempotent: the second run produces the same classification and tallies.
    const second = await runBackfillVerified(kv);
    if (second.scanned !== 5 || second.updated !== 5) throw new Error(JSON.stringify(second));
    if (second.tally["verified Googlebot"] !== 2) throw new Error(JSON.stringify(second.tally));
  },
);

Deno.test("storedIpSource reads provenance back out of the record", () => {
  const withHeaders = (headers: Record<string, string>, ip: string) => ({ ip, headers });

  // The address is one of the values the client claimed -> the header produced it.
  if (
    storedIpSource(withHeaders({ "x-forwarded-for": "66.249.66.9" }, "66.249.66.9")) !== "claimed"
  ) {
    throw new Error("a single claimed hop was not read as claimed");
  }
  // The classic prepend: only the first chain element is what clientIp() stored.
  const chain = withHeaders({ "x-forwarded-for": "66.249.66.9, 10.0.0.1" }, "66.249.66.9");
  if (storedIpSource(chain) !== "claimed") throw new Error("the first chain hop was not claimed");
  if (storedIpSource(withHeaders({ "x-real-ip": "66.249.66.9" }, "66.249.66.9")) !== "claimed") {
    throw new Error("x-real-ip was not read as claimed");
  }
  // post-peer-path shape: the stored address is the peer, the header is only a claim.
  const peer = withHeaders({ "x-forwarded-for": "66.249.66.1" }, "203.0.113.7");
  if (storedIpSource(peer) !== "peer") throw new Error("a peer address was read as claimed");
  if (storedIpSource(withHeaders({}, "203.0.113.7")) !== "unknown") {
    throw new Error("an empty header map is not evidence of a peer address");
  }
  if (storedIpSource({ ip: "203.0.113.7", headers: undefined }) !== "unknown") {
    throw new Error("a record with no recorded headers was read as trusted");
  }
  if (storedIpSource(withHeaders({ "user-agent": "x" }, "unknown")) !== "unknown") {
    throw new Error("the unknown sentinel was read as an address");
  }
  if (storedIpSource(withHeaders({ "user-agent": "x" }, "")) !== "unknown") {
    throw new Error("a missing address was read as trusted");
  }
  // The runtime may spell an IPv4 peer either way on either side of the comparison.
  const mapped = withHeaders({ "x-forwarded-for": "66.249.66.9" }, "::ffff:66.249.66.9");
  if (storedIpSource(mapped) !== "claimed") throw new Error("an IPv4-mapped match was missed");
  // An empty header is ignored by the request path, so it cannot be the source.
  const emptyHeader = withHeaders({ "x-forwarded-for": "" }, "203.0.113.7");
  if (storedIpSource(emptyHeader) !== "peer") {
    throw new Error("an empty header was treated as a claim");
  }
});

Deno.test("a verdict is never minted from an address the client wrote", async () => {
  await clearKv();
  const kv = await testKv();
  await seedBotRanges({ "Googlebot": ["66.249.64.0/19"] });

  const genuine = trace("genuine", GOOGLEBOT_UA, "66.249.66.12");
  const forgedXff = traceFromHeader("forgedXff", GOOGLEBOT_UA, "66.249.66.9");
  const forgedReal = traceFromHeader("forgedReal", GOOGLEBOT_UA, "66.249.66.10", "x-real-ip");
  // A record older than the header capture: nothing to reason from, so nothing to trust.
  const noHeaders = {
    id: "noHeaders",
    ts: TS + 3,
    ua: GOOGLEBOT_UA,
    ip: "66.249.66.11",
    method: "GET",
  } as unknown as TraceRecord;
  // Out of range, so this one was already "unverified": the point is that it must stop
  // being accused at all, not merely stop being verified.
  const spoof = traceFromHeader("spoof", GOOGLEBOT_UA, "203.0.113.9", "x-forwarded-for", TS + 4);

  const all = [genuine, forgedXff, forgedReal, noHeaders, spoof];
  for (const t of all) await seed(kv, t, true);

  const result = await runBackfillVerified(kv);
  if (result.scanned !== 5) throw new Error(JSON.stringify(result));
  // Four claimed bots with no usable address; three of them would have been "verified".
  if (result.unprovenanced !== 4) throw new Error(`unprovenanced ${result.unprovenanced}`);
  if (result.withheldVerified !== 3) throw new Error(`withheld ${result.withheldVerified}`);

  const statusOf = async (id: string) => (await kv.get<TraceRecord>(["trace", id])).value?.verified;
  const genuineVerdict = await statusOf("genuine");
  if (genuineVerdict?.status !== "verified") {
    throw new Error(`a genuine peer address lost its verdict: ${JSON.stringify(genuineVerdict)}`);
  }
  for (const t of [forgedXff, forgedReal, noHeaders, spoof]) {
    const v = await statusOf(t.id);
    if (v?.bot !== "Googlebot" || v.status !== "unverifiable") {
      throw new Error(`${t.id}: expected unverifiable Googlebot, got ${JSON.stringify(v)}`);
    }
    if (v.note.includes("not in published range")) {
      throw new Error(`${t.id}: the note claims a check that never happened: ${v.note}`);
    }
    // The browse pages render the SNAPSHOTS, so the withheld verdict must be mirrored.
    for (const key of [recentIndexKey(t.ts, t.id), uaIndexKey(t.ua, t.ts, t.id)]) {
      const snap = (await kv.get<TraceStats>(key)).value;
      if (snap?.verified?.status !== "unverifiable") {
        throw new Error(`${t.id}: snapshot still carries ${JSON.stringify(snap?.verified)}`);
      }
    }
  }
  if (result.tally["verified Googlebot"] !== 1) throw new Error(JSON.stringify(result.tally));
  if (result.tally["unverifiable Googlebot"] !== 4) throw new Error(JSON.stringify(result.tally));

  // Idempotent: the same traces are withheld again and the written state does not drift.
  const second = await runBackfillVerified(kv);
  if (second.unprovenanced !== 4 || second.withheldVerified !== 3) {
    throw new Error(`a re-run must report the same withholding: ${JSON.stringify(second)}`);
  }
  if ((await statusOf("forgedXff"))?.status !== "unverifiable") {
    throw new Error("a re-run republished a verdict for an unprovenanced address");
  }
  if (second.tally["verified Googlebot"] !== 1) throw new Error(JSON.stringify(second.tally));
});

Deno.test("backfill-verified skips malformed trace entries", async () => {
  await clearKv();
  const kv = await testKv();
  await seedBotRanges({ "Googlebot": ["66.249.64.0/19"] });
  const good = trace("good", "Googlebot/2.1", "66.249.66.9");
  await seed(kv, good, true);
  // No id: the row must be counted as scanned and then skipped, not crash the run.
  await kv.set(["trace", "broken"], { ts: TS, ua: "Googlebot/2.1", ip: "66.249.66.9" });

  const result = await runBackfillVerified(kv);
  if (result.scanned !== 2) throw new Error(JSON.stringify(result));
  if (result.updated !== 1) throw new Error(JSON.stringify(result));
});

// ---- ua-tracer-5ub: the snapshot mirror is a compare-and-set, not a bare write ----

Deno.test("an increment that lands while the snapshots are read is not rolled back", async () => {
  await clearKv();
  const kv = await testKv();
  await seedBotRanges({ "Googlebot": ["66.249.64.0/19"] });
  const t = trace("racy", "Mozilla/5.0 (compatible; Googlebot/2.1)", "66.249.66.9");
  await seed(kv, t, true);
  const rKey = recentIndexKey(t.ts, t.id);
  const uKey = uaIndexKey(t.ua, t.ts, t.id);

  // Hits have already been counted: the snapshots are at 3, not 0.
  for (const key of [rKey, uKey]) {
    const cur = (await kv.get<TraceStats>(key)).value!;
    await kv.set(key, { ...cur, assetCount: 3 });
  }

  // The concurrent hit's increment commits at exactly the point the old code had read
  // behind it. Once is the race; the retry must then be allowed to win.
  let interleaved = 0;
  const result = await runBackfillVerified(kv, {
    afterRead: async () => {
      if (interleaved++ > 0) return;
      for (const key of [rKey, uKey]) {
        const cur = (await kv.get<TraceStats>(key)).value!;
        await kv.set(key, { ...cur, assetCount: cur.assetCount + 1 });
      }
    },
    delay: () => Promise.resolve(),
    warn: () => {},
  });

  for (const key of [rKey, uKey]) {
    const after = (await kv.get<TraceStats>(key)).value!;
    if (after.assetCount !== 4) {
      throw new Error(
        `${
          JSON.stringify(key)
        }: assetCount ${after.assetCount}, expected 4 - the concurrent increment was rolled back`,
      );
    }
    if (!after.verified) {
      throw new Error(`${JSON.stringify(key)}: verified did not land on the new count`);
    }
  }
  if (result.unsettled !== 0) throw new Error(`unsettled ${result.unsettled}`);
});

Deno.test("a snapshot that cannot be settled is counted, reported, and not a success", async () => {
  await clearKv();
  const kv = await testKv();
  await seedBotRanges({ "Googlebot": ["66.249.64.0/19"] });
  const t = trace("busy", "Mozilla/5.0 (compatible; Googlebot/2.1)", "66.249.66.9");
  await seed(kv, t, true);
  const rKey = recentIndexKey(t.ts, t.id);
  const uKey = uaIndexKey(t.ua, t.ts, t.id);

  const warnings: string[] = [];
  const result = await runBackfillVerified(kv, {
    // A writer that never stops, so every attempt's check fails.
    afterRead: async () => {
      for (const key of [rKey, uKey]) {
        const cur = (await kv.get<TraceStats>(key)).value!;
        await kv.set(key, { ...cur, assetCount: cur.assetCount + 1 });
      }
    },
    deadlineMs: 0,
    delay: () => Promise.resolve(),
    warn: (message) => warnings.push(message),
  });

  if (result.unsettled !== 1) throw new Error(`unsettled ${result.unsettled}, expected 1`);
  if (!warnings.some((w) => w.includes("busy"))) {
    throw new Error(`no warning naming the trace: ${JSON.stringify(warnings)}`);
  }
  // The trace record still got its verdict; the MIRROR is what failed, and the CLI exits
  // non-zero for exactly this.
  if (!(await kv.get<TraceRecord>(["trace", t.id])).value?.verified) {
    throw new Error("the trace record was not re-tagged");
  }
});
