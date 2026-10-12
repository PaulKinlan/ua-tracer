// `backfill-verified` contract: it re-tags every stored trace with the IP-range
// classification derived from that trace's own IP + UA, and mirrors the result
// into the denormalised recent/UA snapshots. Those snapshots are what the browse
// pages render, so a missed mirror is a visible wrong badge.

import { clearKv, seedBotRanges, testKv } from "./testenv.ts";
import { runBackfillVerified } from "../backfill-verified.ts";
import {
  type BotVerification,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
  uaIndexKey,
} from "../server.ts";

const TS = 1_700_000_000_000;

function trace(id: string, ua: string, ip: string, ts = TS): TraceRecord {
  return { id, ts, ua, ip, method: "GET", headers: {} };
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
