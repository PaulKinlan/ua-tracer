// One-off backfill: recompute the IP-range `verified` classification for every
// existing trace and write it back onto the trace record and its recent/UA
// index snapshots. Idempotent — safe to re-run.
//
// The stored `ip` may only decide a verdict when the client could not have written
// it (see `storedIpSource`): a trace whose address was read out of a forwarding
// header — every trace written before the peer-based request path landed — is
// re-tagged `unverifiable` instead, so an address a client forged can never be
// republished as `verified` (ua-tracer-4c9).
//
// Run against production KV:
//   DENO_KV_ACCESS_TOKEN=<org token> \
//   DENO_KV_URL=https://api.deno.com/v2/databases/<db-id>/connect \
//   deno run --allow-all --unstable-kv backfill-verified.ts
//
// The body lives in `runBackfillVerified(kv)` (rather than top-level await) so
// tests can drive it against an isolated KV; `import.meta.main` keeps importing
// this file side-effect free.

import {
  CAS_DEADLINE_MS,
  getKv,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
  uaIndexKey,
} from "./storage.ts";
import { type BotVerification, classifyBot } from "./bot-verification.ts";

export interface BackfillVerifiedResult {
  scanned: number;
  updated: number;
  /**
   * Traces whose trace record was updated but whose recent/UA snapshots kept losing the
   * compare-and-set to a concurrent writer, so the mirror did not land. Re-running folds
   * them in; the CLI exits non-zero while this is not zero (ua-tracer-5ub).
   */
  unsettled: number;
  /**
   * Claimed-bot traces whose stored address could not support a verdict (it came from a
   * forwarding header, or no address evidence was stored at all), so none was minted from
   * it. They are re-tagged `unverifiable` instead (ua-tracer-4c9).
   */
  unprovenanced: number;
  /**
   * Of `unprovenanced`, how many the stored address alone would have classified as
   * `verified`. This is the size of the forged-badge population the run refuses to
   * republish, and the number to quote when measuring the run's effect on live data.
   */
  withheldVerified: number;
  /** "status bot" -> number of traces, for the console breakdown. */
  tally: Record<string, number>;
}

/**
 * Where a stored trace's `ip` came from.
 *
 * `"peer"` — the connection address the runtime accepted (Deno's `remoteAddr`). The client
 * cannot choose it, so it may decide a verdict.
 * `"claimed"` — the value of a forwarding header (`x-forwarded-for` / `x-real-ip`). The
 * client writes those, so such an address may be recorded but never decides a verdict.
 * `"unknown"` — no address, or no header evidence to reason from.
 */
export type IpSource = "peer" | "claimed" | "unknown";

/** Same address, however the runtime spelled it (`::ffff:1.2.3.4` is `1.2.3.4`). */
function sameAddress(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/^::ffff:/, "");
  return norm(a) === norm(b);
}

/**
 * The provenance of a STORED address. Records carry the address, the request headers and the
 * UA but no provenance marker of their own, so it is read back from those using the one
 * property every version of `clientIp()` has had: **a forwarding header wins over the
 * connection peer**. An address equal to a recorded forwarding-header value was produced by
 * that header (`"claimed"`); an address equal to none of them cannot have come from one
 * (`"peer"`). That reading is correct both for records written before the peer-based request
 * path (address = the header the client sent) and after it (address = the peer, while any
 * header is only a claim to compare against).
 *
 * A record with no recorded headers is not evidence of anything — every HTTP request has
 * headers, so an empty map means the record predates the header capture — and reads as
 * `"unknown"`, which is not a verdict basis either. Header names are compared lowercased
 * because `headersToObject` stores them as the `Headers` API reports them.
 */
export function storedIpSource(
  t: Pick<TraceRecord, "ip"> & { headers?: Record<string, string> },
): IpSource {
  const ip = (t.ip ?? "").trim();
  if (!ip || ip === "unknown") return "unknown";
  const headers = t.headers ?? {};
  if (Object.keys(headers).length === 0) return "unknown";
  const claims = [
    (headers["x-forwarded-for"] ?? "").split(",")[0],
    headers["x-real-ip"] ?? "",
  ].map((v) => v.trim()).filter((v) => v.length > 0);
  return claims.some((claim) => sameAddress(claim, ip)) ? "claimed" : "peer";
}

export interface BackfillVerifiedOptions {
  /**
   * Called after the two snapshots are read and before they are written. Tests use it to
   * commit a concurrent increment at exactly the point that used to be a lost update.
   */
  afterRead?: () => Promise<void>;
  /** Bound on the compare-and-set retry loop; the default is the request path's policy. */
  deadlineMs?: number;
  /** Retry pacing. Injected in tests so a doomed attempt does not sleep. */
  delay?: () => Promise<void>;
  /** Where a trace that could not be settled is reported. */
  warn?: (message: string) => void;
}

/**
 * Writes `verified` onto BOTH denormalised snapshots as ONE compare-and-set, keyed on the
 * versionstamp of each.
 *
 * The plain `kv.set` this replaces was an unchecked read-modify-write: a live hit's `logHit`
 * committing an increment between our read and our write had that `+1` silently rolled back
 * by the write that followed (ua-tracer-5ub) - the same loss the repair pass exists to fix,
 * arriving from the other direction. The two copies were also written separately, so they
 * could disagree with each other. A failed check means a concurrent write won, so the
 * attempt re-reads and folds `verified` on top of the NEW count instead of the old one.
 *
 * A key that does not exist is not written - the old code skipped it too - but it is still
 * CHECKED for absence, so a snapshot created concurrently is not overwritten blindly either.
 *
 * This mirrors `casRetry`'s shape rather than calling it, for two reasons: casRetry reports
 * and swallows its own give-up, so a caller cannot count what it failed to settle; and this
 * change is deliberately confined to one file while other lanes edit the hit path.
 */
async function settleSnapshots(
  kv: Deno.Kv,
  rKey: Deno.KvKey,
  uKey: Deno.KvKey,
  verified: BotVerification | null,
  opts: Required<BackfillVerifiedOptions>,
): Promise<boolean> {
  const started = performance.now();
  for (;;) {
    const [rCur, uCur] = await Promise.all([
      kv.get<TraceStats>(rKey),
      kv.get<TraceStats>(uKey),
    ]);
    await opts.afterRead();
    // Nothing to mirror: both snapshots are already gone.
    if (!rCur.value && !uCur.value) return true;
    let at = kv.atomic()
      .check({ key: rKey, versionstamp: rCur.versionstamp })
      .check({ key: uKey, versionstamp: uCur.versionstamp });
    if (rCur.value) at = at.set(rKey, { ...rCur.value, verified });
    if (uCur.value) at = at.set(uKey, { ...uCur.value, verified });
    if ((await at.commit()).ok) return true;
    if (performance.now() - started > opts.deadlineMs) return false;
    await opts.delay();
  }
}

export async function runBackfillVerified(
  kv: Deno.Kv,
  options: BackfillVerifiedOptions = {},
): Promise<BackfillVerifiedResult> {
  const opts: Required<BackfillVerifiedOptions> = {
    afterRead: options.afterRead ?? (async () => {}),
    deadlineMs: options.deadlineMs ?? CAS_DEADLINE_MS,
    delay: options.delay ??
      (() => new Promise((r) => setTimeout(r, 1 + Math.random() * 7))),
    warn: options.warn ?? ((message: string) => console.warn(message)),
  };
  let scanned = 0;
  let updated = 0;
  let unsettled = 0;
  let unprovenanced = 0;
  let withheldVerified = 0;
  const tally = new Map<string, number>();

  console.log('backfill-verified: streaming ["trace"] records…');
  for await (const entry of kv.list<TraceRecord>({ prefix: ["trace"] })) {
    scanned++;
    const t = entry.value;
    if (!t || !t.id || typeof t.ts !== "number") continue;

    // The verdict may only be minted from an address the client could not write. The
    // claimed bot family is worth naming either way, so the classification is still made —
    // it is its `verified` state that is not ours to publish for an unprovenanced address.
    const source = storedIpSource(t);
    const classified: BotVerification | null = await classifyBot(t.ip ?? "", t.ua ?? "");
    let result = classified;
    if (classified && source !== "peer") {
      unprovenanced++;
      if (classified.status === "verified") withheldVerified++;
      if (classified.status !== "unverifiable") {
        // "unverifiable", deliberately not "unverified": the address was not checked, and
        // saying "unverified" would accuse the UA of spoofing an address we never trusted.
        result = {
          bot: classified.bot,
          status: "unverifiable",
          note: source === "unknown"
            ? `no client address was recorded for this trace, so ${classified.bot} ranges could not be checked`
            : `the recorded client address came from a forwarding header, which the client writes, so ${classified.bot} ranges were not checked against it`,
        };
      }
    }
    const label = result ? `${result.status} ${result.bot}` : "(not a bot)";
    tally.set(label, (tally.get(label) ?? 0) + 1);

    // 1. trace record
    await kv.set(["trace", t.id], { ...t, verified: result });

    // 2/3. Both denormalised snapshots, in ONE compare-and-set (ua-tracer-5ub).
    const rKey = recentIndexKey(t.ts, t.id);
    const uKey = uaIndexKey(t.ua, t.ts, t.id);
    if (!await settleSnapshots(kv, rKey, uKey, result, opts)) {
      unsettled++;
      opts.warn(
        `[backfill-verified] ${t.id}: the recent/UA snapshots did not settle within ` +
          `${opts.deadlineMs}ms - a concurrent write kept winning, so this trace's record ` +
          `has \`verified\` but its snapshots do not; re-run this backfill to fold it in.`,
      );
    }

    updated++;
    if (scanned % 250 === 0) {
      console.log(`  …${scanned} scanned, ${updated} updated`);
    }
  }

  console.log(
    `backfill-verified: done. ${scanned} traces scanned, ${updated} updated with a \`verified\` field.`,
  );
  if (unsettled > 0) {
    console.log(
      `backfill-verified: ${unsettled} trace snapshot(s) did not settle (see the warnings above).`,
    );
  }
  console.log("classification breakdown:");
  [...tally.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) =>
    console.log(`  ${n.toString().padStart(5)}  ${k}`)
  );
  if (unprovenanced > 0) {
    console.log(
      `backfill-verified: ${unprovenanced} claimed-bot trace(s) had no address the client could not ` +
        `have written, so no verdict was minted from it - ${withheldVerified} of them would have ` +
        `been classified "verified" from the stored address and were withheld instead.`,
    );
  }

  return {
    scanned,
    updated,
    unsettled,
    unprovenanced,
    withheldVerified,
    tally: Object.fromEntries(tally),
  };
}

if (import.meta.main) {
  const result = await runBackfillVerified(await getKv());
  // Same contract as `backfill`: a run that could not be shown to settle exits non-zero, so
  // an operator notices instead of reading a success line over a partial mirror.
  if (result.unsettled > 0) {
    console.error(
      `backfill-verified: FAILED - ${result.unsettled} trace snapshot(s) did not settle; ` +
        `re-run to fold them in.`,
    );
    Deno.exit(1);
  }
}
