// Deploy verification: is production serving a revision that carries the build field?
// (ua-tracer-ajc; the build field itself is ua-tracer-xk5, the deployment that would not roll is
// ua-tracer-3m1.)
//
// WHY: nothing outside Deno Deploy can list revisions, and no project VM holds deployment
// credentials, so "did my landing reach production?" was answerable only by a human refreshing
// /api/health and reading the `build` key by eye. That is five minutes of hand-sampling every time
// someone asks, and it produced the one-night blindness of ua-tracer-3m1: ten landings, no roll, and
// no way to say so in a repeatable sentence.
//
// WHAT IT ANSWERS, AND WHAT IT DOES NOT: `/api/health` reports `build` straight from the platform's
// DENO_DEPLOY_BUILD_ID, and every revision merged since ua-tracer-xk5 emits it. So a present key
// proves a revision NEWER than the last one without it is answering - it does NOT name the git
// commit, and this tool never claims it does (mapping a build id to a commit happens in the Deno
// Deploy console). An absent or null key on a readable payload means the revision answering predates
// the field, or the platform has stopped setting it. UNKNOWN is reported as UNKNOWN rather than
// guessed at.
//
// BOUNDED AND CREDENTIAL-FREE: N samples over T seconds (defaults 5 over 20s), each with a 5s
// fetch timeout, and a hard ceiling of 300s of total waiting; the endpoint is public, so no token,
// cookie or console access is involved. Exit codes: 0 a build key is present (CHANGED when --expect
// was given and it differs), 1 not confirmed (UNCHANGED / NOT-ROLLED / UNKNOWN), 2 usage error.
//
// TESTED WITHOUT NETWORK: readHealth, verdict, formatSample and parseArgs are pure, and `check`
// takes its fetch, clock, sleep and log as arguments, so tests/deploy_check_test.ts drives the whole
// sampling loop through an injected fetch - the hermetic suites never open a socket.
//
//   deno run --allow-net deploy-check.ts
//   deno run --allow-net deploy-check.ts --samples 10 --interval 6 --expect <build-id>

const DEFAULT_URL = "https://uatracer.com/api/health";
const FETCH_TIMEOUT_MS = 5000;
const MAX_SAMPLES = 30;
const MAX_INTERVAL_SECONDS = 60;
/** The total wait stays inside the fleet's R1 bound even at the maximums. */
const MAX_TOTAL_WAIT_MS = 300_000;

export const NOTE = "NOTE: a present build key proves the platform is serving a revision that " +
  "emits one; it does NOT name the git commit (map the build id to a commit in the Deno Deploy " +
  "console). An absent or null key means the revision answering predates the build field, or " +
  "DENO_DEPLOY_BUILD_ID is unset for it.";

export const USAGE = `usage: deno run --allow-net deploy-check.ts [options]

  --samples N     how many times to sample /api/health (1-${MAX_SAMPLES}, default 5)
  --interval S    seconds between samples (0-${MAX_INTERVAL_SECONDS}, default 5)
  --expect ID     the build id production should have moved away from
  --url URL       endpoint to sample (default ${DEFAULT_URL})
  --help          this text

exit: 0 a build key is present  1 not confirmed (UNCHANGED / NOT-ROLLED / UNKNOWN)  2 usage`;

/** How one sample read the payload. `absent` and `null` are both "no build id", and are kept apart
 *  because they mean different things in the response the platform sends. */
export type SampleReading = "present" | "null" | "absent" | "unreadable";

export type Sample = {
  at: string;
  /** HTTP status, or 0 when the request itself failed. */
  status: number;
  build: string | null;
  reading: SampleReading;
  /** Why the reading is what it is, for the evidence line. */
  note?: string;
};

export type CheckVerdict = {
  /** The process exit code: 0 only when a build key is present. */
  code: number;
  label: "CHANGED" | "UNCHANGED" | "PRESENT" | "NOT-ROLLED" | "UNKNOWN";
  reason: string;
};

/** Read one response for what it is. Never throws: a payload this tool cannot parse is `unreadable`,
 *  which is a different answer from "the old revision answered". */
export function readHealth(status: number, body: string, at: string): Sample {
  if (status !== 200) {
    return { at, status, build: null, reading: "unreadable", note: `http ${status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      at,
      status,
      build: null,
      reading: "unreadable",
      note: `body is not JSON (${body.trim().slice(0, 60) || "empty"})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { at, status, build: null, reading: "unreadable", note: "body is not a JSON object" };
  }
  const payload = parsed as Record<string, unknown>;
  if (!("build" in payload)) {
    return {
      at,
      status,
      build: null,
      reading: "absent",
      note: "the payload has no build key",
    };
  }
  const build = payload.build;
  if (build === null || build === undefined) {
    return { at, status, build: null, reading: "null", note: "build is null" };
  }
  if (typeof build !== "string" || build.length === 0) {
    return {
      at,
      status,
      build: null,
      reading: "unreadable",
      note: `build is ${JSON.stringify(build)}, not a non-empty string`,
    };
  }
  return { at, status, build, reading: "present" };
}

/** One pasteable line per sample: when, which sample, the status, and what the payload said. */
export function formatSample(sample: Sample, index: number, total: number): string {
  const status = sample.status === 0 ? "no-response" : `http ${sample.status}`;
  const build = sample.reading === "present" ? `build=${sample.build}` : `build=${sample.reading}`;
  const detail = sample.note ? ` (${sample.note})` : "";
  return `[${sample.at}] sample ${index}/${total} ${status} ${build}${detail}`;
}

/** The final answer, from the samples taken. A build key present at any point is what a roll looks
 *  like; with --expect the newest present value is what decides CHANGED from UNCHANGED. */
export function verdict(samples: Sample[], expected: string | null): CheckVerdict {
  const present = samples.filter((s) => s.reading === "present");
  const latest = present[present.length - 1];
  if (latest && latest.build !== null) {
    if (expected === null) {
      return {
        code: 0,
        label: "PRESENT",
        reason: `a build key is present (build=${latest.build}); pass --expect <build> to tell ` +
          `CHANGED from UNCHANGED`,
      };
    }
    if (latest.build === expected) {
      return {
        code: 1,
        label: "UNCHANGED",
        reason: `the build key is still the one you asked to move away from (build=${expected})`,
      };
    }
    return {
      code: 0,
      label: "CHANGED",
      reason: `build=${latest.build}, which differs from --expect ${expected}`,
    };
  }
  const readable =
    samples.filter((s) => s.reading === "absent" || s.reading === "null" || s.reading === "present")
      .length;
  if (readable === 0) {
    return {
      code: 1,
      label: "UNKNOWN",
      reason: `none of the ${samples.length} sample(s) could be read - check the URL and the ` +
        `network; this is not evidence of an old revision`,
    };
  }
  return {
    code: 1,
    label: "NOT-ROLLED",
    reason: `${readable} of ${samples.length} sample(s) were readable and none carried a build ` +
      `key - the revision answering emits no build field, or the platform stopped setting it`,
  };
}

export type ParsedArgs = {
  url: string;
  samples: number;
  intervalMs: number;
  expected: string | null;
};

export type Parsed = { args: ParsedArgs } | { error: string };

/** Pure, so the bounds are testable: the loop is bounded by construction, not by the caller. */
export function parseArgs(argv: string[]): Parsed {
  const args: ParsedArgs = {
    url: DEFAULT_URL,
    samples: 5,
    intervalMs: 5000,
    expected: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--help":
      case "-h":
        return { error: USAGE };
      case "--samples": {
        if (value === undefined) return { error: "--samples needs a number" };
        const samples = Number(value);
        if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
          return { error: `--samples must be an integer 1-${MAX_SAMPLES}, got ${value}` };
        }
        args.samples = samples;
        i++;
        break;
      }
      case "--interval": {
        if (value === undefined) return { error: "--interval needs a number of seconds" };
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_INTERVAL_SECONDS) {
          return { error: `--interval must be seconds 0-${MAX_INTERVAL_SECONDS}, got ${value}` };
        }
        args.intervalMs = Math.round(seconds * 1000);
        i++;
        break;
      }
      case "--expect": {
        if (value === undefined || value.length === 0) {
          return { error: "--expect needs a build id" };
        }
        args.expected = value;
        i++;
        break;
      }
      case "--url": {
        if (value === undefined || value.length === 0) return { error: "--url needs a URL" };
        args.url = value;
        i++;
        break;
      }
      default:
        return { error: `unknown argument: ${flag}` };
    }
  }
  if (args.intervalMs * (args.samples - 1) > MAX_TOTAL_WAIT_MS) {
    return {
      error: `--samples ${args.samples} with --interval ${args.intervalMs / 1000} would wait ` +
        `${args.intervalMs * (args.samples - 1) / 1000}s, over the ${MAX_TOTAL_WAIT_MS / 1000}s ` +
        `ceiling`,
    };
  }
  return { args };
}

export type CheckOptions = ParsedArgs & {
  /** Narrower than `typeof fetch` so a fake needs only the two arguments this call passes. */
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
};

/** Sample, report one line per sample, and return the verdict. Everything it touches outside its
 *  arguments is injected, which is what lets the test drive it with no network. */
export async function check(opts: CheckOptions): Promise<CheckVerdict> {
  const samples: Sample[] = [];
  for (let i = 1; i <= opts.samples; i++) {
    const at = opts.now().toISOString();
    let sample: Sample;
    try {
      const response = await opts.fetchImpl(opts.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      sample = readHealth(response.status, await response.text(), at);
    } catch (err) {
      sample = {
        at,
        status: 0,
        build: null,
        reading: "unreadable",
        note: `request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    samples.push(sample);
    opts.log(formatSample(sample, i, opts.samples));
    if (i < opts.samples) await opts.sleep(opts.intervalMs);
  }
  const result = verdict(samples, opts.expected);
  opts.log(`VERDICT: ${result.label} (exit ${result.code}) - ${result.reason}`);
  opts.log(NOTE);
  return result;
}

if (import.meta.main) {
  const parsed = parseArgs(Deno.args);
  if ("error" in parsed) {
    console.error(`deploy-check: ${parsed.error}`);
    console.error(USAGE);
    Deno.exitCode = 2;
  } else {
    const result = await check({
      ...parsed.args,
      fetchImpl: fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      log: (line) => console.log(line),
    });
    Deno.exitCode = result.code;
  }
}
