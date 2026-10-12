# Gate speed budget

ua-tracer is a Deno app with a thin `server.ts` entrypoint and separate storage, bot, probe, and
view contracts; it has no build step, so the gate is `deno fmt` + `deno lint` + `deno check` +
`deno test`. This file is the contract for how long each tier may take and which suite a change must
run.

## Tiers and budgets

| Tier              | Command                                | Budget                  | Measured (2026-10-12, 2-vCPU VM, warm)                             |
| ----------------- | -------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| Fast              | `deno task test:fast`                  | **<= 60 s** (fleet R2)  | ~7 s end to end (code-only delta: ~3 s)                            |
| Full              | `deno task test:full`                  | **<= 300 s** (fleet R1) | ~7 s end to end                                                    |
| Changed file only | `deno task test:file tests/<suite>.ts` | —                       | ~1.3 s for the original seven code suites (re-measure after split) |

Composition of the measured fast run: `check:all` (fmt + lint + typecheck) ~0.2 s with a warm
typecheck cache (~5 s cold, i.e. the first run after a Deno upgrade), the mapping guard ~0.9 s, the
original seven code suites ~1.3 s, and the browser journey ~3.6 s when — and only when — the delta
touches it.

Both tiers include `deno task check:all` (fmt + lint + typecheck). The full tier is the fast tier
with every suite, not the affected subset, plus the browser journey.

The deployed gate reads its commands as follows, in this order of preference (do not hand-edit the
global file, and do not assume it is ours — it is machine-global):

1. **Full tier — nothing to install.** `tools/check.conf` leaves `CHECK_CMD` empty on purpose, so
   `fleet-check` falls through to its `deno.json` `.tasks.check` auto-detect and runs
   `deno task check`. That is the durable path: no install, and nothing to lose in a rebuild.
2. **Fast tier — tracked config plus an install step.** There is no auto-detect for this tier, so it
   must be named in `tools/check.conf` (the reviewable source of truth) and copied into place:

```sh
# the values carried by tools/check.conf
CHECK_CMD=""                          # empty => auto-detect `deno task check`
CHECK_FAST_CMD="deno task check:fast"  # fmt/lint/typecheck + affected suites only
CHECK_TIMEOUT=300
CHECK_FAST_TIMEOUT=60
```

```sh
# the install step (back the global file up first; it may belong to another project)
cp -n ~/.fleet/check.conf ~/.fleet/check.conf.bak
bash tools/check-cmd.sh --install
```

`tools/check-cmd.sh` with no arguments prints the resolved set, and with a key name prints that one
value. A per-VM override is sourced second and wins, so a host can retune without editing the
tracked file. `deno task test:full` / `test:fast` are aliases of `check` / `check:fast`, kept
because existing installs and hand-offs name them. After changing any of this,
`deno task test:guards` proves the dispatcher and the config again — including that an unmapped path
still fails closed and that `--install` reproduces the tracked values.

Implementers run `fleet-check --fast`. The **full** gate runs once per landing, on the merger's
merged union — never from an implementer lane while the merger's gate is queued (one heavy slot per
VM).

## Suites

| Suite                             | Covers                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit_format_test.ts`       | `escapeHtml`, `fmtTs`, `fmtDelta`, `clientIp`, `ipv4ToInt`, `cidrContains4`, `uaHeadline`                                                                                                               |
| `tests/unit_keys_test.ts`         | KV index-key shapes and the newest-first ordering the browse pages assume                                                                                                                               |
| `tests/unit_bot_test.ts`          | `classifyBot`: verified / unverified / unverifiable / null, case-insensitivity, IPv4-mapped IPs, fail-closed on an unseeded range source, injected dependencies                                         |
| `tests/unit_views_test.ts`        | pure homepage and trace detail renderers: secret probe paths, canonical URL, escaping, timing waterfall                                                                                                 |
| `tests/unit_probes_test.ts`       | legacy/secret URLs, path-to-hit kinds and generated nested probe references                                                                                                                             |
| `tests/kv_behaviour_test.ts`      | the denormalised KV write path: concurrent sub-request folding (CAS), per-UA aggregate, unknown-trace probes                                                                                            |
| `tests/backfill_test.ts`          | the recent-index legacy schema: rebuild, upgrade in place, idempotency, dangling entries                                                                                                                |
| `tests/backfill_verified_test.ts` | re-tagging traces with the IP-range verdict and mirroring it into both snapshots                                                                                                                        |
| `tests/http_test.ts`              | routing, status codes, security headers, probe/secret gating, cookies, HEAD, canonical redirect, well-known paths, sitemap, trace detail                                                                |
| `tests/cron_test.ts`              | `crons.ts`: the hourly snapshot-repair job - where it registers, what it records, what `/api/health` reports, and the stale / never-ran states                                                          |
| `tests/gate_mapping_test.ts`      | the dispatcher: every tracked file is mapped, an unknown path fails closed, a real delta resolves through `git diff`, the full tier includes the fast suites                                            |
| `tests/gate_config_test.ts`       | `tools/check.conf` + `tools/check-cmd.sh`: the named tasks exist, `--install` reproduces the tracked values, a corrupt per-VM file is replaced rather than sourced, the budgets stay inside fleet R1/R2 |
| `tests/browser_journey_test.ts`   | **full tier only** — a real headless Chrome loads the minted page and the server records the CSS/JS/module/iframe/timing hits                                                                           |

## Affected-path mapping

`tools/fast-gate.sh` maps a changed path to the suites it must run (`--map <path>` prints the
mapping; `--dry-run` prints the resolved set):

| Changed path                                                                        | Suites                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.ts`, `tests/testenv.ts`                                                     | every non-browser suite (entrypoint wiring and shared test environment)                                                                                |
| `storage.ts`                                                                        | `unit_keys_test`, `kv_behaviour_test`, `backfill_test`, `backfill_verified_test`, `http_test`                                                          |
| `bot-verification.ts`                                                               | `unit_bot_test`, `unit_format_test`, `backfill_verified_test`, `http_test`                                                                             |
| `probes.ts`                                                                         | `unit_probes_test`, `http_test`, `kv_behaviour_test` (browser journey remains full-only)                                                               |
| `views.ts`                                                                          | `unit_views_test`, `unit_format_test`, `http_test`                                                                                                     |
| `backfill.ts`                                                                       | `backfill_test`                                                                                                                                        |
| `backfill-verified.ts`                                                              | `backfill_verified_test`, `unit_bot_test`                                                                                                              |
| `crons.ts`                                                                          | `cron_test`, `http_test`, `gate_mapping_test` (the repair schedule and what `/api/health` reports about it; the guard covers the entrypoint placement) |
| `tests/<suite>.ts`                                                                  | that suite, including the browser suite: a change to it is exactly when a browser run is worth paying for                                              |
| `tests/browser_journey_test.ts`                                                     | that suite, run as `deno task test:browser` (~3.6 s)                                                                                                   |
| `deno.json`, `tools/*`, `README.md`, `AGENTS.md`, `docs/*`, `LICENSE`, `.gitignore` | `gate_mapping_test` (the bounded subset that proves the dispatcher still maps; both guard suites run on every invocation anyway)                       |
| anything else                                                                       | **fails closed (exit 2)**, naming the file                                                                                                             |

An empty delta runs every suite: "nothing changed" must never mean "nothing verified". The mapping
is self-checking: `tests/gate_mapping_test.ts` walks `git ls-files` and fails if any tracked file is
unmapped, and proves the fail-closed behaviour with a real unmapped file in the delta. It also
asserts the full tier is a superset of every affected-tier resolution, so "full includes fast" is
tested rather than assumed.

## Hermeticity

The suites are the reason a green gate means something:

- `tests/testenv.ts` redirects `Deno.openKv` to `:memory:` before any KV is opened, so no suite can
  read or write production KV.
- The fast suites run **without `--allow-net`**, so an accidental live fetch (a bot-range refresh,
  for example) fails closed instead of silently reaching the network. Bot ranges are seeded into KV
  instead.
- The browser tier builds its own server in-process (`Deno.serve` over the exported handler), uses
  127.0.0.1 and a throwaway Chrome profile under `artifacts/`, and kills the browser in a `finally`.
- **Isolation: one worker per test file, one in-memory KV per worker.** `deno test` distributes
  files across workers, and a worker that loads a file gets its own evaluation of `tests/testenv.ts`
  and `server.ts` — measured 2026-10-12: two files that both import a shared module with
  module-level state each saw `n=1`, and a KV key written by one file was invisible to the other.
  The caveat: files that import **each other** are merged into one worker (measured: the same probe
  with a direct cross-import saw `n=2`), so suites must never import another suite. State that _is_
  shared within a file (the module-level bot-range cache) is cleared by `clearKv()`, which now drops
  both the KV keys and that cache.
- Absolute assertions start from `clearKv()`; everything else uses unique trace ids and UA names, so
  a suite cannot depend on another one's order or leftovers.

## Known gaps

- `backfill-verified.ts` and `backfill.ts` need a `Deno.Kv` handle rather than the process-wide one;
  that seam is what makes them testable at all.
- The social-unfurler probes (`og-image`, `twitter-image`) and `manifest-icon` have no browser-tier
  assertion: a rendering engine is not expected to fetch them, so the correct verification is an
  HTTP-level one (they are covered by `http_test`), and the browser suite documents why rather than
  asserting a claim a browser cannot make.
- The denormalised stats update is awaited on the probe response path, so under pathological CAS
  contention an asset response can wait up to `CAS_DEADLINE_MS` (2 s). The hit's record and its
  increment are committed by ONE transaction, so the counter and the record set cannot disagree on
  the success path, and the probe path is one round trip cheaper than it used to be: the record
  write used to be its own `kv.set` followed by a separate 2-check/3-set atomic (two sequential KV
  calls), and it is now one 2-check/4-set atomic. The saving is that ROUND TRIP, not an op count -
  the atomic itself carries one more operation. The give-up path writes the record alone and warns,
  naming the repair command, so a give-up leaves the count SHORT of the records rather than losing
  the probe or over-counting it. That trade is not forced by irreparability either:
  `deno task backfill` recomputes every snapshot from the raw hits (preserving the bot verdict the
  earlier rebuild dropped) and verifies what it wrote with a reconcile loop paced by
  `CAS_DEADLINE_MS`, so a snapshot that a lost update left wrong is repairable. That pacing is no
  longer the primary protection for the increment path - the atomic is, so a lost count is
  repairable rather than something the window prevents. What the window still covers is snapshots
  written by versions before that atomic existed, and writers that clobber a snapshot without a CAS
  check (`ua-tracer-5ub`); for those it remains evidence, not proof. What repair cannot reach is a
  record that was never stored at all. Moving the denormalisation off the response path is therefore
  a latency decision nobody has taken rather than a repair-safety one; it is not proposed here.
- A probe's record used to be able to overwrite another one: the hit key was a microsecond
  timestamp, so two hits for one trace that sampled the clock inside the same microsecond collided
  and the later write won (`ua-tracer-6sn`; measured, a 384-way concurrent burst did not reach it,
  which is why it was P3 rather than P1). The key now carries a random suffix, generated once per
  hit before the retry loop, so a retried commit cannot mint a second record for the same hit
  either. Existing records are untouched: every read of a hit is prefix-based and nothing parses a
  hit key's shape, so keys written before the change stay readable with no migration. What is still
  not reconstructible from raw hits is a record that could not be STORED at all - which is why
  client-supplied payloads (the `/timing` array, a report body) are bounded before the write, so an
  over-sized payload costs the payload and not the probe.
- No coverage measurement yet: this change moves the project from zero executing tests to a gate,
  which is the precondition for a coverage threshold.

## Speed rules this gate follows

- **Tests must be independent.** No suite reads another suite's KV, a shared on-disk state, or the
  machine clock's absolute value; assertions are on behaviour, and absolute counts are taken after a
  local `clearKv()`. Tests must fail when the thing they test is broken (each new guard here was
  mutation-checked: a 404'd probe, a no-retry CAS and a flipped expectation each turn a specific
  suite red).
- **The fast tier is the contract.** It is bounded and hermetic; if a change needs more than the
  fast tier, that is stated, not silently absorbed.
- **One full gate per landing.** Never re-run an unchanged tree; verdicts are cached per commit tree
  by `fleet-check`.
