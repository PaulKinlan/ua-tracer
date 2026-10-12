// Guard for the affected-path dispatcher (`tools/fast-gate.sh`).
//
// A dispatcher that silently maps nothing (or maps the wrong thing) is worse than
// no dispatcher: it produces a green verdict about a subset nobody chose. These
// tests drive the real script, so what is asserted is the behaviour of the gate
// itself — every tracked file maps to a suite, an unmapped file in the delta fails
// the gate closed, and the full tier really is a superset of the affected tier.
//
// Permissions: this suite is run by its own deno task
// (`deno task test:mapping`) with --allow-read --allow-run=git,bash, because it
// shells out to git and to the script. The other suites stay permission-tight.

const repoRoot = Deno.realPathSync(new URL("..", import.meta.url));

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
    // `fast-gate: unmapped:` is a contract with the fleet's log parser, which publishes
    // the list alongside the cached verdict.
    if (!r.stderr.includes("fast-gate: unmapped: UNMAPPED-PROBE.tmp")) {
      throw new Error(`no parser marker for the unmapped file: ${r.stderr.trim()}`);
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
      .filter((suite) =>
        ![
          "tests/browser_journey_test.ts",
          "tests/gate_config_test.ts",
          "tests/gate_mapping_test.ts",
        ].includes(suite)
      );
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
