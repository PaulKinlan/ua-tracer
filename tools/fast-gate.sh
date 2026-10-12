#!/usr/bin/env bash
# Fast gate for ua-tracer: formatting + lint + typecheck, plus ONLY the test
# suites a change actually affects.
#
# The full gate (`deno task test:full`) is the merger's once-per-landing job and
# includes the real-browser journey. Implementers run `fleet-check --fast`, which
# invokes this script through CHECK_FAST_CMD. It is deterministic, hermetic (no
# network: the suites run without --allow-net) and fails closed: a changed path
# that is not mapped to a suite exits non-zero and names the file, because a file
# nobody has mapped must be seen rather than silently verified by nothing.
#
# USAGE
#   tools/fast-gate.sh                  # affected suites for the current delta
#   tools/fast-gate.sh --all-suites     # every non-browser suite (used by test:full)
#   tools/fast-gate.sh --map <path>     # suites for one path (used by the mapping test)
#   tools/fast-gate.sh --dry-run        # print the resolved suite set, run nothing
#
# ENV
#   GIT_BASE   base ref for the delta (default: origin/main)
#
# EXIT
#   0 ok   1 a suite failed   2 a changed path is unmapped
#   3 usage   4 the base ref cannot be resolved   5 the delta needs the full gate
set -euo pipefail

readonly SELF="fast-gate"

# The non-browser suites, in a fixed order so two runs of the same delta are
# comparable. Everything here must run hermetically under `deno task test:file`
# (--unstable-kv --allow-env, and deliberately NOT --allow-net).
FAST_SUITES=(
  tests/unit_format_test.ts
  tests/unit_keys_test.ts
  tests/unit_bot_test.ts
  tests/kv_behaviour_test.ts
  tests/backfill_test.ts
  tests/backfill_verified_test.ts
  tests/http_test.ts
)

# Runs on every invocation, whatever the delta: it is the guard for this mapping
# (every tracked file must be mapped; an unknown path must fail closed). It needs
# --allow-run/--allow-read, so it runs as its own deno task.
ALWAYS_SUITES=(tests/gate_mapping_test.ts)

# Needs a browser and a live localhost server, so it cannot run under the fast
# gate's permissions. A delta touching it fails closed here (exit 5) and names the
# command that can certify it, rather than passing on no evidence.
FULL_ONLY_SUITES=(tests/browser_journey_test.ts)

usage() {
  cat >&2 <<'EOF'
usage: tools/fast-gate.sh [--all-suites | --dry-run | --map <path> | --help]

  (no args)        run fmt/lint/typecheck + the suites affected by the delta
  --all-suites     run every non-browser suite, whatever the delta
  --dry-run        print the resolved suite set and exit
  --map <path>     print the suites one path maps to (exit 2 if unmapped)

env: GIT_BASE  base ref for the delta (default origin/main)
exit: 0 ok  1 suite failed  2 unmapped path  3 usage  4 bad base  5 needs full gate
EOF
}

# map_one <path>: print the suites that path affects.
# 0 mapped, 2 unknown, 5 full-gate-only.
map_one() {
  local f="$1" s
  for s in "${FULL_ONLY_SUITES[@]}"; do
    if [[ "$f" == "$s" ]]; then return 5; fi
  done
  case "$f" in
    # The entrypoint holds routing, the KV schema and the whole KV write path, so
    # every non-browser suite is affected. `tests/testenv.ts` is shared by all.
    server.ts | tests/testenv.ts)
      printf '%s\n' "${FAST_SUITES[@]}"
      ;;
    backfill.ts)
      printf '%s\n' tests/backfill_test.ts
      ;;
    # Re-tags traces using classifyBot and rewrites the index snapshots, so both
    # the bot contract and the backfill contract apply.
    backfill-verified.ts)
      printf '%s\n' tests/backfill_verified_test.ts tests/unit_bot_test.ts
      ;;
    tests/*.ts)
      # A changed test runs itself.
      printf '%s\n' "$f"
      ;;
    # Config, tooling and documentation are not code, but they are still input to
    # this gate: the mapping test is the bounded subset that proves the dispatcher
    # still maps and still fails closed.
    deno.json | .gitignore | LICENSE | README.md | docs/* | tools/*)
      printf '%s\n' tests/gate_mapping_test.ts
      ;;
    *)
      return 2
      ;;
  esac
}

# changed_files: the committed delta vs the merge-base, plus working-tree changes
# (so the gate is usable before you commit). Prints one path per line.
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
    # An empty delta must not mean "verify nothing".
    echo "$SELF: empty delta vs $(git rev-parse --short HEAD); running every suite" >&2
    printf '%s\n' "${FAST_SUITES[@]}"
    return 0
  fi

  local -a resolved=() full_only=() unknown=()
  local f out rc
  for f in "${files[@]}"; do
    # `|| rc=$?` rather than an if/else: the exit status of a false `if` with no
    # else branch is 0, so reading `$?` after it silently turns every failure
    # into "mapped" (or into this arm's internal error).
    rc=0
    out="$(map_one "$f")" || rc=$?
    if [[ $rc -eq 0 ]]; then
      local line
      while IFS= read -r line; do [[ -n "$line" ]] && resolved+=("$line"); done <<<"$out"
      continue
    fi
    case "$rc" in
      5) full_only+=("$f") ;;
      2) unknown+=("$f") ;;
      *)
        echo "$SELF: internal error mapping '$f' (exit $rc)" >&2
        return 4
        ;;
    esac
  done

  if [[ ${#unknown[@]} -gt 0 ]]; then
    echo "$SELF: UNMAPPED changed path(s): ${unknown[*]}" >&2
    echo "$SELF: add an arm to map_one() in $0 for each path above." >&2
    return 2
  fi
  if [[ ${#full_only[@]} -gt 0 ]]; then
    echo "$SELF: ${full_only[*]} needs the full gate (browser): run 'deno task test:browser'" >&2
    return 5
  fi
  printf '%s\n' "${resolved[@]}" | sort -u
}

run_suites() {
  local -a suites=("$@")
  echo "$SELF: check:all (fmt + lint + typecheck)" >&2
  deno task check:all
  echo "$SELF: mapping guard" >&2
  deno task test:mapping
  if [[ ${#suites[@]} -eq 0 ]]; then
    echo "$SELF: nothing affected, nothing more to run" >&2
    return 0
  fi
  echo "$SELF: suites: ${suites[*]}" >&2
  local start=$SECONDS
  deno task test:file "${suites[@]}"
  echo "$SELF: ${#suites[@]} suite(s) finished in $((SECONDS - start))s" >&2
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
    printf '%s\n' "${ALWAYS_SUITES[@]}" "${FAST_SUITES[@]}" | sort -u
    exit 0
  fi
  run_suites "${FAST_SUITES[@]}"
  exit $?
fi

# `cmd || exit $?` (not `if ! cmd`) so a non-zero exit survives; under `if !` the
# status read is the negation's, which is always 0.
resolved_out="$(resolve_delta)" || exit $?
affected=()
if [[ -n "$resolved_out" ]]; then mapfile -t affected <<<"$resolved_out"; fi

if ((dry_run)); then
  printf '%s\n' "${ALWAYS_SUITES[@]}" "${affected[@]}" | sort -u
  exit 0
fi

run_suites "${ALWAYS_SUITES[@]}" "${affected[@]}"
