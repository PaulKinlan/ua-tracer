# Gate speed budget

ua-tracer is a single-file Deno app (`server.ts`, ~2.7k lines) with no build step,
so the gate is `deno fmt` + `deno lint` + `deno check` + `deno test`. This file is
the contract for how long each tier may take and which suite a change must run.

## Tiers and budgets

| Tier | Command | Budget | Measured (2026-10-12, 2-vCPU VM, warm) |
| --- | --- | --- | --- |
| Fast | `deno task test:fast` | **<= 60 s** (fleet R2) | ~7 s end to end (code-only delta: ~3 s) |
| Full | `deno task test:full` | **<= 300 s** (fleet R1) | ~7 s end to end |
| Changed file only | `deno task test:file tests/<suite>.ts` | — | ~1.3 s for all seven code suites |

Composition of the measured fast run: `check:all` (fmt + lint + typecheck) ~0.2 s
with a warm typecheck cache (~5 s cold, i.e. the first run after a Deno upgrade),
the mapping guard ~0.9 s, the seven code suites ~1.3 s, and the browser journey
~3.6 s when — and only when — the delta touches it.

Both tiers include `deno task check:all` (fmt + lint + typecheck). The full tier
is the fast tier with every suite, not the affected subset, plus the browser
journey.

The deployed gate reads its commands from `~/.fleet/check.conf`, which is
**machine-global** and copied there by the tracked config. The tracked source of
truth is `tools/check.conf`; `bash tools/check-cmd.sh --install` writes it out (and
`tools/check-cmd.sh` with no arguments prints the resolved set):

```sh
CHECK_CMD="deno task check"          # every suite + the browser journey
CHECK_FAST_CMD="deno task check:fast" # fmt/lint/typecheck + affected suites only
CHECK_TIMEOUT=300
CHECK_FAST_TIMEOUT=60
```

`CHECK_CMD` may also be empty: fleet-check then falls through to its
`deno.json` `.tasks.check` auto-detect, which needs no install step. Either way the
full tier is the `check` task — `deno task test:full` is an alias kept because the
hand-off and the VM's current install name it. The fast tier has **no** auto-detect,
so `check:fast` (`test:fast`) is the only way it reaches the deployed gate. After
changing the gate, `deno task test:guards` proves the dispatcher and the config
again — including that an unmapped path still fails closed and that `--install`
reproduces the tracked values.

Implementers run `fleet-check --fast`. The **full** gate runs once per landing, on
the merger's merged union — never from an implementer lane while the merger's gate
is queued (one heavy slot per VM).

## Suites

| Suite | Covers |
| --- | --- |
| `tests/unit_format_test.ts` | `escapeHtml`, `fmtTs`, `fmtDelta`, `clientIp`, `ipv4ToInt`, `cidrContains4`, `uaHeadline` |
| `tests/unit_keys_test.ts` | KV index-key shapes and the newest-first ordering the browse pages assume |
| `tests/unit_bot_test.ts` | `classifyBot`: verified / unverified / unverifiable / null, case-insensitivity, IPv4-mapped IPs, fail-closed on an unseeded range source |
| `tests/kv_behaviour_test.ts` | the denormalised KV write path: concurrent sub-request folding (CAS), per-UA aggregate, unknown-trace probes |
| `tests/backfill_test.ts` | the recent-index legacy schema: rebuild, upgrade in place, idempotency, dangling entries |
| `tests/backfill_verified_test.ts` | re-tagging traces with the IP-range verdict and mirroring it into both snapshots |
| `tests/http_test.ts` | routing, status codes, security headers, probe/secret gating, cookies, HEAD, canonical redirect, well-known paths, sitemap, trace detail |
| `tests/gate_mapping_test.ts` | the dispatcher: every tracked file is mapped, an unknown path fails closed, a real delta resolves through `git diff`, the full tier includes the fast suites |
| `tests/gate_config_test.ts` | `tools/check.conf` + `tools/check-cmd.sh`: the named tasks exist, `--install` reproduces the tracked values, a corrupt per-VM file is replaced rather than sourced, the budgets stay inside fleet R1/R2 |
| `tests/browser_journey_test.ts` | **full tier only** — a real headless Chrome loads the minted page and the server records the CSS/JS/module/iframe/timing hits |

## Affected-path mapping

`tools/fast-gate.sh` maps a changed path to the suites it must run (`--map <path>`
prints the mapping; `--dry-run` prints the resolved set):

| Changed path | Suites |
| --- | --- |
| `server.ts`, `tests/testenv.ts` | every non-browser suite (routing, KV schema and the whole write path live in the entrypoint; the browser journey stays the full gate's job so Chrome is not in every fast run) |
| `backfill.ts` | `backfill_test` |
| `backfill-verified.ts` | `backfill_verified_test`, `unit_bot_test` |
| `tests/<suite>.ts` | that suite, including the browser suite: a change to it is exactly when a browser run is worth paying for |
| `tests/browser_journey_test.ts` | that suite, run as `deno task test:browser` (~3.6 s) |
| `deno.json`, `tools/*`, `README.md`, `docs/*`, `LICENSE`, `.gitignore` | `gate_mapping_test` (the bounded subset that proves the dispatcher still maps; both guard suites run on every invocation anyway) |
| anything else | **fails closed (exit 2)**, naming the file |

An empty delta runs every suite: "nothing changed" must never mean "nothing
verified". The mapping is self-checking: `tests/gate_mapping_test.ts` walks
`git ls-files` and fails if any tracked file is unmapped, and proves the
fail-closed behaviour with a real unmapped file in the delta. It also asserts the
full tier is a superset of every affected-tier resolution, so "full includes
fast" is tested rather than assumed.

## Hermeticity

The suites are the reason a green gate means something:

- `tests/testenv.ts` redirects `Deno.openKv` to `:memory:` before any KV is
  opened, so no suite can read or write production KV.
- The fast suites run **without `--allow-net`**, so an accidental live fetch (a
  bot-range refresh, for example) fails closed instead of silently reaching the
  network. Bot ranges are seeded into KV instead.
- The browser tier builds its own server in-process (`Deno.serve` over the exported
  handler), uses 127.0.0.1 and a throwaway Chrome profile under `artifacts/`, and
  kills the browser in a `finally`.
- **Isolation: one worker per test file, one in-memory KV per worker.** `deno test`
  distributes files across workers, and a worker that loads a file gets its own
  evaluation of `tests/testenv.ts` and `server.ts` — measured 2026-10-12: two files
  that both import a shared module with module-level state each saw `n=1`, and a KV
  key written by one file was invisible to the other. The caveat: files that import
  **each other** are merged into one worker (measured: the same probe with a direct
  cross-import saw `n=2`), so suites must never import another suite. State that
  *is* shared within a file (the module-level bot-range cache) is cleared by
  `clearKv()`, which now drops both the KV keys and that cache.
- Absolute assertions start from `clearKv()`; everything else uses unique trace ids
  and UA names, so a suite cannot depend on another one's order or leftovers.

## Known gaps

- `backfill-verified.ts` and `backfill.ts` need a `Deno.Kv` handle rather than the
  process-wide one; that seam is what makes them testable at all.
- The social-unfurler probes (`og-image`, `twitter-image`) and `manifest-icon` have
  no browser-tier assertion: a rendering engine is not expected to fetch them, so
  the correct verification is an HTTP-level one (they are covered by `http_test`),
  and the browser suite documents why rather than asserting a claim a browser
  cannot make.
- The denormalised stats update is awaited on the probe response path, so under
  pathological CAS contention an asset response can wait up to `CAS_DEADLINE_MS`
  (2 s). The trade-off is deliberate — a dropped count is a permanent data error,
  a rare slow probe is not — and the give-up path logs a warning rather than
  dropping silently. Moving the denormalisation off the response path is the real
  fix and is filed as its own follow-up rather than smuggled into this change.
- No coverage measurement yet: this change moves the project from zero executing
  tests to a gate, which is the precondition for a coverage threshold.

## Speed rules this gate follows

- **Tests must be independent.** No suite reads another suite's KV, a shared
  on-disk state, or the machine clock's absolute value; assertions are on
  behaviour, and absolute counts are taken after a local `clearKv()`. Tests must
  fail when the thing they test is broken (each new guard here was
  mutation-checked: a 404'd probe, a no-retry CAS and a flipped expectation each
  turn a specific suite red).
- **The fast tier is the contract.** It is bounded and hermetic; if a change needs
  more than the fast tier, that is stated, not silently absorbed.
- **One full gate per landing.** Never re-run an unchanged tree; verdicts are
  cached per commit tree by `fleet-check`.
