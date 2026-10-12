// Guard for the gate's own command configuration (tools/check.conf + tools/check-cmd.sh).
//
// ~/.fleet/check.conf is MACHINE-GLOBAL and fleet-check reads it for any repo on the host,
// so the deployed commands come from a file nobody reviews. tools/check.conf is the tracked
// source of truth and --install writes it out; these tests are what stops the two drifting,
// and what stops the tracked file naming a task that does not exist (a gate that runs
// nothing still reports a verdict).
//
// Permissions: run by its own deno task (deno task test:guards) with
// --allow-read --allow-write=. --allow-run=git,bash, because it reads the repo and writes a
// temporary install target under the gitignored artifacts/ directory. It never installs over
// the real ~/.fleet/check.conf: FLEET_CHECK_CONF redirects the installer.

const repoRoot = Deno.realPathSync(new URL("..", import.meta.url));

async function bash(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("bash", {
    args: ["tools/check-cmd.sh", ...args],
    cwd: repoRoot,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) };
}

/** Parse the `KEY="value"` / `KEY=value` assignments the tracked config uses. */
function parseConf(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(?:"([^"]*)"|([^\s]+))\s*$/);
    if (m) values.set(m[1], m[2] ?? m[3]);
  }
  return values;
}

/** A per-VM config path these tests own, so the machine's real one is never read. */
const isolatedOverride = `${repoRoot}/artifacts/gate-config-test/absent.conf`;

async function trackedConf(): Promise<Map<string, string>> {
  return parseConf(await Deno.readTextFile(`${repoRoot}/tools/check.conf`));
}

Deno.test("the tracked config names the two gate commands and stays inside the fleet budgets", async () => {
  const conf = await trackedConf();
  for (const key of ["CHECK_CMD", "CHECK_FAST_CMD", "CHECK_TIMEOUT", "CHECK_FAST_TIMEOUT"]) {
    if (!conf.has(key)) throw new Error(`tools/check.conf is missing ${key}`);
  }
  // `deno task check` is also the name fleet-check auto-detects from deno.json, so an
  // empty CHECK_CMD (auto-detect) is equivalent and allowed; anything else is not.
  const fullCmd = conf.get("CHECK_CMD") ?? "";
  if (fullCmd !== "deno task check" && fullCmd !== "") {
    throw new Error(`CHECK_CMD is ${JSON.stringify(fullCmd)}`);
  }
  if (conf.get("CHECK_FAST_CMD") !== "deno task check:fast") {
    throw new Error(`CHECK_FAST_CMD is ${conf.get("CHECK_FAST_CMD")}`);
  }
  // Fleet R1/R2: a full gate >300s or a fast gate >60s is the design defect the budget
  // exists to catch, and a bound of 0 would kill every run.
  const full = Number(conf.get("CHECK_TIMEOUT"));
  const fast = Number(conf.get("CHECK_FAST_TIMEOUT"));
  if (!(full > 0 && full <= 300)) throw new Error(`CHECK_TIMEOUT=${full} (fleet R1 is <=300)`);
  if (!(fast > 0 && fast <= 60)) throw new Error(`CHECK_FAST_TIMEOUT=${fast} (fleet R2 is <=60)`);
});

Deno.test("the tasks the config names exist and wrap the two gate scripts", async () => {
  const dj = JSON.parse(await Deno.readTextFile(`${repoRoot}/deno.json`)) as {
    tasks: Record<string, string>;
  };
  const full = dj.tasks["check"];
  const fast = dj.tasks["check:fast"];
  if (!full) throw new Error("deno.json has no `check` task (fleet-check auto-detects that name)");
  if (!fast) throw new Error("deno.json has no `check:fast` task");
  for (
    const [name, cmd, script] of [
      ["check", full, "tools/full-gate.sh"],
      ["check:fast", fast, "tools/fast-gate.sh"],
    ] as const
  ) {
    if (!cmd.includes(script)) throw new Error(`task ${name} does not run ${script}: ${cmd}`);
    const info = await Deno.stat(`${repoRoot}/${script}`);
    if (!info.isFile) throw new Error(`${script} is not a file`);
  }
  // The documented aliases must keep working: the hand-off and docs/speed.md name them.
  if (dj.tasks["test:fast"] !== fast) throw new Error(`test:fast is ${dj.tasks["test:fast"]}`);
  if (dj.tasks["test:full"] !== full) throw new Error(`test:full is ${dj.tasks["test:full"]}`);
});

Deno.test("--install writes exactly the tracked values", async () => {
  const dir = `${repoRoot}/artifacts/gate-config-test`;
  await Deno.mkdir(dir, { recursive: true });
  const target = `${dir}/check.conf`;
  try {
    const r = await bash(["--install"], { FLEET_CHECK_CONF: target });
    if (r.code !== 0) throw new Error(`--install exited ${r.code}: ${r.stderr.trim()}`);
    const written = parseConf(await Deno.readTextFile(target));
    if (!(await Deno.readTextFile(target)).includes("Project: ua-tracer")) {
      throw new Error("the installed file is not stamped with this project");
    }
    const trackedValues = await trackedConf();
    for (const [key, value] of trackedValues) {
      if (written.get(key) !== value) {
        throw new Error(`installed ${key}=${JSON.stringify(written.get(key))}, tracked ${value}`);
      }
    }
    // And the resolver reads that file back to the same values.
    const tracked = await trackedConf();
    const printed = await bash([], { FLEET_CHECK_CONF: target });
    if (printed.code !== 0) throw new Error(`resolver exited ${printed.code}`);
    const resolved = parseConf(printed.stdout);
    for (const key of ["CHECK_CMD", "CHECK_FAST_CMD"]) {
      if (resolved.get(key) !== tracked.get(key)) {
        throw new Error(`resolved ${key}=${resolved.get(key)} but tracked is ${tracked.get(key)}`);
      }
    }
    if (resolved.get("CHECK_FAST_CMD") === "") throw new Error("the fast tier resolved empty");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("--install replaces a corrupt per-VM file instead of failing on it", async () => {
  const dir = `${repoRoot}/artifacts/gate-config-test`;
  await Deno.mkdir(dir, { recursive: true });
  const target = `${dir}/corrupt.conf`;
  try {
    // An unterminated quote would be fatal if the installer sourced this first.
    await Deno.writeTextFile(target, 'CHECK_CMD="unterminated\n');
    const r = await bash(["--install"], { FLEET_CHECK_CONF: target });
    if (r.code !== 0) throw new Error(`--install refused a corrupt override: ${r.stderr.trim()}`);
    const written = await Deno.readTextFile(target);
    if (written.includes("unterminated")) throw new Error("the corrupt file survived the install");
    if (!written.includes('CHECK_CMD="deno task check"')) {
      throw new Error("the install did not write the tracked command");
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("the resolver prints a single key, and refuses one it does not know", async () => {
  // FLEET_CHECK_CONF is always passed: the machine's real ~/.fleet/check.conf belongs to
  // the VM, not to this test, and reading it would make the suite non-hermetic.
  const env = { FLEET_CHECK_CONF: isolatedOverride };
  const r = await bash(["CHECK_CMD"], env);
  if (r.code !== 0) throw new Error(`resolver exited ${r.code}: ${r.stderr.trim()}`);
  if (r.stdout.trim() !== "deno task check") throw new Error(`resolved: ${r.stdout.trim()}`);
  const list = parseConf((await bash([], env)).stdout);
  if (list.get("CHECK_FAST_CMD") !== "deno task check:fast") {
    throw new Error(`resolved set: CHECK_FAST_CMD=${list.get("CHECK_FAST_CMD")}`);
  }
  if (list.get("CHECK_TIMEOUT") !== "300" || list.get("CHECK_FAST_TIMEOUT") !== "60") {
    throw new Error(
      `resolved budgets: ${list.get("CHECK_TIMEOUT")}/${list.get("CHECK_FAST_TIMEOUT")}`,
    );
  }
  const bad = await bash(["NOT_A_KEY"], env);
  if (bad.code !== 3) throw new Error(`unknown key should exit 3, got ${bad.code}`);
});

Deno.test("the fast gate is the command the config names, and it fails closed", async () => {
  // `deno task check:fast` must be the dispatcher, not a copy of it: drive it through the
  // task with the dispatcher's own query modes.
  const mapped = await new Deno.Command("deno", {
    args: ["task", "check:fast", "--map", "server.ts"],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(mapped.stdout);
  if (mapped.code !== 0) throw new Error(`check:fast --map exited ${mapped.code}`);
  for (const suite of ["tests/http_test.ts", "tests/kv_behaviour_test.ts"]) {
    if (!out.includes(suite)) throw new Error(`check:fast --map server.ts omitted ${suite}`);
  }
  const unknown = await new Deno.Command("deno", {
    args: ["task", "check:fast", "--map", "not/a/mapped/path.ts"],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (unknown.code !== 2) throw new Error(`an unmapped path must exit 2, got ${unknown.code}`);
});
