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
const BOT_RANGE_FETCH_TIMEOUT_MS = 5_000; // cold/expired lookups run on GET /

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
  rangeFetchTimeoutMs?: number; // injectable to keep timeout tests fast
}
let _rangeCache: Map<string, { fetchedAt: number; prefixes: string[] }> | null = null;

// KV resets must also invalidate the isolate cache, which is consulted first.
export function resetBotRangeCache(): void {
  _rangeCache = null;
}
async function getBotRanges(
  source: { name: string; url: string },
  deps: BotDependencies,
): Promise<string[] | null> {
  const now = (deps.now ?? Date.now)();
  const cache = Object.keys(deps).length
    ? new Map<string, { fetchedAt: number; prefixes: string[] }>()
    : (_rangeCache ??= new Map());
  const cached = cache.get(source.name);
  if (cached?.prefixes.length && now - cached.fetchedAt < BOT_RANGES_TTL_MS) {
    return cached.prefixes;
  }
  // KV-backed cache so isolates share the ranges and survive restarts.
  const kv = await (deps.getKv ?? getKv)();
  const key = ["botranges", source.name] as const;
  const kvEntry = await kv.get<{ fetchedAt: number; prefixes: string[] }>(key);
  let prefixes = kvEntry.value?.prefixes;
  let fetchedAt = kvEntry.value?.fetchedAt ?? 0;
  if (!prefixes?.length || now - fetchedAt >= BOT_RANGES_TTL_MS) {
    try {
      const signal = AbortSignal.timeout(deps.rangeFetchTimeoutMs ?? BOT_RANGE_FETCH_TIMEOUT_MS);
      const res = await (deps.fetch ?? fetch)(source.url, { signal });
      if (!res.ok) throw new Error(`range fetch HTTP ${res.status}`);
      const json = await res.json() as {
        prefixes?: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }>;
      };
      prefixes = json.prefixes?.map((p) => p.ipv4Prefix ?? p.ipv6Prefix ?? "")
        .filter((p) => p.length > 0);
      if (!prefixes?.length) throw new Error("range source returned no prefixes");
      fetchedAt = now;
      await kv.set(key, { fetchedAt, prefixes });
    } catch (_e) {
      // A failed lookup (including a stale cache) is not proof of a spoofed bot.
      // Do not cache an empty set: the next request must be able to retry.
      return null;
    }
  }
  cache.set(source.name, { fetchedAt, prefixes });
  return prefixes;
}

// Classify a request by client IP + UA. `ip` must be the trusted client address
// (the connection peer). `null` means the runtime reported no peer: the claimed
// bot is then UNVERIFIABLE, not unverified — an address we never had is not
// evidence of spoofing, and a forwarding header is not evidence at all (see
// `clientIp`/`peerIp` in server.ts). Returns null for non-bot UAs.
export async function classifyBot(
  ip: string | null,
  ua: string,
  deps: BotDependencies = {},
): Promise<BotVerification | null> {
  const ipNorm = ip === null ? null : ip.replace(/^::ffff:/, "").trim();
  const uaLower = (ua || "").toLowerCase();

  for (const source of BOT_RANGE_SOURCES) {
    if (source.uaMatches.some((m) => uaLower.includes(m.toLowerCase()))) {
      if (ipNorm === null) {
        // No address to check against: naming the family is still useful, but a
        // verdict is not ours to give. No range fetch either — the answer cannot
        // depend on the ranges.
        return {
          bot: source.name,
          status: "unverifiable",
          note: `no trusted client address was available to check ${source.name} ranges`,
        };
      }
      const ranges = await getBotRanges(source, deps);
      if (!ranges) {
        return {
          bot: source.name,
          status: "unverifiable",
          note: `${source.name} published ranges temporarily unavailable`,
        };
      }
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
