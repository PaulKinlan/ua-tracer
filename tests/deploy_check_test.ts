// Hermetic tests for deploy-check.ts (ua-tracer-ajc).
//
// The tool exists to answer "is a newer revision serving?" without a human reading /api/health, so
// its answers have to hold when the payload is wrong in each of the ways the platform can be wrong:
// a build key present, `"build":null`, no build key at all, and a response that cannot be read.
// All of them are driven here as fake responses - this suite never opens a socket (the fast suites
// run without --allow-net), which is why `check` takes its fetch, clock, sleep and log as arguments
// instead of reaching for the globals.
//
// The four readings are also what the exit code has to distinguish: 0 only for a present key, 1 for
// everything not confirmed (UNCHANGED / NOT-ROLLED / UNKNOWN), 2 for a usage error. The exit code is
// asserted through verdict(), which is the whole of the mapping from samples to code; spawning
// `deno run` would need --allow-run, which this tier deliberately does not have.

import { check, formatSample, parseArgs, readHealth, verdict } from "../deploy-check.ts";

const AT = "2026-10-13T00:30:00.000Z";

/** A `fetchImpl` that answers a fixed script, one entry per call; the last entry repeats. */
function fakeFetch(script: Array<{ status?: number; body?: string; fail?: string }>) {
  let call = 0;
  return () => {
    const step = script[Math.min(call++, script.length - 1)];
    if (step.fail !== undefined) return Promise.reject(new Error(step.fail));
    return Promise.resolve(new Response(step.body ?? "", { status: step.status ?? 200 }));
  };
}

/** A `check` harness whose clock, sleep and log are visible, so the loop is observable. */
function harness(script: Array<{ status?: number; body?: string; fail?: string }>) {
  const lines: string[] = [];
  const slept: number[] = [];
  let ticks = 0;
  const run = (extra: { samples?: number; expected?: string | null; intervalMs?: number } = {}) =>
    check({
      url: "https://example.test/api/health",
      samples: extra.samples ?? 2,
      intervalMs: extra.intervalMs ?? 1000,
      expected: extra.expected ?? null,
      fetchImpl: fakeFetch(script),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      now: () => new Date(Date.parse(AT) + ticks++),
      log: (line) => lines.push(line),
    });
  return { run, lines, slept };
}

Deno.test("a build key is read as the id, and null / absent / unreadable stay apart", () => {
  const present = readHealth(200, '{"ok":true,"ts":1791850563652,"build":"we36vky3stwt"}', AT);
  if (present.reading !== "present" || present.build !== "we36vky3stwt") {
    throw new Error(`a present build key was read as ${JSON.stringify(present)}`);
  }

  const nullable = readHealth(200, '{"ok":true,"ts":1,"build":null}', AT);
  if (nullable.reading !== "null" || nullable.build !== null) {
    throw new Error(`"build":null was read as ${JSON.stringify(nullable)}`);
  }

  // The payload a revision older than the field sends: a valid response with no build key. This is
  // the shape ua-tracer-3m1 sampled all night, and it must not be confused with an unreadable one.
  const absent = readHealth(200, '{"ok":true,"ts":1,"repair":{"status":"never-ran"}}', AT);
  if (absent.reading !== "absent") {
    throw new Error(`a payload without a build key was read as ${absent.reading}`);
  }

  for (
    const [how, status, body] of [
      ["an error status", 500, '{"ok":false}'],
      ["a non-200 with a proxy page", 502, "<html>bad gateway</html>"],
      ["an empty body", 200, ""],
      ["a body that is not JSON", 200, "ok"],
      ["a JSON array", 200, "[1,2,3]"],
      ["a JSON null", 200, "null"],
      ["a non-string build", 200, '{"build":42}'],
      ["an empty-string build", 200, '{"build":""}'],
    ] as const
  ) {
    const sample = readHealth(status, body, AT);
    if (sample.reading !== "unreadable") {
      throw new Error(`${how} was read as ${sample.reading}, not unreadable`);
    }
    if (sample.build !== null) throw new Error(`${how} produced a build id`);
  }
});

Deno.test("the loop prints one evidence line per sample and sums them up", async () => {
  const { run, lines, slept } = harness([
    { body: '{"ok":true,"ts":1}' },
    { body: '{"ok":true,"ts":2,"build":"we36vky3stwt"}' },
  ]);
  const result = await run();
  if (result.label !== "PRESENT" || result.code !== 0) {
    throw new Error(`expected PRESENT/0, got ${result.label}/${result.code}: ${result.reason}`);
  }
  if (lines.length !== 4) throw new Error(`expected 2 samples + verdict + note, got: ${lines}`);
  if (!/^\[2026-10-13T00:30:00\.000Z\] sample 1\/2 http 200 build=absent/.test(lines[0])) {
    throw new Error(`the first evidence line is not what it should be: ${lines[0]}`);
  }
  if (!lines[1].includes("build=we36vky3stwt")) {
    throw new Error(`the second evidence line lost the build id: ${lines[1]}`);
  }
  if (!lines[2].startsWith("VERDICT: PRESENT")) {
    throw new Error(`no verdict line: ${lines[2]}`);
  }
  if (slept.join(",") !== "1000") {
    throw new Error(`the pause between samples was not the interval: ${slept.join(",")}`);
  }
  if (lines[1].startsWith(lines[0])) {
    throw new Error("the sample timestamps did not advance");
  }
});

Deno.test("the run is not claimed to prove more than a build key can", async () => {
  const { run, lines } = harness([{ body: '{"build":"we36vky3stwt"}' }]);
  await run({ samples: 1 });
  const note = lines[lines.length - 1];
  for (const claim of ["does NOT name the git commit", "predates the build field"]) {
    if (!note.includes(claim)) {
      throw new Error(`the run no longer says "${claim}": ${note}`);
    }
  }
});

Deno.test("--expect turns a present key into CHANGED or UNCHANGED, never a guess", async () => {
  const unchanged = await harness([{ body: '{"build":"aaa"}' }]).run({
    samples: 1,
    expected: "aaa",
  });
  if (unchanged.label !== "UNCHANGED" || unchanged.code !== 1) {
    throw new Error(`same build as --expect must be UNCHANGED/1, got ${unchanged.label}`);
  }

  const changed = await harness([
    { body: '{"ts":1}' },
    { body: '{"build":"bbb"}' },
  ]).run({ samples: 2, expected: "aaa" });
  if (changed.label !== "CHANGED" || changed.code !== 0) {
    throw new Error(`a different build must be CHANGED/0, got ${changed.label}`);
  }
});

Deno.test("no build key on a readable payload is NOT-ROLLED; nothing readable is UNKNOWN", async () => {
  const stuck = await harness([{ body: '{"ok":true,"build":null}' }]).run({
    samples: 1,
    expected: "aaa",
  });
  if (stuck.label !== "NOT-ROLLED" || stuck.code !== 1) {
    throw new Error(`a null build must be NOT-ROLLED/1, got ${stuck.label}/${stuck.code}`);
  }

  const blank = harness([{ body: "" }]);
  const unknown = await blank.run({ samples: 1, expected: "aaa" });
  if (unknown.label !== "UNKNOWN" || unknown.code !== 1) {
    throw new Error(`an unreadable payload must be UNKNOWN/1, got ${unknown.label}`);
  }
  if (!blank.lines[0].includes("build=unreadable")) {
    throw new Error(`the evidence line hid the reading: ${blank.lines[0]}`);
  }

  // A failing request is a reading, not a crash, and it must not be reported as "the old revision
  // answered" - that would be the one wrong answer this tool can give.
  const down = harness([{ fail: "connection refused" }]);
  const unreachable = await down.run({ samples: 1 });
  if (unreachable.label !== "UNKNOWN" || !unreachable.reason.includes("not evidence")) {
    throw new Error(`a failed fetch became ${unreachable.label}: ${unreachable.reason}`);
  }
  if (!down.lines[0].includes("connection refused")) {
    throw new Error(`the failure reason is missing from the evidence: ${down.lines[0]}`);
  }

  // One readable sample without a key is enough to say NOT-ROLLED even if others could not be read.
  const mixed = await harness([{ fail: "timeout" }, { body: '{"ok":true,"build":null}' }]).run({
    samples: 2,
  });
  if (mixed.label !== "NOT-ROLLED") {
    throw new Error(`a readable null sample must decide NOT-ROLLED, got ${mixed.label}`);
  }
});

Deno.test("the answers a caller can get are exactly these five states", () => {
  const sample = (reading: "present" | "null" | "absent" | "unreadable", build: string | null) => ({
    at: AT,
    status: 200,
    build,
    reading,
  });
  for (
    const [expected, samples, label, code] of [
      [null, [sample("present", "aaa")], "PRESENT", 0],
      ["aaa", [sample("present", "aaa")], "UNCHANGED", 1],
      ["aaa", [sample("present", "bbb")], "CHANGED", 0],
      [null, [sample("absent", null)], "NOT-ROLLED", 1],
      ["aaa", [sample("null", null)], "NOT-ROLLED", 1],
      [null, [sample("unreadable", null)], "UNKNOWN", 1],
      [null, [], "UNKNOWN", 1],
    ] as const
  ) {
    const result = verdict(samples as never, expected);
    if (result.label !== label || result.code !== code) {
      throw new Error(
        `expected ${label}/${code}, got ${result.label}/${result.code}: ${result.reason}`,
      );
    }
  }
  if (verdict([], null).code === 0) throw new Error("an empty sample set must not exit 0");
});

Deno.test("the loop cannot be asked for an unbounded wait", () => {
  const defaults = parseArgs([]);
  if ("error" in defaults) throw new Error(`no arguments must be accepted: ${defaults.error}`);
  if (defaults.args.samples !== 5 || defaults.args.intervalMs !== 5000) {
    throw new Error(`the defaults moved: ${JSON.stringify(defaults.args)}`);
  }
  if (defaults.args.expected !== null) throw new Error("--expect must default to unset");

  const fine = parseArgs(["--samples", "4", "--interval", "0.5", "--expect", "abc"]);
  if ("error" in fine) throw new Error(`a valid call was refused: ${fine.error}`);
  if (fine.args.samples !== 4 || fine.args.intervalMs !== 500 || fine.args.expected !== "abc") {
    throw new Error(`a valid call was misread: ${JSON.stringify(fine.args)}`);
  }

  for (
    const bad of [
      ["--samples", "0"],
      ["--samples", "31"],
      ["--samples", "3.5"],
      ["--samples", "30", "--interval", "60"],
      ["--interval", "-1"],
      ["--interval", "61"],
      ["--interval", "nope"],
      ["--expect"],
      ["--url"],
      ["--nonsense"],
    ] as const
  ) {
    const parsed = parseArgs([...bad]);
    if (!("error" in parsed)) {
      throw new Error(`${bad.join(" ")} was accepted: ${JSON.stringify(parsed)}`);
    }
  }
});

Deno.test("formatSample is the line a lane pastes into a bead", () => {
  const present = formatSample(
    { at: AT, status: 200, build: "we36vky3stwt", reading: "present" },
    2,
    5,
  );
  if (present !== `[${AT}] sample 2/5 http 200 build=we36vky3stwt`) {
    throw new Error(`the evidence line changed shape: ${present}`);
  }
  const dead = formatSample(
    {
      at: AT,
      status: 0,
      build: null,
      reading: "unreadable",
      note: "request failed: connection refused",
    },
    1,
    1,
  );
  if (!dead.includes("no-response") || !dead.includes("(request failed: connection refused)")) {
    throw new Error(`a failed request is not identifiable in the evidence line: ${dead}`);
  }
});
