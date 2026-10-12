// Shared test harness.
//
// HERMETICITY CONTRACT (this is the only place the environment is shaped):
//   * Deno KV is redirected to an in-memory database BEFORE server.ts ever opens
//     one, so no test can touch production KV. `getKv()` in server.ts is lazy, so
//     setting the variable here is enough — it must merely happen before the first
//     `getKv()` call, and importing this module first guarantees that.
//   * The fast suites run WITHOUT `--allow-net`, so any accidental live fetch
//     (e.g. a bot-range refresh in `getBotRanges`) fails closed rather than
//     silently reaching the network. Tests that need ranges seed the KV cache.
//
// Import this module FIRST in every suite:
//   import { ... } from "./testenv.ts";
//   import { handler } from "../server.ts";

Deno.env.set("DENO_KV_URL", ":memory:");
// A hosted-KV token would only add a way to get this wrong.
Deno.env.delete("DENO_KV_ACCESS_TOKEN");

import { getKv } from "../storage.ts";
import { resetBotRangeCache } from "../bot-verification.ts";

/** The process-local in-memory KV this suite file is using. */
export function testKv(): Promise<Deno.Kv> {
  return getKv();
}

/** Remove every KV key and the bot classifier's in-memory range cache. */
export async function clearKv(): Promise<void> {
  const kv = await getKv();
  const keys: Deno.KvKey[] = [];
  for await (const entry of kv.list({ prefix: [] })) keys.push(entry.key);
  for (const key of keys) await kv.delete(key);
  resetBotRangeCache();
}

/** Count entries under a prefix (used to assert "no new trace was minted"). */
export async function countPrefix(prefix: Deno.KvKey): Promise<number> {
  const kv = await getKv();
  let n = 0;
  for await (const _entry of kv.list({ prefix })) n++;
  return n;
}

/**
 * Seed the KV-backed published-CIDR cache so `classifyBot` never fetches.
 * `getBotRanges` returns the KV entry untouched while it is younger than the
 * 24h TTL, so a seeded source is fully offline.
 */
export async function seedBotRanges(
  byName: Record<string, string[]>,
): Promise<void> {
  const kv = await getKv();
  const now = Date.now();
  for (const [name, prefixes] of Object.entries(byName)) {
    await kv.set(["botranges", name], { fetchedAt: now, prefixes });
  }
}

/**
 * Build a request. The host lives in the URL (not a header) because the router
 * reads `url.hostname` for the *.deno.net canonical redirect.
 */
export function req(
  path: string,
  init: RequestInit & { host?: string; proto?: string } = {},
): Request {
  const { host = "uatracer.com", proto = "https", headers, ...rest } = init;
  return new Request(`${proto}://${host}${path}`, { ...rest, headers });
}

/**
 * Pull the per-trace probe base (`/r/{id}/{secret}`) out of a rendered homepage.
 * Fails loudly if the page does not carry one — that path is the whole
 * mechanism, so a silent null would make every downstream assertion vacuous.
 */
export function traceBaseFromHtml(html: string): { id: string; secret: string } {
  const m = html.match(/\/r\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\//);
  if (!m) throw new Error("no /r/{id}/{secret}/ probe base found in homepage HTML");
  return { id: m[1], secret: m[2] };
}

/** Trace id from the `ua-tracer-trace` Set-Cookie header. */
export function traceIdFromSetCookie(res: Response): string | null {
  const cookie = res.headers.get("set-cookie") ?? "";
  const m = cookie.match(/ua-tracer-trace=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
