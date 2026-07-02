// One-off backfill: compute the IP-range `verified` classification for every
// existing trace and write it back onto the trace record and its recent/UA
// index snapshots. Idempotent — safe to re-run; it overwrites `verified` on
// every trace from the authoritative source IP + UA.
//
// Run against production KV:
//   DENO_KV_ACCESS_TOKEN=<org token> \
//   DENO_KV_URL=https://api.deno.com/v2/databases/<db-id>/connect \
//   deno run --allow-all --unstable-kv backfill-verified.ts

import {
  type BotVerification,
  classifyBot,
  getKv,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
  uaIndexKey,
} from "./server.ts";

const kv = await getKv();

let scanned = 0;
let updated = 0;
const tally = new Map<string, number>();

console.log('backfill-verified: streaming ["trace"] records…');
for await (const entry of kv.list<TraceRecord>({ prefix: ["trace"] })) {
  scanned++;
  const t = entry.value;
  if (!t || !t.id || typeof t.ts !== "number") continue;

  const result: BotVerification | null = await classifyBot(t.ip ?? "", t.ua ?? "");
  const label = result ? `${result.status} ${result.bot}` : "(not a bot)";
  tally.set(label, (tally.get(label) ?? 0) + 1);

  // 1. trace record
  await kv.set(["trace", t.id], { ...t, verified: result });

  // 2. recent-index snapshot (read → add verified → write)
  const rKey = recentIndexKey(t.ts, t.id);
  const rCur = await kv.get<TraceStats>(rKey);
  if (rCur.value) {
    await kv.set(rKey, { ...rCur.value, verified: result });
  }

  // 3. per-UA index snapshot
  const uKey = uaIndexKey(t.ua, t.ts, t.id);
  const uCur = await kv.get<TraceStats>(uKey);
  if (uCur.value) {
    await kv.set(uKey, { ...uCur.value, verified: result });
  }

  updated++;
  if (scanned % 250 === 0) {
    console.log(`  …${scanned} scanned, ${updated} updated`);
  }
}

console.log(
  `backfill-verified: done. ${scanned} traces scanned, ${updated} updated with a \`verified\` field.`,
);
console.log("classification breakdown:");
[...tally.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) =>
  console.log(`  ${n.toString().padStart(5)}  ${k}`)
);
