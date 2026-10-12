#!/usr/bin/env bash
# Full gate for ua-tracer — the merger's once-per-landing job.
#
# Every suite, whatever the delta: fmt + lint + typecheck, the non-browser suites
# (hermetic, no --allow-net) and the real-browser journey (Chrome over a
# localhost in-process server). This is a superset of the fast gate by
# construction — both are the same dispatcher, `tools/fast-gate.sh`.
#
# Called through CHECK_CMD as `deno task test:full`. Never run it from an
# implementer lane while the merger's gate is queued: there is one heavy slot per
# VM and the merger never waits.
set -euo pipefail

readonly SELF="full-gate"
# Plain-text log: the fleet's coverage parser reads this output (see tools/fast-gate.sh,
# which this script execs and which sets the same variable for the suites it runs).
export NO_COLOR=1
cd "$(git rev-parse --show-toplevel)"

echo "$SELF: every suite (not affected-only), including the browser journey" >&2
exec bash tools/fast-gate.sh --all-suites
