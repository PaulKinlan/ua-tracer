#!/usr/bin/env bash
# Fast gate for ua-tracer: formatting + lint + typecheck, plus ONLY the test
# suites a change actually affects.
#
# The full gate (`deno task test:full`) runs every suite, whatever the delta, and
# is the merger's once-per-landing job. Implementers run `fleet-check --fast`,
# which invokes this script through CHECK_FAST_CMD.
#
# It is deterministic, hermetic for the code suites (no --allow-net, so an
# accidental live fetch fails closed) and never silently skips work: a changed
# path that maps to no suite exits non-zero and names the file, and the browser
# journey runs whenever the delta touches it.
#
# USAGE
#   tools/fast-gate.sh                  # affected suites for the current delta
#   tools/fast-gate.sh --all-suites     # every suite, whatever the delta (used by test:full)
#   tools/fast-gate.sh --map <path>     # suites for one path (used by the mapping test)
#   tools/fast-gate.sh --dry-run        # print the resolved suite set, run nothing
#
# ENV
#   GIT_BASE   base ref for the delta (default: origin/main)
#
# EXIT
#   0 ok   1 a suite failed   2 a changed path is unmapped
#   3 usage   4 the base ref cannot be resolved
set -euo pipefail

readonly SELF="fast-gate"

# NO COLOUR IN THE GATE LOG. ~/fleet/remote/check-coverage.py parses this output to record
# which suites ran and which changed files it could not attribute, and ANSI escapes break
# that matching: with colour, a captured suite name is `tests/http_test.ts\x1b[0m`, which
# compares unequal to `tests/http_test.ts`, so every changed file was published as
# "unmapped" and every suite as "omitted" in the cached verdict (measured 2026-10-12 on
# f564d6a). A reviewer reads that record, so it has to be plain text.
# f564d6a). A reviewer reads that record, so it has to be plain text. (The one escape left
# in the log is Deno's own `Task …` banner, which `fleet-check` prints before this script
# runs and which carries no suite names, so the parser is unaffected.)
export NO_COLOR=1

# Hermetic suites: `deno task test:file` (--unstable-kv --allow-env, and
# deliberately NOT --allow-net). Fixed order so two runs of the same delta are
# comparable.
FAST_SUITES=(
  tests/unit_format_test.ts
  tests/unit_keys_test.ts
  tests/unit_bot_test.ts
  tests/unit_views_test.ts
  tests/unit_probes_test.ts
  tests/kv_behaviour_test.ts
  tests/backfill_test.ts
  tests/backfill_verified_test.ts
  tests/cron_test.ts
  tests/http_test.ts
  tests/deploy_check_test.ts
)

# Suites that need Chrome and a live localhost server, so they run through their
# own deno task. They are NOT part of every fast run: a change to server.ts is
# verified by the code suites here and by the browser journey in the full gate.
BROWSER_SUITES=(tests/browser_journey_test.ts)

# Runs on every invocation, whatever the delta: the guards for the gate itself -
# the mapping (every tracked file is mapped; an unknown path fails closed) and the
# tracked check.conf (the two commands the deployed gate runs, and that --install writes
# exactly those). They need --allow-run/--allow-read/--allow-write, so they are their own
# deno task.
ALWAYS_SUITES=(tests/gate_mapping_test.ts tests/gate_config_test.ts)

ALL_SUITES=("${FAST_SUITES[@]}" "${BROWSER_SUITES[@]}")

usage() {
  cat >&2 <<'EOF'
usage: tools/fast-gate.sh [--all-suites | --dry-run | --map <path> | --help]

  (no args)        run fmt/lint/typecheck + the suites affected by the delta
  --all-suites     run every suite, whatever the delta (what test:full does)
  --dry-run        print the resolved suite set and exit
  --map <path>     print the suites one path maps to (exit 2 if unmapped)

env: GIT_BASE  base ref for the delta (default origin/main)
exit: 0 ok  1 suite failed  2 unmapped path  3 usage  4 bad base
EOF
}

is_browser_suite() {
  local s
  for s in "${BROWSER_SUITES[@]}"; do
    [[ "$1" == "$s" ]] && return 0
  done
  return 1
}

is_always_suite() {
  local s
  for s in "${ALWAYS_SUITES[@]}"; do
    [[ "$1" == "$s" ]] && return 0
  done
  return 1
}

# map_one <path>: print the suites that path affects. 0 mapped, 2 unknown.
map_one() {
  local f="$1"
  case "$f" in
    # The entrypoint wires every contract; testenv is shared by all suites.
    # Browser journeys remain in the full gate unless their own file changes.
    server.ts | tests/testenv.ts)
      printf '%s\n' "${FAST_SUITES[@]}"
      ;;
    storage.ts)
      printf '%s\n' tests/unit_keys_test.ts tests/kv_behaviour_test.ts tests/backfill_test.ts tests/backfill_verified_test.ts tests/http_test.ts
      ;;
    bot-verification.ts)
      printf '%s\n' tests/unit_bot_test.ts tests/unit_format_test.ts tests/backfill_verified_test.ts tests/http_test.ts
      ;;
    probes.ts)
      printf '%s\n' tests/unit_probes_test.ts tests/http_test.ts tests/kv_behaviour_test.ts
      ;;
    views.ts)
      printf '%s\n' tests/unit_views_test.ts tests/unit_format_test.ts tests/http_test.ts
      ;;
    backfill.ts)
      printf '%s\n' tests/backfill_test.ts
      ;;
    # Schedules the snapshot repair pass. It is imported by the entrypoint and its
    # registration is what /api/health reports on, so both suites apply.
    crons.ts)
      printf '%s\n' tests/cron_test.ts tests/http_test.ts tests/gate_mapping_test.ts
      ;;
    # Re-tags traces using classifyBot and rewrites the index snapshots, so both
    # the bot contract and the backfill contract apply.
    backfill-verified.ts)
      printf '%s\n' tests/backfill_verified_test.ts tests/unit_bot_test.ts
      ;;
    # A standalone deploy check (ua-tracer-ajc): nothing imports it, so only its own
    # suite is affected. Its fetch is injected, so the suite stays hermetic.
    deploy-check.ts)
      printf '%s\n' tests/deploy_check_test.ts
      ;;
    # A changed test runs itself (the browser suite included: a change to it is
    # exactly when the browser run is worth paying for).
    tests/*.ts)
      printf '%s\n' "$f"
      ;;
    # Config, tooling and documentation are not code, but they are still input to
    # this gate: the mapping guard is the bounded subset that proves the dispatcher
    # still maps and still fails closed (and the config guard runs on every
    # invocation regardless).
    deno.json | .gitignore | LICENSE | README.md | AGENTS.md | docs/* | tools/* | .github/*)
      printf '%s\n' tests/gate_mapping_test.ts
      ;;
    *)
      return 2
      ;;
  esac
}

# changed_files: the committed delta vs the merge-base, plus working-tree changes
# (so the gate is usable before you commit). One path per line.
changed_files() {
  local base="${GIT_BASE:-origin/main}"
  if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    echo "$SELF: base ref '$base' not found (set GIT_BASE=<ref>)" >&2
    return 4
  fi
  local merge_base
  merge_base="$(git merge-base "$base" HEAD)"
  {
    git diff --name-only "$merge_base" HEAD
    git status --porcelain --untracked-files=all -z |
      while IFS= read -r -d '' entry; do printf '%s\n' "${entry:3}"; done
  } | sort -u
}

# resolve_delta: print the suite set the delta affects (one per line).
resolve_delta() {
  local files_out
  # `cmd || return $?` rather than `if ! cmd; then return $?`: under `if !`, `$?`
  # is the status of the negation (always 0), so a bad base ref would silently
  # resolve to "nothing to verify" instead of failing the gate.
  files_out="$(changed_files)" || return $?
  local -a files=()
  if [[ -n "$files_out" ]]; then mapfile -t files <<<"$files_out"; fi
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "$SELF: empty delta vs $(git rev-parse --short HEAD); running every suite" >&2
    printf '%s\n' "${ALL_SUITES[@]}"
    return 0
  fi

  local -a resolved=() unknown=()
  local f out rc
  for f in "${files[@]}"; do
    # `|| rc=$?` rather than an if/else: the exit status of a false `if` with no
    # else branch is 0, so reading `$?` after it turns every failure into
    # "mapped" and the fail-closed arms below never fire.
    rc=0
    out="$(map_one "$f")" || rc=$?
    if [[ $rc -eq 0 ]]; then
      local line
      while IFS= read -r line; do [[ -n "$line" ]] && resolved+=("$line"); done <<<"$out"
      continue
    fi
    case "$rc" in
      2) unknown+=("$f") ;;
      *)
        echo "$SELF: internal error mapping '$f' (exit $rc)" >&2
        return 4
        ;;
    esac
  done

  if [[ ${#unknown[@]} -gt 0 ]]; then
    # The `fast-gate: unmapped:` form is a CONTRACT with the fleet's log parser
    # (~/fleet/remote/check-coverage.py matches exactly this marker and publishes the list
    # with the cached verdict). The human-readable lines below are for the lane reading it.
    echo "$SELF: unmapped: ${unknown[*]}" >&2
    echo "$SELF: UNMAPPED changed path(s): ${unknown[*]}" >&2
    echo "$SELF: add an arm to map_one() in $0 for each path above." >&2
    return 2
  fi
  printf '%s\n' "${resolved[@]}" | sort -u
}

run_suites() {
  local -a fast=() browser=()
  local s
  for s in "$@"; do
    if is_browser_suite "$s"; then
      browser+=("$s")
      continue
    fi
    # The mapping guard needs different permissions and already ran above.
    if is_always_suite "$s"; then continue; fi
    fast+=("$s")
  done

  echo "$SELF: check:all (fmt + lint + typecheck)" >&2
  deno task check:all
  echo "$SELF: gate guards (mapping + tracked check.conf)" >&2
  deno task test:guards

  local start=$SECONDS
  if [[ ${#fast[@]} -gt 0 ]]; then
    # Same contract as `unmapped:` above: this marker is how the fleet's parser learns the
    # exact suite names that ran, in a form it can match without guessing at runner output.
    echo "$SELF: ran: ${fast[*]}" >&2
    echo "$SELF: fast suites: ${fast[*]}" >&2
    deno task test:file "${fast[@]}"
    echo "$SELF: ${#fast[@]} fast suite(s) in $((SECONDS - start))s" >&2
  fi
  if [[ ${#browser[@]} -gt 0 ]]; then
    local browser_start=$SECONDS
    echo "$SELF: ran: ${browser[*]}" >&2
    echo "$SELF: browser suites (headless Chrome): ${browser[*]}" >&2
    deno task test:browser
    echo "$SELF: browser suite in $((SECONDS - browser_start))s" >&2
  fi
  if [[ ${#fast[@]} -eq 0 && ${#browser[@]} -eq 0 ]]; then
    echo "$SELF: nothing affected, nothing more to run" >&2
  fi
}

dry_run=0
all_suites=0
map_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help | -h)
      usage
      exit 0
      ;;
    --dry-run) dry_run=1 ;;
    --all-suites) all_suites=1 ;;
    --map)
      if [[ $# -lt 2 ]]; then
        usage
        exit 3
      fi
      map_path="$2"
      shift
      ;;
    *)
      echo "$SELF: unknown argument: $1" >&2
      usage
      exit 3
      ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$map_path" ]]; then
  set +e
  map_one "$map_path"
  exit $?
fi

if ((all_suites)); then
  if ((dry_run)); then
    printf '%s\n' "${ALWAYS_SUITES[@]}" "${ALL_SUITES[@]}" | sort -u
    exit 0
  fi
  run_suites "${ALL_SUITES[@]}"
  exit $?
fi

resolved_out="$(resolve_delta)" || exit $?
affected=()
if [[ -n "$resolved_out" ]]; then mapfile -t affected <<<"$resolved_out"; fi

if ((dry_run)); then
  printf '%s\n' "${ALWAYS_SUITES[@]}" "${affected[@]}" | sort -u
  exit 0
fi

run_suites "${ALWAYS_SUITES[@]}" "${affected[@]}"
