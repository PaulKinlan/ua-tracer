// Bot verification contract: UA -> claimed bot family, and IP -> verified /
// unverified / unverifiable. This is the one signal on the site that claims to
// distinguish a real crawler from a spoofed User-Agent, so it is tested by value
// against seeded published ranges.
//
// HERMETICITY: every range source except the deliberate fail-closed control is
// seeded into KV before any test runs, so `getBotRanges` never fetches. The fast
// suites also run without --allow-net, so a live fetch could not succeed even if
// the seeding were wrong (it would surface as "unverified", never as "verified").

import { clearKv, seedBotRanges } from "./testenv.ts";
import { classifyBot } from "../server.ts";

// The published-range fixture. Kept in one place because the cache-reset test at
// the end of this file wipes it and has to restore exactly this set, so the file
// stays order-independent (tests run in declaration order).
const RANGES: Record<string, string[]> = {
  "Googlebot": ["66.249.64.0/19"],
  "GPTBot": ["20.171.207.0/24"],
  "Bingbot": ["40.77.167.0/24"],
  // Anthropic publishes one list shared by ClaudeBot / Claude-User / Claude-SearchBot.
  "ClaudeBot": ["160.79.104.0/23"],
  "Applebot": ["17.241.208.0/24"],
  // "OAI-SearchBot" is deliberately NOT seeded - see the fail-closed test.
};

await clearKv();
await seedBotRanges(RANGES);

Deno.test("a claimed bot from inside its published range is verified", async () => {
  const v = await classifyBot("66.249.66.7", "Mozilla/5.0 (compatible; Googlebot/2.1)");
  if (v?.bot !== "Googlebot" || v.status !== "verified") {
    throw new Error(JSON.stringify(v));
  }
  if (!v.note.includes("published range")) throw new Error(v.note);
});

Deno.test("a claimed bot from outside its published range is unverified", async () => {
  const v = await classifyBot("203.0.113.5", "Mozilla/5.0 (compatible; Googlebot/2.1)");
  if (v?.bot !== "Googlebot" || v.status !== "unverified") {
    throw new Error(JSON.stringify(v));
  }
  if (!v.note.includes("not in published range")) throw new Error(v.note);
});

Deno.test("an IPv4-mapped IPv6 client IP is normalised before matching", async () => {
  const v = await classifyBot("::ffff:66.249.66.7", "Googlebot/2.1");
  if (v?.status !== "verified") throw new Error(JSON.stringify(v));
});

Deno.test("a plain IPv6 client IP cannot match an IPv4 range (and never verifies)", async () => {
  const v = await classifyBot("2001:4860:4801:1100::1", "Googlebot/2.1");
  if (v?.status !== "unverified") throw new Error(JSON.stringify(v));
});

Deno.test("UA matching is case-insensitive", async () => {
  const a = await classifyBot("40.77.167.9", "Mozilla/5.0 (compatible; Bingbot/2.0)");
  const b = await classifyBot("40.77.167.9", "Mozilla/5.0 (compatible; bingbot/2.0)");
  if (a?.status !== "verified" || b?.status !== "verified") {
    throw new Error(`${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
  if (a.bot !== "Bingbot") throw new Error(a.bot);
});

Deno.test("every Anthropic bot UA maps to the shared ClaudeBot range list", async () => {
  for (const ua of ["ClaudeBot/1.0", "Claude-User/1.0", "Claude-SearchBot/1.0"]) {
    const v = await classifyBot("160.79.105.4", ua);
    if (v?.bot !== "ClaudeBot" || v.status !== "verified") {
      throw new Error(`${ua}: ${JSON.stringify(v)}`);
    }
  }
});

Deno.test("bots that publish no ranges are unverifiable, not unverified", async () => {
  const v = await classifyBot("198.51.100.9", "ChatGPT-User/1.0");
  if (v?.bot !== "ChatGPT-User" || v.status !== "unverifiable") {
    throw new Error(JSON.stringify(v));
  }
});

Deno.test("Applebot resolves against Apple's published ranges", async () => {
  const v = await classifyBot("17.241.208.20", "Mozilla/5.0 (compatible; Applebot/0.1)");
  if (v?.bot !== "Applebot" || v.status !== "verified") throw new Error(JSON.stringify(v));
});

Deno.test("a non-bot user agent classifies as null", async () => {
  for (const ua of ["", "Mozilla/5.0 (X11; Linux) Chrome/120.0.0.0 Safari/537.36", "curl/8.0.1"]) {
    const v = await classifyBot("66.249.66.7", ua);
    if (v !== null) throw new Error(`${JSON.stringify(ua)} -> ${JSON.stringify(v)}`);
  }
});

Deno.test("an unseeded range source fails closed: unverified, never verified", async () => {
  // OAI-SearchBot has no KV entry and there is no network in this suite, so
  // `getBotRanges` cannot resolve a list. The result must be "unverified" -
  // a missing/failed range fetch must never be able to assert "verified".
  const v = await classifyBot("20.171.207.9", "Mozilla/5.0 (compatible; OAI-SearchBot/1.0)");
  if (v?.bot !== "OAI-SearchBot") throw new Error(JSON.stringify(v));
  if (v.status !== "unverified") throw new Error(`expected unverified, got ${v.status}`);
});

Deno.test("clearing the KV also drops the in-memory range cache", async () => {
  // `_rangeCache` is consulted before KV and holds a 24h TTL, so clearing the
  // seeded ranges without dropping it would keep classifying from a cache the
  // test believes it removed. The fixture is restored at the end so this test is
  // safe wherever it sits.
  const before = await classifyBot("66.249.66.7", "Googlebot/2.1");
  if (before?.status !== "verified") throw new Error(`precondition: ${JSON.stringify(before)}`);

  await clearKv();
  const cleared = await classifyBot("66.249.66.7", "Googlebot/2.1");
  // No KV ranges and no `--allow-net`, so it cannot resolve a list.
  if (cleared?.status !== "unverified") {
    throw new Error(`stale cache after clearKv: ${JSON.stringify(cleared)}`);
  }

  await seedBotRanges(RANGES);
  const reseeded = await classifyBot("66.249.66.7", "Googlebot/2.1");
  if (reseeded?.status !== "verified") {
    throw new Error(`post-condition: ${JSON.stringify(reseeded)}`);
  }
});
