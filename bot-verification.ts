// Published bot CIDR verification; dependencies can be supplied by callers.
import { getKv } from "./storage.ts";

export interface BotVerification {
  bot: string; // claimed bot family ("Googlebot", "ClaudeBot", ...)
  status: "verified" | "unverified" | "unverifiable";
  note: string;
}

// Bots whose operators publish CIDR ranges we can match against.
const BOT_RANGE_SOURCES: { name: string; url: string; uaMatches: string[] }[] = [
  {
    name: "Googlebot",
    url: "https://developers.google.com/static/crawling/ipranges/common-crawlers.json",
    uaMatches: ["Googlebot"],
  },
  {
    name: "GPTBot",
    url: "https://openai.com/gptbot.json",
    uaMatches: ["GPTBot"],
  },
  {
    name: "OAI-SearchBot",
    url: "https://openai.com/searchbot.json",
    uaMatches: ["OAI-SearchBot"],
  },
  {
    name: "Bingbot",
    url: "https://www.bing.com/toolbox/bingbot.json",
    uaMatches: ["bingbot"],
  },
  // Anthropic publishes one list covering all three of its bots (ClaudeBot,
  // Claude-User, Claude-SearchBot). See:
  // https://support.claude.com/en/articles/8896518
  {
    name: "ClaudeBot",
    url: "https://claude.com/crawling/bots.json",
    uaMatches: ["ClaudeBot", "Claude-User", "Claude-SearchBot"],
  },
  // Apple publishes Applebot CIDRs and notes Applebot also renders in a
  // browser. See: http://www.apple.com/go/applebot
  {
    name: "Applebot",
    url: "https://search.developer.apple.com/applebot.json",
    uaMatches: ["Applebot"],
  },
];

// Bots that publish NO ranges — their UA cannot be IP-verified at all.
const UNVERIFIABLE_BOTS: { name: string; uaMatches: string[] }[] = [
  { name: "ChatGPT-User", uaMatches: ["ChatGPT-User"] },
];

const BOT_RANGES_TTL_MS = 24 * 60 * 60 * 1000; // refresh cached ranges daily

// IPv4 CIDR containment (Deno Deploy client IPs are IPv4 or IPv4-mapped IPv6;
// IPv6 ranges exist for some bots but are not matched in this first version).
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = parseInt(p, 10);
    if (Number.isNaN(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}
export function cidrContains4(cidr: string, ipInt: number): boolean {
  const slash = cidr.indexOf("/");
  if (slash < 0) return cidr === String(ipInt); // single host, rare
  const base = ipv4ToInt(cidr.slice(0, slash));
  const bits = parseInt(cidr.slice(slash + 1), 10);
  if (base === null || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (base & mask) === (ipInt & mask);
}

// Fetch, KV and clock are injectable so classification can be tested without
// global mocks. The default path retains the isolate-local cache; an injected
// call reads its own KV rather than inheriting another caller's ranges.
export interface BotDependencies {
  getKv?: () => Promise<Deno.Kv>;
  fetch?: typeof fetch;
  now?: () => number;
}
let _rangeCache: Map<string, { fetchedAt: number; prefixes: string[] }> | null = null;

// KV resets must also invalidate the isolate cache, which is consulted first.
export function resetBotRangeCache(): void {
  _rangeCache = null;
}
async function getBotRanges(
  source: { name: string; url: string },
  deps: BotDependencies,
): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const cache = Object.keys(deps).length
    ? new Map<string, { fetchedAt: number; prefixes: string[] }>()
    : (_rangeCache ??= new Map());
  const cached = cache.get(source.name);
  if (cached && now - cached.fetchedAt < BOT_RANGES_TTL_MS) {
    return cached.prefixes;
  }
  // KV-backed cache so isolates share the ranges and survive restarts.
  const kv = await (deps.getKv ?? getKv)();
  const key = ["botranges", source.name] as const;
  const kvEntry = await kv.get<{ fetchedAt: number; prefixes: string[] }>(key);
  let prefixes = kvEntry.value?.prefixes;
  let fetchedAt = kvEntry.value?.fetchedAt ?? 0;
  if (!prefixes || now - fetchedAt >= BOT_RANGES_TTL_MS) {
    try {
      const res = await (deps.fetch ?? fetch)(source.url);
      const json = await res.json() as {
        prefixes: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }>;
      };
      prefixes = json.prefixes
        .map((p) => p.ipv4Prefix ?? p.ipv6Prefix ?? "")
        .filter((p) => p.length > 0);
      fetchedAt = now;
      await kv.set(key, { fetchedAt, prefixes });
    } catch (_e) {
      // Network/parse failure: fall back to whatever we have, even if stale.
      if (!prefixes) prefixes = [];
    }
  }
  cache.set(source.name, { fetchedAt, prefixes });
  return prefixes;
}

// Classify a request by IP + UA. Returns null for non-bot UAs.
export async function classifyBot(
  ip: string,
  ua: string,
  deps: BotDependencies = {},
): Promise<BotVerification | null> {
  const ipNorm = ip.replace(/^::ffff:/, "").trim();
  const uaLower = (ua || "").toLowerCase();

  for (const source of BOT_RANGE_SOURCES) {
    if (source.uaMatches.some((m) => uaLower.includes(m.toLowerCase()))) {
      const ranges = await getBotRanges(source, deps);
      const ipInt = ipv4ToInt(ipNorm);
      const inRange = ipInt !== null &&
        ranges.some((r) => r.includes(".") && cidrContains4(r, ipInt));
      return {
        bot: source.name,
        status: inRange ? "verified" : "unverified",
        note: inRange
          ? `IP in ${source.name} published range`
          : `UA claims ${source.name} but IP not in published range`,
      };
    }
  }
  for (const u of UNVERIFIABLE_BOTS) {
    if (u.uaMatches.some((m) => uaLower.includes(m.toLowerCase()))) {
      return {
        bot: u.name,
        status: "unverifiable",
        note: `${u.name} does not publish IP ranges (UA is unfalsifiable)`,
      };
    }
  }
  return null;
}
