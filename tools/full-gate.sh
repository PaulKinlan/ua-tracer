#!/usr/bin/env bash
# Full gate for ua-tracer — the merger's once-per-landing job.
#
# Same fast suites (fmt + lint + typecheck + every non-browser suite, whatever the
# delta) plus the real-browser journey, which needs Chrome and a live localhost
# server and therefore cannot run under the fast gate.
#
# Called through CHECK_CMD as `deno task test:full`. Never run from an implementer
# lane while the merger's gate is queued: there is one heavy slot per VM.
set -euo pipefail

readonly SELF="full-gate"
cd "$(git rev-parse --show-toplevel)"

echo "$SELF: fast suites (all, not affected-only)" >&2
bash tools/fast-gate.sh --all-suites

echo "$SELF: browser journey" >&2
deno task test:browser
