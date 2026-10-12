#!/usr/bin/env bash
# Resolve the gate's command configuration: the TRACKED default, with a per-VM override
# allowed to win.
#
# tools/check.conf is what a fresh VM gets and what a reviewer can read in the diff;
# `tools/check-cmd.sh --install` writes its values into ~/.fleet/check.conf, where the
# deployed gate (~/fleet/bin/fleet-check) reads CHECK_FAST_CMD from, and where CHECK_CMD is
# read on hosts that have no project-local lookup. Edit tools/check.conf, re-run --install.
#
# USAGE
#   tools/check-cmd.sh                       # print the resolved set
#   tools/check-cmd.sh CHECK_CMD             # print one resolved value
#   tools/check-cmd.sh --install             # write the tracked values to the per-VM file
#
# ENV
#   FLEET_CHECK_CONF   the per-VM config path (default ~/.fleet/check.conf). Honoured by
#                      tests/gate_config_test.ts so the install can be exercised without
#                      touching the real machine-global file.
#
# IT FAILS LOUD. The tracked file is sourced, so a syntax error in it is fatal, and a
# missing CHECK_CMD is an error rather than an empty string: a gate that silently
# substitutes a command nobody chose reports a verdict about the wrong thing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACKED="$ROOT/tools/check.conf"
OVERRIDE="${FLEET_CHECK_CONF:-$HOME/.fleet/check.conf}"

if [ ! -r "$TRACKED" ]; then
  echo "check-cmd: the TRACKED gate config is missing: $TRACKED" >&2
  echo "  It is the default a fresh VM gets and the file a reviewer can read. Refusing." >&2
  exit 2
fi

# shellcheck source=tools/check.conf
. "$TRACKED"

# The tracked file must DECIDE both tiers. CHECK_CMD may legitimately be empty (fleet-check
# then auto-detects deno.json .tasks.check), but the key must be present rather than
# forgotten, and the fast tier has no auto-detect so it must name a command.
if [ -z "${CHECK_CMD+x}" ]; then
  echo "check-cmd: CHECK_CMD is not declared in $TRACKED - refusing to report a verdict about a command nobody chose" >&2
  exit 2
fi
: "${CHECK_FAST_CMD:?check-cmd: CHECK_FAST_CMD is unset or empty in $TRACKED - the fast tier has no auto-detect, so refusing instead of running the wrong thing}"

# DO NOT SOURCE THE OVERRIDE BEFORE --install. If the existing per-VM file is malformed or
# corrupted, an installer whose whole job is to replace it with clean tracked defaults must
# not fail by reading the broken file first.
if [ "${1:-}" = "--install" ]; then
  dest="$OVERRIDE"
  mkdir -p "$(dirname "$dest")"

  # ~/.fleet/check.conf is machine-global: say so when replacing a file another project
  # installed, because that silently changes the gate for that project too.
  if [ -f "$dest" ] && ! grep -q "ua-tracer" "$dest" 2>/dev/null; then
    echo "check-cmd: WARNING: overwriting $dest, which was not stamped by ua-tracer" >&2
    echo "check-cmd: it is machine-global, so another project on this host was reading it" >&2
  fi

  {
    printf '%s\n' "# Written by tools/check-cmd.sh --install from tools/check.conf."
    printf '%s\n' "# Project: ua-tracer ($ROOT)"
    printf '%s\n' "# WARNING: MACHINE-GLOBAL. fleet-check reads this file for any repo invoked on this"
    printf '%s\n' "# host, so running --install replaces the active gate command for all of them."
    printf '%s\n' "# DO NOT HAND-EDIT FOR TUNING: a hand-edit and a stale install are indistinguishable."
    printf '%s\n' "# Edit tools/check.conf and re-run: bash tools/check-cmd.sh --install"
    grep -E '^[A-Z_]+=' "$TRACKED"
  } > "$dest"
  echo "check-cmd: installed the project's gate command into $dest"
  exit 0
fi

# The per-VM override is optional and is sourced second, so its values win. An empty
# CHECK_CMD in the override is meaningful (auto-detect), so only an undeclared key is an
# error.
if [ -r "$OVERRIDE" ]; then
  # shellcheck disable=SC1090
  . "$OVERRIDE"
fi

if [ -z "${CHECK_CMD+x}" ]; then
  echo "check-cmd: CHECK_CMD is undeclared after reading $OVERRIDE - refusing to report a verdict about a command nobody chose" >&2
  exit 2
fi

want="${1:-}"
case "$want" in
  "")
    # Quoted assignments, so this output can be re-sourced: an unquoted value with
    # spaces (`deno task check`) is ambiguous to anything re-reading it.
    printf 'CHECK_CMD="%s"\nCHECK_FAST_CMD="%s"\nCHECK_TIMEOUT=%s\nCHECK_FAST_TIMEOUT=%s\n' \
      "${CHECK_CMD}" "${CHECK_FAST_CMD:-}" "${CHECK_TIMEOUT:-}" "${CHECK_FAST_TIMEOUT:-}"
    if [ -z "$CHECK_CMD" ]; then
      printf '%s\n' "# CHECK_CMD is empty: fleet-check auto-detects 'deno task check' from deno.json"
    fi
    ;;
  CHECK_CMD | CHECK_FAST_CMD | CHECK_TIMEOUT | CHECK_FAST_TIMEOUT)
    printf '%s\n' "${!want:-}"
    ;;
  *)
    echo "check-cmd: unknown key: $want" >&2
    exit 3
    ;;
esac
