// Guard for the affected-path dispatcher (`tools/fast-gate.sh`).
//
// A dispatcher that silently maps nothing (or maps the wrong thing) is worse than
// no dispatcher: it produces a green verdict about a subset nobody chose. These
// tests drive the real script, so what is asserted is the behaviour of the gate
// itself — every tracked file maps to a suite, an unmapped file in the delta fails
// the gate closed, and the full tier really is a superset of the affected tier.
//
// Permissions: this suite is run by its own deno task
// (`deno task test:guards`) with --allow-env --allow-read --allow-write=.
// --allow-run=git,bash,deno, because it shells out to git, to the gate script,
// and (from ua-tracer-ha5) to the fmt check itself - as `deno task fmt:check`, from
// ua-tracer-hae, so it measures the command the gate runs. The other suites stay
// permission-tight.

const repoRoot = Deno.realPathSync(new URL("..", import.meta.url));

// The three suites that are not part of the affected (fast) tier: the gate guards run on every
// invocation whatever the delta, and the browser journey is full-only.
const NON_FAST_SUITES = [
  "tests/gate_mapping_test.ts",
  "tests/gate_config_test.ts",
  "tests/browser_journey_test.ts",
];

async function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("bash", {
    args: ["tools/fast-gate.sh", ...args],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) };
}

function lines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

function suites(args: string[]): Promise<string[]> {
  return run(args).then((r) => lines(r.stdout));
}

Deno.test("every tracked file is mapped, or explicitly requires the full gate", async () => {
  const tracked = await new Deno.Command("git", {
    args: ["ls-files"],
    cwd: repoRoot,
    stdout: "piped",
  }).output();
  const files = lines(new TextDecoder().decode(tracked.stdout));
  if (files.length < 8) throw new Error(`git ls-files returned only ${files.length} files`);

  const unmapped: string[] = [];
  const missing: string[] = [];
  for (const file of files) {
    const r = await run(["--map", file]);
    if (r.code === 2) {
      unmapped.push(file);
      continue;
    }
    if (r.code !== 0) throw new Error(`--map ${file} exited ${r.code}: ${r.stderr.trim()}`);
    for (const suite of lines(r.stdout)) {
      // A mapping arm pointing at a suite that does not exist would pass the
      // gate by running nothing.
      try {
        await Deno.stat(`${repoRoot}/${suite}`);
      } catch {
        missing.push(`${file} -> ${suite}`);
      }
    }
  }
  if (unmapped.length) {
    throw new Error(
      `unmapped tracked files (add an arm to tools/fast-gate.sh): ${unmapped.join(", ")}`,
    );
  }
  if (missing.length) throw new Error(`mapped to a missing suite: ${missing.join(", ")}`);
});

Deno.test("an unmapped file in the delta fails the gate closed, naming the file", async () => {
  const probe = `${repoRoot}/UNMAPPED-PROBE.tmp`;
  await Deno.writeTextFile(probe, "not a mapped path\n");
  try {
    const r = await run(["--dry-run"]);
    if (r.code !== 2) {
      throw new Error(`expected exit 2, got ${r.code} (stdout: ${r.stdout.trim()})`);
    }
    if (!r.stderr.includes("UNMAPPED-PROBE.tmp")) {
      throw new Error(`the failure did not name the file: ${r.stderr.trim()}`);
    }
    // `fast-gate: unmapped:` is a contract with the fleet's log parser, which publishes the
    // list alongside the cached verdict. Match the path as a whitespace-delimited TOKEN, not
    // as the whole tail: the marker names EVERY unmapped path, so an exact-string match
    // breaks the moment a second path is unmapped (which is what AGENTS.md did to it).
    const marker = r.stderr.match(/^fast-gate: unmapped: (.*)$/m);
    const named = marker ? marker[1].trim().split(/\s+/) : [];
    if (!named.includes("UNMAPPED-PROBE.tmp")) {
      throw new Error(`the parser marker did not name the file: ${r.stderr.trim()}`);
    }
  } finally {
    await Deno.remove(probe);
  }
});

Deno.test("a storage/entrypoint change runs the HTTP and KV integration suites", async () => {
  const mapped = await suites(["--map", "server.ts"]);
  for (
    const suite of ["tests/http_test.ts", "tests/kv_behaviour_test.ts", "tests/backfill_test.ts"]
  ) {
    if (!mapped.includes(suite)) throw new Error(`server.ts does not map to ${suite}`);
  }
  // ...and never to the browser suite, which the fast tier cannot run.
  if (mapped.includes("tests/browser_journey_test.ts")) {
    throw new Error("the fast tier must not select the browser suite");
  }
});

Deno.test("extracted contracts map only to affected fast suites", async () => {
  const expected: Record<string, string[]> = {
    "storage.ts": [
      "tests/unit_keys_test.ts",
      "tests/kv_behaviour_test.ts",
      "tests/backfill_test.ts",
      "tests/backfill_verified_test.ts",
      "tests/http_test.ts",
    ],
    "bot-verification.ts": [
      "tests/unit_bot_test.ts",
      "tests/unit_format_test.ts",
      "tests/backfill_verified_test.ts",
      "tests/http_test.ts",
    ],
    "probes.ts": ["tests/unit_probes_test.ts", "tests/http_test.ts", "tests/kv_behaviour_test.ts"],
    "views.ts": ["tests/unit_views_test.ts", "tests/unit_format_test.ts", "tests/http_test.ts"],
  };
  for (const [path, selected] of Object.entries(expected)) {
    const got = await suites(["--map", path]);
    if ([...got].sort().join() !== [...selected].sort().join()) {
      throw new Error(`${path}: ${got.join()} != ${selected.join()}`);
    }
  }
});

Deno.test("a changed suite runs itself, and shared test code runs everything", async () => {
  if ((await suites(["--map", "tests/http_test.ts"])).join() !== "tests/http_test.ts") {
    throw new Error("a changed suite must map to itself");
  }
  // Non-empty first: a `--map` that exits 0 with no output would make every
  // `for (const suite of shared)` assertion below vacuously true.
  const shared = await suites(["--map", "tests/testenv.ts"]);
  if (shared.length === 0) throw new Error("testenv.ts maps to nothing");
  const all = new Set(await suites(["--all-suites", "--dry-run"]));
  for (const suite of shared) {
    if (!all.has(suite) || !suite.endsWith("_test.ts") || suite.includes("browser")) {
      throw new Error(`testenv.ts maps to ${suite}, which is not a fast suite`);
    }
  }
});

Deno.test("a real delta resolves through git diff, not just --map", async () => {
  // Most of this file drives `--map <path>`, which short-circuits before
  // resolve_delta(). This exercises the path the gate actually takes: an
  // untracked file in the working tree is picked up by `git status` and resolved
  // to its suite. The probe is cleaned up in `finally`; if the process is killed
  // it is left as a visible untracked test file that still runs green.
  const probe = `${repoRoot}/tests/delta-probe_test.ts`;
  await Deno.writeTextFile(
    probe,
    'Deno.test("delta probe", () => {});\n',
  );
  try {
    const r = await run(["--dry-run"]);
    if (r.code !== 0) throw new Error(`--dry-run exited ${r.code}: ${r.stderr.trim()}`);
    const resolved = lines(r.stdout);
    if (!resolved.includes("tests/delta-probe_test.ts")) {
      throw new Error(`the delta probe was not resolved to itself: ${resolved.join(",")}`);
    }
    // A changed tracked file must resolve too, and via its mapping arm rather than
    // its own name (server.ts -> the whole fast set).
    const serverMap = await suites(["--map", "server.ts"]);
    const fast = (await suites(["--all-suites", "--dry-run"]))
      .filter((suite) => !NON_FAST_SUITES.includes(suite));
    if ([...serverMap].sort().join() !== [...fast].sort().join()) {
      throw new Error(`server.ts maps to ${serverMap.join()}, expected ${fast.join()}`);
    }
  } finally {
    await Deno.remove(probe).catch(() => {});
  }
});

Deno.test("config, tooling and docs map to the bounded mapping subset", async () => {
  for (
    const path of [
      "deno.json",
      "tools/fast-gate.sh",
      "tools/full-gate.sh",
      "README.md",
      "AGENTS.md",
      "docs/speed.md",
    ]
  ) {
    const mapped = await suites(["--map", path]);
    if (mapped.join() !== "tests/gate_mapping_test.ts") {
      throw new Error(`${path} maps to ${mapped.join(",")}`);
    }
  }
});

Deno.test("the full tier is a superset of the affected tier (full includes fast)", async () => {
  const full = new Set(await suites(["--all-suites", "--dry-run"]));
  if (full.size === 0) throw new Error("--all-suites resolved to nothing");
  const tracked = await new Deno.Command("git", {
    args: ["ls-files"],
    cwd: repoRoot,
    stdout: "piped",
  }).output();
  for (const file of lines(new TextDecoder().decode(tracked.stdout))) {
    const r = await run(["--map", file]);
    if (r.code !== 0) continue; // unmapped or full-only; covered by the first test
    for (const suite of lines(r.stdout)) {
      if (!full.has(suite)) {
        throw new Error(`full tier omits ${suite}, which ${file} selects`);
      }
    }
  }
});

Deno.test("the browser journey runs for its own changes and in the full tier", async () => {
  const mapped = await suites(["--map", "tests/browser_journey_test.ts"]);
  if (mapped.join() !== "tests/browser_journey_test.ts") {
    throw new Error(`a changed browser suite must map to itself, got ${mapped.join(",")}`);
  }
  const full = await suites(["--all-suites", "--dry-run"]);
  if (!full.includes("tests/browser_journey_test.ts")) {
    throw new Error("the full tier must run the browser journey");
  }
  // ...but a code change must not drag Chrome into every fast run.
  if ((await suites(["--map", "server.ts"])).includes("tests/browser_journey_test.ts")) {
    throw new Error("server.ts must not select the browser suite in the fast tier");
  }
});

Deno.test("usage errors exit 3 and a bad base ref exits 4", async () => {
  if ((await run(["--nonsense"])).code !== 3) throw new Error("unknown flag must exit 3");
  if ((await run(["--map"])).code !== 3) throw new Error("--map without a path must exit 3");
  const out = await new Deno.Command("bash", {
    args: ["tools/fast-gate.sh", "--dry-run"],
    cwd: repoRoot,
    env: { GIT_BASE: "refs/heads/definitely-not-a-ref" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 4) throw new Error(`bad GIT_BASE should exit 4, got ${out.code}`);
});

// The CAS deadline's coupling, asserted rather than assumed (ua-tracer-o9s).
//
// The give-up tests inject a tiny deadline so they cost milliseconds instead of the real
// two seconds, which is the whole point of making it injectable. The risk that buys is
// that someone weakens PRODUCTION's deadline, or starts passing a small one on the
// request path, and the fast suite would never notice: the tests would still be green
// because they never use the default. So the coupling is pinned in source, in the style
// this file already uses for the gate scripts, because timing a real give-up would cost
// exactly the two seconds the injection exists to avoid.
//
// This lives here rather than in kv_behaviour_test.ts (where the give-up tests are)
// because that suite runs permission-tight and cannot read files.
Deno.test("the injectable CAS deadline cannot quietly replace the production one", async () => {
  const storage = await Deno.readTextFile(new URL("../storage.ts", import.meta.url));

  // 1. The default IS the production bound.
  if (!/deadlineMs: number\s*=\s*CAS_DEADLINE_MS/.test(storage)) {
    throw new Error("casRetry's default deadline is no longer CAS_DEADLINE_MS");
  }
  // 2. It is threaded through, so injecting one actually works.
  if (!/\}\s*,\s*opts\.deadlineMs\s*\)/.test(storage)) {
    throw new Error("commitHit no longer passes opts.deadlineMs into casRetry");
  }
  // 3. The request path does NOT override it: a production probe must not inherit a
  //    test's shortcut.
  const logHit = storage.slice(storage.indexOf("export async function logHit"));
  if (logHit.length === 0) throw new Error("logHit is gone");
  const at = logHit.indexOf("commitHit(");
  if (at < 0) throw new Error("logHit no longer records through commitHit");
  const call = logHit.slice(at, at + 200);
  if (call.includes("deadlineMs")) {
    throw new Error(`logHit overrides the CAS deadline: ${call.split("\n")[0]}`);
  }

  // 4. And the fast path is fast because tests INJECT a deadline, not because the
  //    default was weakened: if the injection disappears, the suite is paying 2s per
  //    give-up test again and someone will be tempted to shorten the real one.
  const suite = await Deno.readTextFile(new URL("./kv_behaviour_test.ts", import.meta.url));
  if (!suite.includes("deadlineMs:")) {
    throw new Error("no test injects a deadline; the give-up tests would cost the real 2s");
  }
});

// The scheduled snapshot repair registers from the entrypoint, and WHERE it registers
// decides whether the feature works at all (ua-tracer-2t9):
//  - Deno Deploy discovers Deno.cron() by evaluating the ENTRY module's top-level code,
//    so the call must be reachable in production;
//  - a test suite importing server.ts is not the entry module, so inside
//    `if (import.meta.main)` the call can never happen in a test process - which is what
//    makes the suites incapable of registering a cron rather than usually harmless.
// A guard in crons.ts instead would be false in production too (import.meta.main is true
// only for the entry module) and the job would silently never register, so this asserts
// the placement, not the intent.
Deno.test("the cron registration sits inside the entrypoint guard", async () => {
  const source = await Deno.readTextFile(new URL("../server.ts", import.meta.url));
  const guard = source.indexOf("if (import.meta.main) {");
  if (guard < 0) throw new Error("server.ts no longer guards its entrypoint block");
  const call = source.indexOf("registerRepairCron(");
  if (call < 0) throw new Error("server.ts no longer registers the repair job");
  if (call < guard) {
    throw new Error("the cron registration happens before the entrypoint guard");
  }
  const block = source.slice(guard, source.indexOf("\n}", guard));
  if (!block.includes("registerRepairCron(")) {
    throw new Error("the cron registration is outside the entrypoint guard");
  }
  // And it must not ALSO be registered from the module the entrypoint imports: that
  // copy would be inert in production and misleading to whoever reads it next.
  const crons = await Deno.readTextFile(new URL("../crons.ts", import.meta.url));
  if (/^\s*if \(import\.meta\.main\)/m.test(crons)) {
    throw new Error("crons.ts guards on import.meta.main, which is false in production");
  }
});

// The ## Suites table in docs/speed.md is the only place a reader learns which suites exist, and
// it drifted from disk once: tests/cron_test.ts was tiered in tools/fast-gate.sh and named in the
// affected-path mapping, but never tabled (ua-tracer-h6o). A doc table that silently disagrees
// with the tier list is what makes the tier system untrustworthy, and the check is cheap - the
// guard already runs with --allow-read - so it is asserted here rather than left to a reviewer to
// notice. The table and the *_test.ts files on disk must be the same SET, in both directions:
// a new suite has to be tabled in the same change, and a deleted one cannot linger in the docs.
Deno.test("the docs suite table and the suites on disk are the same set", async () => {
  const doc = await Deno.readTextFile(new URL("../docs/speed.md", import.meta.url));
  const from = doc.indexOf("## Suites");
  const to = doc.indexOf("## Affected-path mapping");
  if (from < 0 || to < from) throw new Error("docs/speed.md no longer has a ## Suites section");
  const section = doc.slice(from, to);

  const tabled = new Set<string>();
  for (const m of section.matchAll(/^\|\s*`(tests\/[A-Za-z0-9_.-]+_test\.ts)`/gm)) {
    tabled.add(m[1]);
  }
  if (tabled.size === 0) {
    throw new Error("the ## Suites table parsed as empty - has its format changed?");
  }

  const onDisk = new Set<string>();
  for await (const entry of Deno.readDir(new URL("../tests", import.meta.url))) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) onDisk.add(`tests/${entry.name}`);
  }
  if (onDisk.size === 0) throw new Error("no *_test.ts found on disk - wrong directory?");

  const missing = [...onDisk].filter((s) => !tabled.has(s)).sort();
  const extra = [...tabled].filter((s) => !onDisk.has(s)).sort();
  if (missing.length || extra.length) {
    throw new Error(
      "docs/speed.md's suite table and tests/ disagree" +
        ` - tiered but not tabled: ${missing.join(", ") || "(none)"}` +
        `; tabled but not on disk: ${extra.join(", ") || "(none)"}`,
    );
  }
});

// AGENTS.md summarizes the test tiers for developers landing changes. Hand-maintained counts
// in prose repeatedly drift (ua-tracer-8ce): ajc updated the sentence to 122 tests / 27 guards /
// 94 code / 14 suites, but test counts drift on every commit that adds a test case and cannot be
// derived without running the entire test suite. The suite counts (14 suite files: 2 guards,
// 11 code suites, 1 browser journey), however, describe the tier structure and ARE derivable
// from disk and tools/fast-gate.sh. This guard asserts that the numbers in AGENTS.md match
// reality, so a new suite file cannot be added without keeping the doc summary in step.
Deno.test("the AGENTS.md tier summary matches the derived suite counts", async () => {
  const agents = await Deno.readTextFile(new URL("../AGENTS.md", import.meta.url));
  const m = agents.match(
    /across\s+(\d+)\s+suite files:\s*(\d+)\s+gate guards,\s*(\d+)\s+code(?:\s+suites)?,\s*(\d+)\s+real-browser journey\s+plus\s+`tests\/testenv\.ts`/,
  );
  if (!m) {
    throw new Error(
      "could not parse tier-summary suite counts in AGENTS.md (expected 'across N suite files: X gate guards, Y code suites, Z real-browser journey plus `tests/testenv.ts`')",
    );
  }
  const statedTotal = Number(m[1]);
  const statedGuards = Number(m[2]);
  const statedCode = Number(m[3]);
  const statedBrowser = Number(m[4]);

  const onDisk = new Set<string>();
  for await (const entry of Deno.readDir(new URL("../tests", import.meta.url))) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) onDisk.add(`tests/${entry.name}`);
  }
  const allDispatched = await suites(["--all-suites", "--dry-run"]);
  const fast = allDispatched.filter((s) => !NON_FAST_SUITES.includes(s));
  const guards = NON_FAST_SUITES.filter((s) => s.includes("gate_"));
  const browser = NON_FAST_SUITES.filter((s) => s.includes("browser_"));

  if (statedTotal !== onDisk.size) {
    throw new Error(
      `AGENTS.md states ${statedTotal} suite files, but tests/ has ${onDisk.size} *_test.ts files`,
    );
  }
  if (statedGuards !== guards.length) {
    throw new Error(
      `AGENTS.md states ${statedGuards} gate guards, but dispatcher has ${guards.length} (${
        guards.join(", ")
      })`,
    );
  }
  if (statedCode !== fast.length) {
    throw new Error(
      `AGENTS.md states ${statedCode} code suites, but dispatcher has ${fast.length} fast suites`,
    );
  }
  if (statedBrowser !== browser.length) {
    throw new Error(
      `AGENTS.md states ${statedBrowser} browser suites, but dispatcher has ${browser.length} (${
        browser.join(", ")
      })`,
    );
  }
  if (statedGuards + statedCode + statedBrowser !== statedTotal) {
    throw new Error(
      `AGENTS.md breakdown (${statedGuards} + ${statedCode} + ${statedBrowser} = ${
        statedGuards + statedCode + statedBrowser
      }) does not sum to total ${statedTotal}`,
    );
  }
});

// The two hand-maintained copies of the dispatcher's contract - docs/speed.md's ## Affected-path
// mapping and AGENTS.md's "### The map is the contract" - are what a lane reads to decide what its
// change must run, so a stale row is worse than a missing one: it tells the reader their change is
// covered while the gate runs something else (the ua-tracer-h6o shape, one table over - ua-tracer-1yo
// for docs/speed.md, ua-tracer-qir for AGENTS.md, whose table had gone stale the same way).
//
// ONE guard covers both, because two guards for one rule is how one of them rots. Each row is driven
// through `--map <path>` (the same subprocess the rest of this file uses) and compared as SETS in
// both directions, so neither a stale row nor a re-pointed arm passes. Shapes the parser must allow
// for, each pinned so a format change fails loudly instead of quietly checking fewer rows:
//   - a row may name several paths in one cell (`server.ts`, `tests/testenv.ts`), and each of them
//     must map to that row's suites;
//   - suite names are shorthand in two forms: docs/speed.md writes `unit_keys_test` and AGENTS.md
//     writes `unit_keys` (and `http` for `http_test`);
//   - prose rows: the entrypoint row says "every non-browser suite" (the fast tier) and the
//     self-mapping rows say "that suite".
// Cells naming a glob (`tools/*`) or a placeholder (`tests/<suite>.ts`) are skipped - the concrete
// paths in those rows are still checked, and those glob arms are pinned by the tooling test below.
const MAPPING_TABLES = [
  { file: "docs/speed.md", heading: "## Affected-path mapping", atLeast: 15 },
  { file: "AGENTS.md", heading: "### The map is the contract", atLeast: 14 },
];

// A row names suites in shorthand, in either of the two forms above, so a token is resolved by
// trying the `tests/`-prefixed name with and without `_test` and taking the one that exists on disk.
// A token that resolves to neither is an error rather than a dropped one: a typo must not quietly
// shrink the expected set, which would make the comparison below fail for the wrong reason (or, in
// the other direction, pass).
async function resolveSuite(token: string): Promise<string | null> {
  if (!/^[a-z][a-z0-9_]*$/.test(token)) return null;
  for (const name of [`tests/${token}_test.ts`, `tests/${token}.ts`]) {
    try {
      if ((await Deno.stat(`${repoRoot}/${name}`)).isFile) return name;
    } catch {
      // Not this form; try the other.
    }
  }
  return null;
}

// From `heading` to the next heading of the same or higher level, so a section that gains a paragraph
// or moves does not need this guard edited, and a heading that disappears throws instead of quietly
// parsing an empty section.
function sectionOf(text: string, heading: string): string {
  const lines = text.split("\n");
  const level = (line: string) => (line.match(/^#+/) ?? [""])[0].length;
  const at = lines.findIndex((line) => line.trim() === heading);
  if (at < 0) throw new Error(`${heading} is gone`);
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#+ /.test(lines[i]) && level(lines[i]) <= level(lines[at])) {
      return lines.slice(at, i).join("\n");
    }
  }
  return lines.slice(at).join("\n");
}

function tableRows(body: string): string[][] {
  return body.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    // The header and the `| --- | --- |` separator carry no backticks, so they drop out below.
    .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2);
}

const backticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const concrete = (cell: string) => backticked(cell).filter((t) => /^[A-Za-z0-9_./-]+$/.test(t));

Deno.test("both affected-path tables match what the dispatcher maps", async () => {
  const fast = (await suites(["--all-suites", "--dry-run"]))
    .filter((suite) => !NON_FAST_SUITES.includes(suite));
  if (fast.length === 0) throw new Error("the fast tier resolved to nothing");

  for (const { file, heading, atLeast } of MAPPING_TABLES) {
    const rows = tableRows(
      sectionOf(await Deno.readTextFile(new URL(`../${file}`, import.meta.url)), heading),
    );
    let checked = 0;
    for (const [pathCell, suiteCell] of rows) {
      const paths = concrete(pathCell);
      if (paths.length === 0) continue; // a heading row, or the "anything else" row
      let expected: string[];
      if (/every non-browser suite/.test(suiteCell)) {
        expected = fast;
      } else if (/that suite/.test(suiteCell)) {
        // A self-mapping row: `--map <path>` must return exactly this path.
        expected = paths;
      } else {
        expected = [];
        for (const token of backticked(suiteCell)) {
          // A backticked token that is not suite-shaped is prose about the row - `/api/health` in the
          // crons row - rather than a suite name. A suite-SHAPED token that resolves to nothing is an
          // error: a typo must not quietly shrink the expected set.
          if (!/^[a-z][a-z0-9_]*$/.test(token)) continue;
          const suite = await resolveSuite(token);
          if (suite === null) {
            throw new Error(
              `${file}'s row for ${paths.join(", ")} names '${token}', which is not a suite ` +
                `on disk - has the table's format changed?`,
            );
          }
          expected.push(suite);
        }
        if (expected.length === 0) {
          throw new Error(
            `${file}'s row for ${paths.join(", ")} names no suite - has the table's format ` +
              `changed? (${suiteCell})`,
          );
        }
      }
      for (const path of paths) {
        const got = (await suites(["--map", path])).sort();
        const want = [...expected].sort();
        if (got.join() !== want.join()) {
          throw new Error(
            `${file} says ${path} runs ${want.join(", ") || "(nothing)"}, but ` +
              `tools/fast-gate.sh maps it to ${got.join(", ") || "(nothing)"}`,
          );
        }
        checked++;
      }
    }
    // A parser that silently stopped seeing rows (a reflowed table, a renamed column, a heading that
    // moved out of reach) would make every assertion above vacuous, so the count is asserted against
    // the table's real shape.
    if (checked < atLeast) {
      throw new Error(
        `only ${checked} concrete paths were checked in ${file}'s ${heading} table, which names ` +
          `${atLeast}+ - has its format changed?`,
      );
    }
  }
});

// The other half of a hand-maintained table: a row cannot only be wrong, it can be MISSING, and an
// omission is invisible to the row-by-row check above - which is exactly how AGENTS.md's Layout table
// and its affected-path table both lost crons.ts while every row in them was correct (ua-tracer-qir,
// found on the way to ua-tracer-1yo). Completeness is derivable from the tree, so it is asserted:
// every tracked top-level `*.ts` module must be named in the first column of each table that
// describes that tree. `git ls-files '*.ts'` is what AGENTS.md's Layout table says it mirrors, and
// both affected-path tables must carry a row for every module the dispatcher has an arm for.
const MODULE_TABLES = [
  ...MAPPING_TABLES,
  { file: "AGENTS.md", heading: "## Layout" },
];

Deno.test("every tracked top-level module is named in the tables that mirror the tree", async () => {
  const modules = (await gitLines(["ls-files"])).filter((f) => /^[^/]+\.ts$/.test(f));
  if (modules.length < 5) {
    throw new Error(`git ls-files listed ${modules.length} top-level .ts modules`);
  }

  for (const { file, heading } of MODULE_TABLES) {
    const rows = tableRows(
      sectionOf(await Deno.readTextFile(new URL(`../${file}`, import.meta.url)), heading),
    );
    // The path cell of a row, which is where a module is named - `storage.ts` (KV schema) in one file
    // and `backfill.ts`, `backfill-verified.ts` in another, so the whole cell is read and its
    // backticked tokens are the names.
    const named = new Set(rows.flatMap((cells) => concrete(cells[0])));
    const missing = modules.filter((m) => !named.has(m)).sort();
    if (missing.length) {
      throw new Error(
        `${file}'s ${heading} table does not name ${
          missing.join(", ")
        } - every tracked top-level ` +
          `*.ts module has an arm in tools/fast-gate.sh, so it needs a row here too`,
      );
    }
  }
});

// ua-tracer-ha5: the fmt:check, lint:check and typecheck tasks derive their path sets from the tree
// instead of enumerating them, because an enumerated list is the thing that drifts - lint:check
// listed eight paths and omitted crons.ts, so the gate's lint step stayed green while that file
// carried a violation. That derivation rests on what deno is told to ignore: the .gitignore files
// it reads itself, plus the task's explicit --ignore set (ua-tracer-hae; .git/info/exclude is NOT
// part of that - deno does not read it, which is why bd's .beads/ needed an explicit --ignore).
// The assertions below turn that structural argument into a checked one, in the same spirit
// as the table-vs-directory parity above.

// The extensions `deno fmt` handles. Kept here rather than in deno.json because it describes what
// deno does, not what this repository asks of it.
const DENO_FMT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".json",
  ".jsonc",
];

const isFmtable = (f: string) => DENO_FMT_EXTENSIONS.some((e) => f.endsWith(e));

async function gitLines(args: string[]): Promise<string[]> {
  const out = await new Deno.Command("git", {
    args,
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    const err = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${err}`);
  }
  return new TextDecoder().decode(out.stdout).split("\n").filter((l) => l.length > 0);
}

Deno.test("the files the fmt:check task checks cover every tracked file of the kinds it formats", async () => {
  // ua-tracer-hae: the count is taken from the TASK, never from a bare `deno fmt --check`, because
  // the two disagree wherever a path is hidden by .git/info/exclude rather than .gitignore (bd's
  // .beads/, .dolt/): git's --exclude-standard view of "untracked" below hides such paths, while
  // bare deno fmt - which reads only .gitignore - checks them. That made the bare-count version of
  // this guard red on machine state in any tree with a populated .beads/ (29 vs 26: deno checking
  // three files git refused to list), the very state the task's --ignore set exists to walk past.
  // Measuring the command the gate actually runs is correct in both directions: an info/exclude
  // path the task forgets to ignore shows up as files "git neither tracks nor lists", and a
  // --ignore that masks a tracked file shows up as a skip.
  const out = await new Deno.Command("deno", {
    args: ["task", "fmt:check"],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  const m = text.match(/Checked (\d+) files?/) ??
    text.match(/not formatted files? in (\d+) files?/);
  if (!m) {
    throw new Error(
      "could not read a file count out of `deno task fmt:check` - has its output format changed? tail: " +
        text.trim().slice(-200),
    );
  }
  const denoCount = Number(m[1]);

  const tracked = (await gitLines(["ls-files"])).filter(isFmtable);
  // deno walks the tree rather than the index, so a lane's untracked scratch file is counted by it
  // too. Those are subtracted rather than asserted away: a guard that went red because someone has a
  // scratch file open would be a test depending on machine state, which is a defect here.
  const untracked = (await gitLines(["ls-files", "--others", "--exclude-standard"]))
    .filter(isFmtable);
  // Files still in the index but deleted from the worktree: deno cannot check what is not there, so
  // counting them as "should be covered" produced a message blaming deno for SKIPPING a file the
  // tree no longer has - ua-tracer-lpz's class, an assertion telling the reader something untrue.
  // Subtracting them does not hide drift: a file that IS present and ignore-masked stays counted
  // here and stays missing from deno's total, which the mutation matrix below proves.
  const deleted = new Set(await gitLines(["ls-files", "-d"]));
  const trackedHere = tracked.filter((f) => !deleted.has(f));

  const coveringTracked = denoCount - untracked.length;
  if (coveringTracked !== trackedHere.length) {
    const drift = coveringTracked < trackedHere.length
      ? `the fmt task is SKIPPING ${
        trackedHere.length - coveringTracked
      } file(s) that git tracks ` +
        "and the worktree still has (an ignore rule or the task's --ignore set masks them; " +
        ".gitignore rules are named by the assertion below)"
      : `the fmt task is CHECKING ${
        coveringTracked - trackedHere.length
      } file(s) that git neither tracks ` +
        "nor lists as untracked - typically a .git/info/exclude path its --ignore set does not " +
        "cover: the verdict then depends on files the repository cannot see. Add the path to the " +
        "task's --ignore set, or stop hiding it";
    throw new Error(
      `deno task fmt:check would check ${denoCount} files, ${untracked.length} of them untracked; ` +
        `that leaves ${coveringTracked} covering the ${trackedHere.length} fmt-able files git tracks ` +
        `and the worktree still has - ${drift}`,
    );
  }
});

Deno.test("no --ignore entry in the check tasks masks a file git tracks", async () => {
  // ua-tracer-hae: the count assertion above compares deno's walk (through the task the gate runs)
  // with git's view, so a --ignore that drops a tracked file moves the count - but only in NET: a
  // masked tracked file can be cancelled out by an extra file the task checks that git refuses to
  // list (an uncovered info/exclude path). deno prints a count, not the list of files it checked,
  // so the count cannot name names; the declared entries can. Each --ignore in fmt:check and
  // lint:check is therefore checked BY NAME against the tracked set - an entry that matches a
  // tracked file is masking it from the gate's verdict no matter what the count says. Prefix
  // semantics cover every entry this repo declares (plain paths, no globs); a future glob entry
  // would under-match here, but it would still move the count above.
  const cfg = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const tasks: Record<string, string> = cfg.tasks ?? {};
  const tracked = await gitLines(["ls-files"]);
  const offenders: string[] = [];
  for (const name of ["fmt:check", "lint:check"]) {
    const cmd = tasks[name];
    if (typeof cmd !== "string") throw new Error(`deno.json has no ${name} task`);
    for (const entry of cmd.matchAll(/--ignore=([^\s"']+)/g)) {
      const ignored = entry[1];
      const masked = tracked.filter((f) => f === ignored || f.startsWith(`${ignored}/`));
      for (const f of masked) offenders.push(`${name}'s --ignore=${ignored} masks tracked ${f}`);
    }
  }
  if (offenders.length) {
    throw new Error(
      `the check tasks declare ignores that hide tracked files from the gate's verdict: ${
        offenders.slice(0, 5).join("; ")
      }${offenders.length > 5 ? ` (+${offenders.length - 5} more)` : ""}`,
    );
  }
});

Deno.test("the fmt:check step itself goes red on an unformatted file it checks", async () => {
  // ua-tracer-lvy: the count assertion above is a COVERAGE guard - it parses the count and is
  // deliberately green while a file is unformatted; the red for that case comes from the gate's
  // own fmt:check step. Nothing pinned that (measured: no suite runs check:all or asserts a
  // nonzero exit on an unformatted file), so the guarantee lived in manual mutations only.
  //
  // The probe is UNTRACKED, at a mapped path, and that is a measured design decision, not a
  // convenience. Premise, measured on this tree: the task derives its set by FILESYSTEM WALK -
  // with an untracked, unignored, unformatted docs/fmt-pin-probe.md present, `deno task
  // fmt:check` exits 1 reporting 'Found 1 not formatted file in 29 files' and NAMES the probe;
  // removed, it exits 0 with 'Checked 28 files'. A git-derived set (ls-files) would never have
  // seen the probe at all - the original .beads/ bug is the same walk seen from the other side.
  // A tracked file differs from this probe only through ignore rules, and THOSE are already
  // pinned independently: the by-name guard above (--ignore entries) and the gitignore-masking
  // guard below. So this pin owns detection, those own exclusion, and together they are the
  // property 'an unformatted file the repo ships cannot pass the gate'.
  //
  // Why an untracked probe and not the alternatives (the v1 defect is in bd remember): a
  // tracked-file mutation cannot coexist with the gate's witness, which attests tracked files'
  // ctime - the v1 pin rewrote README.md inside the gate's own run and marked its own verdict
  // STALE three consecutive times on a quiet tree. An untracked file is explicitly NOT
  // witnessed, and this test touches nothing tracked, so it cannot invalidate any verdict.
  // A tautology was the other rejected end: asserting on the task STRING (it contains --check)
  // would pin words, not behaviour. This pin runs the real task and asserts its behaviour -
  // a fmt that ignores everything, or a task that lost --check, stays green and goes red here.
  const probe = `${repoRoot}/docs/fmt-pin-probe.md`;
  let exists = true;
  try {
    await Deno.stat(probe);
  } catch {
    exists = false;
  }
  if (exists) {
    // Not this test's mess: a killed run may have left the probe behind. It stays visible in
    // git status and the gate's own fmt step goes red naming it, so the failure surfaces either
    // way; recreating over it would only hide which run left it.
    return;
  }
  try {
    // Unformatted on purpose: runs of spaces that fmt collapses (the same mutation measured
    // manually and in the premise above).
    await Deno.writeTextFile(
      probe,
      "# fmt pin probe\n\nthis   is   not   formatted\n",
    );
    const out = await new Deno.Command("deno", {
      args: ["task", "fmt:check"],
      cwd: repoRoot,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    if (out.code === 0) {
      throw new Error("fmt:check stayed green on an unformatted file it checks");
    }
    // Wording kept loose on purpose: assert the fact (unformatted files reported), not a
    // sentence deno may reword.
    if (!/not formatted/i.test(text)) {
      throw new Error(
        `fmt:check exited ${out.code} but never reported unformatted files: ${
          text.trim().slice(-200)
        }`,
      );
    }
  } finally {
    // No residue: the probe is removed even on failure, and it was this test's own file -
    // nothing tracked, nothing shared, nothing witnessed.
    await Deno.remove(probe).catch(() => {});
  }
});

Deno.test("no tracked file deno would format is hidden from it by .gitignore", async () => {
  // `git add -f` on generated evidence is the quiet version of this: the file is in the repository,
  // so it looks covered, but deno skips it because an ignore rule matches, and the gate's fmt step
  // reports a green verdict about a file it never read.
  const trackedIgnored = (await gitLines(["ls-files", "-ci", "--exclude-standard"]))
    .filter(isFmtable);
  if (trackedIgnored.length) {
    throw new Error(
      `tracked but gitignored, so deno fmt and deno lint skip them entirely: ${
        trackedIgnored.join(", ")
      }`,
    );
  }
});

Deno.test("the generated gate evidence stays gitignored, because the derived checks rely on it", async () => {
  // artifacts/ holds browser-journey evidence and throwaway Chrome profiles. deno fmt and deno lint
  // walk everything git does not ignore, so if that rule goes away those checks start covering
  // generated files - thousands of them - and their counts stop meaning what the test above assumes.
  const out = await new Deno.Command("git", {
    // The trailing slash is load-bearing, and ua-tracer-lpz is that bug: .gitignore:20 is
    // "artifacts/" with a trailing slash, which git treats as DIRECTORY-only. Queried as "artifacts"
    // while the directory happens to be absent - a clean clone, or a fresh worktree where the
    // browser gate has not run - git sees a non-directory path, the rule does not match, and it
    // exits 1, so this test failed for a reason unrelated to what it guards. "artifacts/" asserts
    // the path is a directory, so the rule matches whether or not the directory exists.
    args: ["check-ignore", "-q", "artifacts/"],
    cwd: repoRoot,
    stdout: "null",
    stderr: "null",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      "artifacts/ is no longer gitignored: deno fmt and deno lint would start checking generated " +
        "gate evidence (throwaway Chrome profiles). Restore the ignore rule, or give the tasks an " +
        "explicit exclusion.",
    );
  }
});

Deno.test("the check tasks derive their paths from the tree instead of enumerating them", async () => {
  const cfg = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const tasks: Record<string, string> = cfg.tasks ?? {};
  for (const name of ["fmt:check", "lint:check"]) {
    const cmd = tasks[name];
    if (typeof cmd !== "string") throw new Error(`deno.json has no ${name} task`);
    // A path in the command is the drift ua-tracer-ha5 removed: lint:check listed eight paths and
    // omitted crons.ts for as long as it existed, and fmt:check had the same shape.
    const listed = cmd.match(/[\w./-]+\.(?:ts|tsx|js|mjs|json)/g);
    if (listed) {
      throw new Error(
        `${name} enumerates paths again (${
          listed.join(", ")
        }) - derive them from the tree instead; ` +
          "an enumerated list is what silently omitted crons.ts",
      );
    }
  }
  const typecheck = tasks["typecheck"];
  if (typeof typecheck !== "string" || !typecheck.includes("*.ts")) {
    throw new Error(
      `typecheck should pass a glob (*.ts tests/*.ts) rather than a module list: ${typecheck}`,
    );
  }
});
