// The snapshot repair pass, on a schedule (ua-tracer-2t9).
//
// WHY THIS EXISTS: `deno task backfill` repairs a count that a lost CAS update left
// short, and ua-tracer-plx made that possible - but nothing RAN it. A repair that has to
// be remembered by hand is not a repair. Measured on this codebase, a 384-way concurrent
// burst on one trace produced 384 records and only 63 increments (321 give-ups, each
// after 39 attempts against the 2s deadline), so short counts are a real state under
// load, not a theoretical one.
//
// HOW IT RUNS: Deno Deploy discovers `Deno.cron()` definitions by evaluating the entry
// module's top-level code at deployment time, then schedules and invokes them, handles
// retries, and surfaces runs (and failures) in the dashboard and logs. Nothing here
// keeps a process alive, and each execution bills as one inbound HTTP request.
//
// ON THE OFF SWITCH, which is the part that could quietly ruin this feature: the
// registration is called from server.ts under `if (import.meta.main)`. A test suite that
// imports server.ts is NOT the entry module, so `import.meta.main` is false and the
// registration cannot happen at all - test processes are structurally INCAPABLE of
// registering the job, rather than usually-harmless. In production server.ts IS the
// entry module, and its top-level code is exactly what Deploy evaluates, so the guard
// does not hide the job from discovery. (A guard inside this file would: `import.meta.main`
// is only true for the entry module, never for a module that imports it, so the job
// would silently never register.)
//
// ON WHERE PRODUCTION IS - stated, not assumed: Deno Deploy binds every environment
// variable to a CONTEXT, and ships two by default - Production (the production timeline)
// and Development (preview and branch timelines). This job runs only where
// `UA_TRACER_CRON=1` exists, and that variable is set in the Production context only, so
// a `fleet/*` or preview timeline never fires it. That is a configuration signal rather
// than a platform guarantee, which is exactly why the health report below exists: if the
// variable is missing in production the job is inert, and /api/health says so.

import { type BackfillResult, runBackfill } from "./backfill.ts";

export const REPAIR_CRON_NAME = "ua-tracer-snapshot-repair";
/** The variable that gates both registration and the health expectation, so the two
 *  cannot disagree. It belongs in Deno Deploy's Production context only. */
export const REPAIR_ENV_VAR = "UA_TRACER_CRON";
/** Hourly. The pass defers traces hit inside the settle window, so an hourly run repairs
 *  everything that has settled; the platform prevents overlapping executions and skips a
 *  due run while one is still going, so a slow pass cannot stack up. */
export const REPAIR_CRON_SCHEDULE = "0 * * * *";
/** Older than this and the schedule is reported as FAILING, not merely old: two missed
 *  hourly runs, or a job that has never run where it is expected, is the signal. */
export const REPAIR_STALE_AFTER_MS = 150 * 60 * 1000;
export const REPAIR_STATUS_KEY: Deno.KvKey = ["repair", "last"];

export interface RepairStatus {
  /** when the run finished, ms since epoch */
  ts: number;
  /** how long the pass took, ms */
  durationMs: number;
  scanned: number;
  written: number;
  rebuilt: number;
  upgraded: number;
  aggregates: number;
  deferred: number;
  unsettled: number;
  /** a short message when the pass failed. Bounded, because /api/health is public. */
  error?: string;
}

export interface RepairHealth {
  /** the job is expected to run in this context (the Production-only variable is set) */
  expected: boolean;
  /** expected but not running on time - the case that must not look healthy */
  stale: boolean;
  /** "ok" | "never-ran" | "stale" | "error", for a reader that wants one word */
  status: string;
  schedule: string;
  /** the last run's finish time, or null if it has never run here */
  lastRun: number | null;
  ageMs: number | null;
  unsettled: number;
  error: string | null;
}

function bounded(value: unknown): string {
  return String((value as Error)?.message ?? value).slice(0, 200);
}

/**
 * Run the repair pass once and record what happened, so the outcome is readable from
 * outside the process. The CLI's failure contract (`backfillExitCode`, `Deno.exit`) is
 * deliberately NOT reused here: there is no shell to observe an exit code, so the result
 * is stored and logged instead, and an unsettled run is thrown by the handler below to
 * mark the execution as an Error in the Deploy dashboard.
 */
export async function runRepairPass(
  kv: Deno.Kv,
  opts: {
    backfill?: (kv: Deno.Kv) => Promise<BackfillResult>;
    now?: () => number;
    log?: (line: string) => void;
  } = {},
): Promise<RepairStatus> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((line: string) => console.log(line));
  const started = performance.now();
  let status: RepairStatus;
  try {
    const result = await (opts.backfill ?? ((k: Deno.Kv) => runBackfill(k)))(kv);
    status = {
      ts: now(),
      durationMs: Math.round(performance.now() - started),
      scanned: result.scanned,
      written: result.written,
      rebuilt: result.rebuilt,
      upgraded: result.upgraded,
      aggregates: result.aggregates,
      deferred: result.deferred,
      unsettled: result.unsettled,
    };
  } catch (err) {
    // A failed pass is recorded BEFORE it is thrown, so /api/health keeps the evidence
    // even though the platform marks the execution as an error.
    status = {
      ts: now(),
      durationMs: Math.round(performance.now() - started),
      scanned: 0,
      written: 0,
      rebuilt: 0,
      upgraded: 0,
      aggregates: 0,
      deferred: 0,
      unsettled: 0,
      error: bounded(err),
    };
  }
  await kv.set(REPAIR_STATUS_KEY, status);
  log(
    `[cron] snapshot repair ${status.error ? "failed" : "finished"}: ` +
      `${status.scanned} scanned, ${status.written} written, ${status.rebuilt} rebuilt, ` +
      `${status.unsettled} unsettled, ${status.durationMs}ms` +
      (status.error ? `, error: ${status.error}` : ""),
  );
  return status;
}

/** What /api/health reports about the schedule. Never throws: a health endpoint that can
 *  fail because the thing it reports on is broken would be the wrong shape. */
export async function repairHealth(
  kv: Deno.Kv,
  opts: { now?: () => number; env?: { get(name: string): string | undefined } } = {},
): Promise<RepairHealth> {
  const now = (opts.now ?? (() => Date.now()))();
  const env = opts.env ?? Deno.env;
  const expected = env.get(REPAIR_ENV_VAR) === "1";
  const base = {
    expected,
    schedule: REPAIR_CRON_SCHEDULE,
    lastRun: null as number | null,
    ageMs: null as number | null,
    unsettled: 0,
    error: null as string | null,
  };
  let status: RepairStatus | null = null;
  try {
    status = (await kv.get<RepairStatus>(REPAIR_STATUS_KEY)).value;
  } catch (err) {
    // Report the read failure rather than 500ing: an unreadable status is not the same
    // as a healthy one, and `expected` decides whether it counts as a failure.
    return { ...base, stale: expected, status: "unreadable", error: bounded(err) };
  }
  if (!status) {
    // A run that never happened is the failure a plain timestamp cannot express, so it
    // is its own state. A fresh deployment reports this until the first hourly run, and
    // that is intentional: it is the signal that the job is not firing.
    return { ...base, stale: expected, status: "never-ran" };
  }
  const ageMs = Math.max(0, now - status.ts);
  const stale = expected && ageMs > REPAIR_STALE_AFTER_MS;
  return {
    expected,
    stale,
    status: status.error ? "error" : stale ? "stale" : "ok",
    schedule: REPAIR_CRON_SCHEDULE,
    lastRun: status.ts,
    ageMs,
    unsettled: status.unsettled,
    // Bounded on the way OUT as well: this endpoint is public, and a record written by
    // an older version (or by hand) must not be able to widen what it exposes.
    error: status.error ? bounded(status.error) : null,
  };
}

export interface CronRegistration {
  registered: boolean;
  reason: string;
}

/**
 * Register the scheduled repair. `cron` and `env` are injectable so the decision can be
 * tested without a platform that has the API; in production they are the real globals.
 *
 * `Deno.cron` is a Deploy-only API - it is absent from the local runtime (absent on Deno
 * 2.9.7), so it is reached dynamically rather than as a bare global, and a bare call
 * would break `deno run server.ts` locally.
 */
export function registerRepairCron(
  opts: {
    kv?: () => Promise<Deno.Kv>;
    env?: { get(name: string): string | undefined };
    log?: (line: string) => void;
    cron?: (name: string, schedule: string, handler: () => Promise<void>) => unknown;
    /** the pass itself, injectable so the handler's own behaviour can be tested */
    backfill?: (kv: Deno.Kv) => Promise<BackfillResult>;
  } = {},
): CronRegistration {
  const env = opts.env ?? Deno.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const cron = opts.cron ??
    (Deno as unknown as {
      cron?: (name: string, schedule: string, handler: () => Promise<void>) => unknown;
    }).cron;

  if (env.get(REPAIR_ENV_VAR) !== "1") {
    return {
      registered: false,
      reason:
        `${REPAIR_ENV_VAR} is not 1 in this context (it is set in the Production context only)`,
    };
  }
  if (typeof cron !== "function") {
    return {
      registered: false,
      reason: "Deno.cron is not available in this runtime (it is a Deno Deploy API)",
    };
  }
  const getKv = opts.kv ?? (async () => (await import("./storage.ts")).getKv());
  try {
    cron(REPAIR_CRON_NAME, REPAIR_CRON_SCHEDULE, async () => {
      const status = await runRepairPass(await getKv(), { backfill: opts.backfill });
      // An unsettled run means the pass could not converge (a writer kept moving the
      // snapshot). Throw so the platform records an Error, which is visible in the
      // dashboard; the counts are already stored for /api/health.
      if (status.error || status.unsettled > 0) {
        throw new Error(
          `snapshot repair left ${status.unsettled} unsettled trace(s)${
            status.error ? `: ${status.error}` : ""
          }`,
        );
      }
    });
    log(`[cron] ${REPAIR_CRON_NAME} scheduled (${REPAIR_CRON_SCHEDULE})`);
    return { registered: true, reason: "registered" };
  } catch (err) {
    // Never let scheduling take the app down: a job that cannot register is a health
    // problem (the health report will say never-ran), not a reason to fail serving.
    return { registered: false, reason: `Deno.cron rejected the registration: ${bounded(err)}` };
  }
}
