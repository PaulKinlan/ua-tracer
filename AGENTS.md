# AGENTS.md — ua-tracer

Read this before changing anything. It describes what this repo **is at this tip** and the gate your
change must pass. Product detail (probe semantics, user-facing behaviour) is in
[README.md](README.md); gate budgets, the mapping table and measured timings are in
[docs/speed.md](docs/speed.md).

ua-tracer answers "when a user agent fetches a page, what does it actually fetch and does it run the
JS?" by minting a trace per homepage load and serving probe assets that only a real engine reaches.
Live at uatracer.com, Deno Deploy, state in Deno KV.

## Layout

The **entrypoint is `server.ts`** (exported `handler`; Deno Deploy runs it as a dynamic runtime). It
owns the route table, the HTTP semantics (canonical redirect, HEAD, security headers), the periodic
refresh and `Deno.serve` under `import.meta.main`. The request-time work behind it is split by
responsibility, and which top-level modules exist is whatever `git ls-files '*.ts'` says — at the
time of writing that is the table below. **Every one of them must appear in `map_one()` in
`tools/fast-gate.sh`**, and in the table below: `tests/gate_mapping_test.ts` fails when a tracked
top-level `.ts` module is missing from either, which is how `crons.ts` went unmentioned on this page
for as long as it existed (ua-tracer-qir). Do not mirror the tree by hand elsewhere — a refactor
moves modules and must update the map rather than silently making this page false.

| Path                                  | What it is                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`                           | The entrypoint: routing, request/response semantics, the probe-hit write path, `handler`, `Deno.serve`.                                                                                            |
| `storage.ts`                          | The stable KV schema and trace/probe persistence (key builders, `getKv()`, `casRetry`, listing). No HTTP entrypoint imports.                                                                       |
| `bot-verification.ts`                 | Published bot CIDR verification and the `verified` / `unverified` / `unverifiable` verdict; range fetch + cache.                                                                                   |
| `probes.ts`                           | The probe URL contract and the generated resource bodies (CSS/JS/PNG/GIF/woff2/manifest/iframe).                                                                                                   |
| `views.ts`                            | Pure HTML rendering for the pages; storage and network access belong to the entrypoint.                                                                                                            |
| `crons.ts`                            | The scheduled snapshot-repair pass: its `Deno.cron` registration from the entrypoint, the run record it writes, and what `/api/health` reports about it.                                           |
| `backfill.ts`, `backfill-verified.ts` | One-off maintenance over stored traces (`deno task backfill`, `backfill-verify`); both importable, bodies under `import.meta.main`.                                                                |
| `deploy-check.ts`                     | Standalone deploy verification (`deno run --allow-net deploy-check.ts`, ua-tracer-ajc): samples `/api/health` and says whether a revision carrying the build field is serving. Nothing imports it. |
| `tools/fast-gate.sh`                  | The affected-path dispatcher. **The only place the path→suite map exists.**                                                                                                                        |
| `tools/full-gate.sh`                  | Thin wrapper: `fast-gate.sh --all-suites`.                                                                                                                                                         |
| `tools/check.conf`                    | Tracked gate commands + budgets (source of truth for the VM config).                                                                                                                               |
| `tools/check-cmd.sh`                  | Prints the resolved gate values; `--install` writes `~/.fleet/check.conf`.                                                                                                                         |
| `tests/`                              | The suites, plus `tests/testenv.ts` (redirects `Deno.openKv` to `:memory:`).                                                                                                                       |
| `docs/speed.md`                       | Budgets, mapping table, hermeticity rules, measured timings.                                                                                                                                       |
| `artifacts/`                          | Gitignored browser-journey output (screenshot, `summary.json`, Chrome profile).                                                                                                                    |
| `AGENTS.md`                           | This file — the durable rules, not a mirror of the tree.                                                                                                                                           |

## The gate

| Tier        | Command                                  | Budget                                                                               | Who runs it                                                                                          |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Fast        | `deno task check:fast` (= `test:fast`)   | fleet R2, 60 s; measured ~3–7 s                                                      | Every lane, on every change, before hand-off (`fleet-check --fast`).                                 |
| Full        | `deno task check` (= `test:full`)        | fleet R1, 300 s; measured ~8 s warm, ~15 s cold (the browser journey is 4–6 s of it) | **The merger only**, once per landing on the merged union (`fleet-check --full` if you are landing). |
| One suite   | `deno task test:file tests/http_test.ts` | —                                                                                    | While iterating.                                                                                     |
| Guards only | `deno task test:guards`                  | —                                                                                    | When you touch the gate, the config or this file.                                                    |

`deno task check:all` (fmt `--check`, lint, `deno check`) is included in both tiers. The tiers run
across 14 suite files: 2 gate guards, 11 code suites, 1 real-browser journey plus
`tests/testenv.ts`.

`fleet-check` refuses the full gate from a non-merger lane in its own words ("the FULL gate is the
merger's job, not a lane's"), because every non-merger full run costs the VM's single heavy slot a
landing. How the tiers reach `fleet-check`:

- **Full: no VM config.** `tools/check.conf` leaves `CHECK_CMD` empty on purpose, so `fleet-check`
  auto-detects `deno task check` from `deno.json` `.tasks.check` (`~/fleet/bin/fleet-check:209`).
  Keep the `check` task named `check` and running `tools/full-gate.sh`.
- **Fast: installed, because there is no auto-detect for it** (`fleet-check:203-208` prints "no
  CHECK_FAST_CMD … run the focused tests instead" and exits 2). `CHECK_FAST_CMD` comes only from
  `~/.fleet/check.conf`, which is machine-global and may be another project's, so it is
  `bash tools/check-cmd.sh --install` — never a hand-edit.

### The map is the contract

`tools/fast-gate.sh` maps each changed path to the suites it must run and **fails closed** (exit 2,
naming every unmapped path) on a path it does not know. So:

> **A new top-level module, config file or directory must be added to `map_one()` in
> `tools/fast-gate.sh` in the same commit that introduces it.** Until it is, the gate refuses
> _every_ lane's branch, not just yours.

The authoritative map is `map_one()` in `tools/fast-gate.sh`; the table below and the one in
`docs/speed.md` are copies for readers, so a change to the map is a change to all three. That is
asserted rather than asked for: `tests/gate_mapping_test.ts` drives both tables through `--map` and
requires every tracked top-level module to have a row in each of them (ua-tracer-1yo,
ua-tracer-qir).

| Changed path                                                                        | Suites                                                                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `server.ts`, `tests/testenv.ts`                                                     | every non-browser suite                                                                                     |
| `storage.ts` (KV schema)                                                            | `unit_keys`, `kv_behaviour`, `backfill`, `backfill_verified`, `http`                                        |
| `bot-verification.ts`                                                               | `unit_bot`, `unit_format`, `backfill_verified`, `http`                                                      |
| `probes.ts`                                                                         | `unit_probes`, `http`, `kv_behaviour`                                                                       |
| `views.ts`                                                                          | `unit_views`, `unit_format`, `http`                                                                         |
| `backfill.ts`                                                                       | `backfill_test`                                                                                             |
| `backfill-verified.ts`                                                              | `backfill_verified_test`, `unit_bot_test`                                                                   |
| `deploy-check.ts`                                                                   | `deploy_check_test` (standalone: nothing imports it, so only its own suite)                                 |
| `crons.ts`                                                                          | `cron_test`, `http_test`, `gate_mapping_test` (the repair schedule and what `/api/health` reports about it) |
| `tests/<suite>.ts`                                                                  | that suite (a changed browser suite runs the browser journey)                                               |
| `deno.json`, `.gitignore`, `LICENSE`, `README.md`, `AGENTS.md`, `docs/*`, `tools/*` | `gate_mapping_test`                                                                                         |
| anything else                                                                       | **exit 2, fail closed**                                                                                     |

Both guard suites (`gate_mapping_test`, `gate_config_test`) run on every invocation. An empty delta
runs everything: "nothing changed" must never mean "nothing verified".

## Hermeticity (why a green gate means something)

- `tests/testenv.ts` redirects `Deno.openKv` to `:memory:` before any KV is opened **and deletes
  `DENO_KV_ACCESS_TOKEN`**, so no suite can read or write production KV, and the code suites run
  with **no `--allow-net`** so an accidental live fetch fails closed. Bot ranges are seeded into KV
  instead of fetched.
- The browser tier builds its own server in-process on `127.0.0.1`, uses a throwaway Chrome profile
  under `artifacts/`, and closes the browser in a `finally`. One browser at a time.
- Tests must be independent: no reliance on another suite's order, on the machine's state, or on
  files another lane is editing. Files that import each other share a worker, so **no suite may
  import another suite**.

## Deno KV

State lives entirely in KV (Deno Deploy isolates restart often — never an in-memory map):

```
["trace",  id]                -> homepage TraceRecord (UA, IP, headers, verification, secret)
["hit",    id, tsKey]         -> one HitRecord per asset sub-request, in receive order
["recent", reverseTsKey, id]  -> recent index; value is a denormalised TraceStats snapshot
["ua",     normUa, revTs, id] -> per-UA trace index
["ua-agg", normUa]            -> per-UA running aggregate (count, jsRan)
["probe",  reverseTsKey, rid] -> unsolicited / well-known request log
["botranges", name]           -> cached published CIDR list per operator (refreshed daily)
["x-report-body", …]          -> CSP violation report payloads
```

Two things a lane must not break:

1. **`getKv()` is lazy and memoised** (`storage.ts:7`) — never top-level `await Deno.openKv()`; it
   breaks Deno Deploy builds. `DENO_KV_URL` overrides the URL (the tests point it at `:memory:`).
2. **Sub-request hits update the recent-index snapshot through a deadline-bounded compare-and-set**
   (`casRetry`, `CAS_DEADLINE_MS = 2000`, `storage.ts:149`). A plain get→set loses updates: measured
   9 of 12 concurrent sub-requests dropped with the old attempt-bounded loop. Do not simplify it
   back. The write is awaited before the asset response is chosen, so probe latency can reach ~2 s
   under pathological contention — deliberate (a dropped count is permanent), tracked as
   `ua-tracer-c02`.

## Request invariants

- Probes are `/r/{id}/{secret}/{asset}` (legacy `/r/{id}/{asset}` only for traces that have no
  secret). A wrong or missing secret on a secret-bearing trace returns **404, deliberately
  indistinguishable from not-found** so probes cannot enumerate traces. A `GET /` with the
  `ua-tracer-trace` cookie reuses that trace instead of minting a new one (a second browser load is
  not automatically a second trace). `csp-report` / `report` POSTs are answered `204` and their body
  is captured under `["x-report-body", …]`.
- Every asset/probe hit is recorded with the UA, IP, headers and server timestamp; a bot hit is
  tagged **verified** (UA claims bot X and the IP is inside X's published range), **unverified**
  (claims X, the checked IP is not — a spoof) or **unverifiable** (X publishes no ranges, or no
  trusted client address could be established). The address that decides a verdict is the connection
  peer from Deno's `info.remoteAddr`, never a forwarding header: Deno Deploy sets no forwarding
  header of its own, so a client-supplied `x-forwarded-for` arrives verbatim (leftmost _and_
  rightmost hop) and is recorded for context but never trusted. A range source that cannot be
  resolved must classify as _unverified/unverifiable_, never _verified_.
- `*.deno.net` / `*.deno.dev` → `301` to the canonical origin; `/api/health` is exempt so uptime
  monitors are not redirected.
- `HEAD` must return the same headers as `GET` with an empty body.

## Working on this repo (fleet lanes)

- **Work in your own worktree** (`~/worktrees/ua-tracer-<lane>`) on a `fleet/<lane>` branch. Never
  write in the canonical `~/ua-tracer` checkout: it is reset to `origin/main` every 5 minutes.
- Only `fleet/*` branches and `ua-tracer-*` beads belong to this fleet; another fleet works these
  repos too. Fetch before branching or handing off, push early, never force-push anything you do not
  own, and never touch the default branch.
- **One bead per change** (`bd update <id> --claim`). Keep the bead current: file:line detail,
  verification evidence, then label `merge-queue` and write a `LAND-SUMMARY` block in the hand-off
  comment (WHAT / WHY / EFFECT). The merger lands from that, not from the diff.
- **Never self-review.** A reviewer from a different model family reviews the delta
  (`merge-base..tip`). Tests must fail when the thing they cover is broken — mutation-check new
  guards (break it, watch the suite go red, restore).

## Local development

```sh
deno task dev              # http://localhost:8000, --watch
deno task start            # no watch
deno task backfill         # one-off maintenance
deno task backfill-verify  # re-tag traces with the IP-range verdict
```

Requires Deno with `--unstable-kv` (the tasks pass it). Deploy: the KV database must be provisioned
and assigned to the app first (`Deno.openKv()` is not auto-available, and the build fails at warmup
without it), then `deno deploy --org paulkinlan-ea --app ua-tracer --prod` (see `deno.json`
`"deploy"`).
