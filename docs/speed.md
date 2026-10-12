# Gate speed budget

ua-tracer is a single-file Deno app (`server.ts`, ~2.7k lines) with no build step,
so the gate is `deno fmt` + `deno lint` + `deno check` + `deno test`. This file is
the contract for how long each tier may take and which suite a change must run.

## Tiers and budgets

| Tier | Command | Budget | Measured (2026-10-12, 2-vCPU VM, warm) |
| --- | --- | --- | --- |
| Fast | `deno task test:fast` | **<= 60 s** (fleet R2) | ~8 s affected / ~10 s `--all-suites` |
| Full | `deno task test:full` | **<= 300 s** (fleet R1) | ~14 s |
| Changed file only | `deno task test:file tests/<suite>.ts` | — | ~2 s |

Both tiers include `deno task check:all` (fmt + lint + typecheck). The full tier
is the fast tier with every suite, not the affected subset, plus the browser
journey.

`~/.fleet/check.conf` (VM-local, not in this repo) points at these:

```sh
CHECK_CMD="deno task test:full"
CHECK_FAST_CMD="deno task test:fast"
CHECK_TIMEOUT=300
CHECK_FAST_TIMEOUT=60
```

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
| `tests/gate_mapping_test.ts` | this dispatcher: every tracked file is mapped, an unknown path fails closed, the full tier includes the fast suites |
| `tests/browser_journey_test.ts` | **full tier only** — a real headless Chrome loads the minted page and the server records the CSS/JS/module/iframe/timing hits |

## Affected-path mapping

`tools/fast-gate.sh` maps a changed path to the suites it must run (`--map <path>`
prints the mapping; `--dry-run` prints the resolved set):

| Changed path | Suites |
| --- | --- |
| `server.ts`, `tests/testenv.ts` | every non-browser suite (routing, KV schema and the whole write path live in the entrypoint) |
| `backfill.ts` | `backfill_test` |
| `backfill-verified.ts` | `backfill_verified_test`, `unit_bot_test` |
| `tests/<suite>.ts` | that suite |
| `tests/browser_journey_test.ts` | **fails closed (exit 5)** — run `deno task test:browser`; the fast tier cannot certify it |
| `deno.json`, `tools/*`, `README.md`, `docs/*`, `LICENSE`, `.gitignore` | `gate_mapping_test` (the bounded subset that proves the dispatcher still maps) |
| anything else | **fails closed (exit 2)**, naming the file |

An empty delta runs every suite: "nothing changed" must never mean "nothing
verified". The mapping is self-checking: `tests/gate_mapping_test.ts` walks
`git ls-files` and fails if any tracked file is neither mapped nor explicitly
full-gate-only, and proves the fail-closed behaviour with a real unmapped file in
the delta.

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
- Each suite file is a separate Deno test worker with its own in-memory KV, so
  suites cannot depend on each other's order or state.

## Known gaps

- `backfill-verified.ts` and `backfill.ts` need a `Deno.Kv` handle rather than the
  process-wide one; that seam is what makes them testable at all.
- The social-unfurler probes (`og-image`, `twitter-image`) and `manifest-icon` have
  no browser-tier assertion: a rendering engine is not expected to fetch them, so
  the correct verification is an HTTP-level one (they are covered by `http_test`).
- No coverage measurement yet: this change moves the project from zero executing
  tests to a gate, which is the precondition for a coverage threshold.

## Speed rules this gate follows

- **Tests must be independent.** No suite reads another suite's KV, a shared
  on-disk state, or the machine clock's absolute value; assertions are on
  behaviour, and absolute counts are taken after a local `clearKv()`.
- **The fast tier is the contract.** It is bounded and hermetic; if a change needs
  more than the fast tier, that is stated, not silently absorbed.
- **One full gate per landing.** Never re-run an unchanged tree; verdicts are
  cached per commit tree by `fleet-check`.
