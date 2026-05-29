#!/usr/bin/env bash
# safe-pr-create.sh — non-blocking `gh pr create` wrapper.
#
# Why this exists: `gh pr create` is single-shot but its caller looks
# stuck because (a) the pre-push hook runs `auto-docs-refresh` in the
# background and prints nothing for ~30-90s, (b) turbo lint/typecheck
# in the pre-commit hook is silent, (c) heredoc bodies with backticks
# in command-substitution sometimes flake the shell parser.
#
# This script writes the body to a real file (no shell quoting issues),
# runs gh in the background with a hard timeout, and exits the moment
# the URL is returned — so callers don't think a 60s hook is a hang.
#
# Usage:
#   scripts/safe-pr-create.sh \
#     --title "feat(x): …" \
#     --body-file path/to/body.md \
#     [--base main] [--head <branch>] [--timeout 180]

set -euo pipefail
TITLE=""; BODY_FILE=""; BASE="main"; HEAD=""; TIMEOUT=180
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)       TITLE="$2"; shift 2;;
    --body-file)   BODY_FILE="$2"; shift 2;;
    --base)        BASE="$2"; shift 2;;
    --head)        HEAD="$2"; shift 2;;
    --timeout)     TIMEOUT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -z "$TITLE" || -z "$BODY_FILE" ]] && { echo "usage: $0 --title T --body-file F [--base B] [--head H] [--timeout S]" >&2; exit 2; }
[[ -f "$BODY_FILE" ]] || { echo "no such body file: $BODY_FILE" >&2; exit 2; }
[[ -z "$HEAD" ]] && HEAD=$(git rev-parse --abbrev-ref HEAD)

LOG=$(mktemp -t safe-pr-create.XXXXXX)
echo "running: gh pr create --base $BASE --head $HEAD …" >&2
echo "log: $LOG" >&2

gh pr create --base "$BASE" --head "$HEAD" --title "$TITLE" --body-file "$BODY_FILE" >"$LOG" 2>&1 &
GH_PID=$!

# Poll with a hard cap. Print every 10s so the caller knows it's alive.
ELAPSED=0
while kill -0 "$GH_PID" 2>/dev/null; do
  if (( ELAPSED >= TIMEOUT )); then
    echo "⚠️  gh pr create exceeded ${TIMEOUT}s — killing pid $GH_PID" >&2
    kill -9 "$GH_PID" 2>/dev/null || true
    cat "$LOG" >&2
    exit 124
  fi
  sleep 5
  ELAPSED=$((ELAPSED+5))
  echo "  still running (${ELAPSED}s)…" >&2
done

# Process exited — surface its rc and the URL.
wait "$GH_PID" || RC=$?
RC=${RC:-0}
cat "$LOG"
exit "$RC"
