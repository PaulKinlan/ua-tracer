// The scheduled snapshot repair pass (ua-tracer-2t9): the registration guards, the
// recorded outcome, and what /api/health reports about it.
//
// These tests run in a runtime WITHOUT `Deno.cron` (it is a Deno Deploy API - absent on
// local Deno 2.9.7), which is exactly the condition that must not break anything: the
// absence is handled, and the tests prove the decision rather than the platform.

import { clearKv, req, testKv } from "./testenv.ts";
import { handler } from "../server.ts";
import {
  registerRepairCron,
  REPAIR_ENV_VAR,
  REPAIR_STALE_AFTER_MS,
  REPAIR_STATUS_KEY,
  repairHealth,
  type RepairStatus,
  runRepairPass,
} from "../crons.ts";
import type { BackfillResult } from "../backfill.ts";

const EMPTY_RESULT: BackfillResult = {
  scanned: 0,
  written: 0,
  rebuilt: 0,
  upgraded: 0,
  aggregates: 0,
  deferred: 0,
  unsettled: 0,
};

function fakeEnv(values: Record<string, string> = {}) {
  return { get: (name: string) => values[name] };
}

/** Run `body` with the gate variable set, restoring the environment afterwards. */
async function withEnv(value: string | null, body: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get(REPAIR_ENV_VAR);
  try {
    if (value === null) Deno.env.delete(REPAIR_ENV_VAR);
    else Deno.env.set(REPAIR_ENV_VAR, value);
    await body();
  } finally {
    if (previous === undefined) Deno.env.delete(REPAIR_ENV_VAR);
    else Deno.env.set(REPAIR_ENV_VAR, previous);
  }
}

Deno.test("the job cannot be registered from a test process, by construction", () => {
  // This module is not the entry module, so server.ts's `if (import.meta.main)` block
  // never runs here. That is the structural guarantee, and it is why the registration
  // lives in the entry module rather than in crons.ts (where import.meta.main would be
  // false in production too, and the job would silently never register).
  if (import.meta.main) throw new Error("a test suite is the entry module?");

  // The structural half of this - that the registration really is inside server.ts's
  // `import.meta.main` block - is asserted in tests/gate_mapping_test.ts, which has the
  // read permission this suite deliberately lacks.

  // And in THIS runtime the Deploy-only API is absent, which must be a reason, not a
  // crash: `deno run server.ts` locally has to keep working.
  const registration = registerRepairCron({ env: fakeEnv({ [REPAIR_ENV_VAR]: "1" }) });
  if (registration.registered) throw new Error("registered without a Deno.cron API");
  if (!registration.reason.includes("Deno Deploy")) {
    throw new Error(`the reason should name the platform: ${registration.reason}`);
  }
});

Deno.test("registration is skipped outside production, and happens inside it", () => {
  // Production is detected by a variable that Deno Deploy scopes to the Production
  // context only, so a preview or fleet/* timeline does not have it.
  const skipped = registerRepairCron({ env: fakeEnv(), cron: () => {} });
  if (skipped.registered) throw new Error("registered without the production variable");
  if (!skipped.reason.includes("Production")) {
    throw new Error(`the reason should name the context: ${skipped.reason}`);
  }

  const scheduled: Array<{ name: string; schedule: string }> = [];
  const ok = registerRepairCron({
    env: fakeEnv({ [REPAIR_ENV_VAR]: "1" }),
    kv: () => testKv(),
    log: () => {},
    cron: (name, schedule) => {
      scheduled.push({ name, schedule });
    },
  });
  if (!ok.registered) throw new Error(`did not register: ${ok.reason}`);
  if (scheduled.length !== 1) throw new Error(`registered ${scheduled.length} jobs`);
  if (scheduled[0].schedule !== "0 * * * *") throw new Error(`schedule ${scheduled[0].schedule}`);
});

Deno.test("a run is recorded, and an unsettled run marks its execution as an error", async () => {
  await clearKv();
  const kv = await testKv();
  const logged: string[] = [];

  // The happy path: the pass's counts land in the status record.
  const status = await runRepairPass(kv, {
    backfill: () => Promise.resolve({ ...EMPTY_RESULT, scanned: 7, written: 3, unsettled: 0 }),
    log: (line) => logged.push(line),
  });
  if (status.scanned !== 7 || status.written !== 3) {
    throw new Error(`status ${JSON.stringify(status)}`);
  }
  const stored = (await kv.get<RepairStatus>(REPAIR_STATUS_KEY)).value;
  if (!stored || stored.scanned !== 7) throw new Error("the run was not recorded");
  if (!logged.length) throw new Error("the run was not logged");

  // A failing pass is recorded BEFORE it is thrown, so the evidence survives.
  const failed = await runRepairPass(kv, {
    backfill: () => Promise.reject(new Error("kv exploded")),
    log: (line) => logged.push(line),
  });
  if (failed.error !== "kv exploded") {
    throw new Error(`error not recorded: ${JSON.stringify(failed)}`);
  }

  // The handler turns a non-converging pass into a platform Error (the dashboard
  // visible signal), while /api/health keeps the counts.
  const holder: { run?: () => Promise<void> } = {};
  registerRepairCron({
    env: fakeEnv({ [REPAIR_ENV_VAR]: "1" }),
    kv: () => testKv(),
    log: () => {},
    backfill: () => Promise.resolve({ ...EMPTY_RESULT, unsettled: 2 }),
    cron: (_name, _schedule, fn) => {
      holder.run = fn;
    },
  });
  if (!holder.run) throw new Error("no handler was registered");
  let threw = false;
  try {
    await holder.run();
  } catch (err) {
    threw = true;
    if (!(err as Error).message.includes("unsettled")) throw new Error((err as Error).message);
  }
  if (!threw) throw new Error("an unsettled run did not mark the execution as an error");
});

Deno.test("health reports a never-ran or stale schedule as a failure, and stays secret-free", async () => {
  await clearKv();
  const kv = await testKv();
  const now = 1_000_000_000_000;
  const env = fakeEnv({ [REPAIR_ENV_VAR]: "1" });

  // Never ran, where it is expected: a failure, not a missing field.
  const neverRan = await repairHealth(kv, { now: () => now, env });
  if (!neverRan.stale || neverRan.status !== "never-ran") {
    throw new Error(`never-ran not reported as a failure: ${JSON.stringify(neverRan)}`);
  }

  // A fresh run is healthy.
  await kv.set(
    REPAIR_STATUS_KEY,
    { ...EMPTY_RESULT, ts: now - 1000, durationMs: 5 } as RepairStatus,
  );
  const fresh = await repairHealth(kv, { now: () => now, env });
  if (fresh.stale || fresh.status !== "ok") {
    throw new Error(`fresh run looked stale: ${JSON.stringify(fresh)}`);
  }

  // Older than the window: stale, and it says so in one word.
  await kv.set(REPAIR_STATUS_KEY, {
    ...EMPTY_RESULT,
    ts: now - REPAIR_STALE_AFTER_MS - 1,
    durationMs: 5,
  } as RepairStatus);
  const old = await repairHealth(kv, { now: () => now, env });
  if (!old.stale || old.status !== "stale") {
    throw new Error(`stale run looked fine: ${JSON.stringify(old)}`);
  }

  // The same stale record is NOT a failure where the job is not expected to run, so
  // local dev and the gate are not permanently unhealthy.
  const notExpected = await repairHealth(kv, { now: () => now, env: fakeEnv() });
  if (notExpected.stale) throw new Error("a context without the job reported a failure");

  // A failed run is visible as an error, and the message is bounded because this
  // endpoint is public.
  await kv.set(REPAIR_STATUS_KEY, {
    ...EMPTY_RESULT,
    ts: now,
    durationMs: 5,
    error: "x".repeat(500),
  } as RepairStatus);
  const errored = await repairHealth(kv, { now: () => now, env });
  if (errored.status !== "error" || !errored.error) throw new Error(JSON.stringify(errored));
  if (errored.error.length > 200) {
    throw new Error(`the error message is not bounded: ${errored.error.length}`);
  }

  // Nothing beyond the documented, non-secret fields is exposed - no trace ids, no
  // keys, no raw error objects.
  const allowed = new Set([
    "expected",
    "stale",
    "status",
    "schedule",
    "lastRun",
    "ageMs",
    "unsettled",
    "error",
  ]);
  for (const key of Object.keys(errored)) {
    if (!allowed.has(key)) throw new Error(`unexpected field in the health report: ${key}`);
  }
});

Deno.test("/api/health carries the repair report and goes not-ok when the schedule stops", async () => {
  await clearKv();
  await withEnv(null, async () => {
    const body = await (await handler(req("/api/health"))).json();
    if (body.ok !== true) throw new Error(`off-platform health is not ok: ${JSON.stringify(body)}`);
    if (!body.repair || body.repair.expected !== false) {
      throw new Error(`repair report missing or wrong: ${JSON.stringify(body.repair)}`);
    }
  });

  await withEnv("1", async () => {
    const res = await handler(req("/api/health"));
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const body = await res.json();
    // Expected but never run: the endpoint must not look healthy.
    if (body.ok !== false) {
      throw new Error(`a missing schedule looked healthy: ${JSON.stringify(body)}`);
    }
    if (body.repair.status !== "never-ran" || body.repair.expected !== true) {
      throw new Error(`repair report wrong: ${JSON.stringify(body.repair)}`);
    }
    // Additive: the fields that were already there are untouched.
    if (typeof body.ts !== "number" || !("build" in body)) {
      throw new Error(`the health contract changed: ${JSON.stringify(body)}`);
    }
  });
});
