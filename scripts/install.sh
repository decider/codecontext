#!/usr/bin/env bash
# install.sh — wire the codecontext plugin into a host repo.
#
# Usage (run from inside the host repo):
#   /path/to/codecontext/scripts/install.sh
#
# What it does:
#   1. Verifies the host is a git repo.
#   2. Symlinks (or copies, with --copy) the plugin into <host>/tools/codecontext/.
#   3. Merges hook entries from hooks/settings.json into <host>/.claude/settings.json
#      (preserving any existing hooks; idempotent — re-running is safe).
#   4. Ensures <host>/docs/systems/ exists.
#   5. Adds a tiny tools/docgen/ shim so existing scripts that probe
#      `tools/docgen/docgen` keep working.
#
# Flags:
#   --copy            Copy files instead of symlinking (use when shipping to CI / non-dev machines).
#   --skip-settings   Skip the .claude/settings.json merge (advanced).
#   --uninstall       Remove the plugin + revert settings.json changes.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [[ -z "$HOST_ROOT" ]]; then
  echo "✗ Not in a git repo. Run this from the host repo's root." >&2
  exit 1
fi

MODE="symlink"
SKIP_SETTINGS=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --copy)          MODE="copy" ;;
    --skip-settings) SKIP_SETTINGS=1 ;;
    --uninstall)     UNINSTALL=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

TARGET="$HOST_ROOT/tools/codecontext"

# ── uninstall ──────────────────────────────────────────────────────────────
if (( UNINSTALL )); then
  echo "removing $TARGET"
  rm -rf "$TARGET"
  # Settings.json: leave entries in place (hooks pointing at missing file are no-ops anyway).
  # User can edit manually if they want to clean up.
  echo "✓ uninstalled. Re-run install.sh to bring it back."
  exit 0
fi

# ── 1. install plugin files ────────────────────────────────────────────────
mkdir -p "$(dirname "$TARGET")"

# Submodule case: the plugin already lives AT $TARGET (you ran this as
# tools/codecontext/scripts/install.sh after `git submodule add`). Re-linking
# or copying would clobber the submodule into a self-referential symlink, so
# skip the file-install step entirely and just do settings + scaffolding.
if [[ "$(cd "$PLUGIN_ROOT" && pwd -P)" == "$(cd "$TARGET" 2>/dev/null && pwd -P || echo /nonexistent)" ]]; then
  echo "✓ plugin already in place at $TARGET (submodule) — skipping file install"
elif [[ "$MODE" == "symlink" ]]; then
  if [[ -L "$TARGET" || -e "$TARGET" ]]; then
    rm -rf "$TARGET"
  fi
  ln -s "$PLUGIN_ROOT" "$TARGET"
  echo "✓ symlinked $TARGET → $PLUGIN_ROOT"
else
  rm -rf "$TARGET"
  cp -R "$PLUGIN_ROOT" "$TARGET"
  echo "✓ copied $PLUGIN_ROOT → $TARGET"
fi

# Shim so callers that look for tools/docgen/docgen still work.
DOCGEN_SHIM="$HOST_ROOT/tools/docgen"
if [[ ! -e "$DOCGEN_SHIM" ]]; then
  ln -s "codecontext/docgen" "$DOCGEN_SHIM"
  echo "✓ shimmed $DOCGEN_SHIM → tools/codecontext/docgen"
fi

# ── 2. ensure host has docs/systems/ ───────────────────────────────────────
mkdir -p "$HOST_ROOT/docs/systems"
echo "✓ ensured $HOST_ROOT/docs/systems/"

# ── 3. merge .claude/settings.json ─────────────────────────────────────────
if (( ! SKIP_SETTINGS )); then
  SETTINGS="$HOST_ROOT/.claude/settings.json"
  mkdir -p "$(dirname "$SETTINGS")"
  if [[ ! -f "$SETTINGS" ]]; then
    cp "$PLUGIN_ROOT/hooks/settings.json" "$SETTINGS"
    # Strip the _comment field for cleanliness.
    node -e "const f='$SETTINGS';const s=JSON.parse(require('fs').readFileSync(f));delete s._comment;require('fs').writeFileSync(f,JSON.stringify(s,null,2)+'\n');"
    echo "✓ created $SETTINGS (fresh)"
  else
    # Merge plugin's hook entries into existing settings.
    node "$PLUGIN_ROOT/scripts/merge-settings.mjs" "$SETTINGS" "$PLUGIN_ROOT/hooks/settings.json"
    echo "✓ merged plugin hooks into $SETTINGS"
  fi
fi

echo
echo "✅ codecontext installed in $HOST_ROOT"
echo
echo "Next:"
echo "  1) Bootstrap READMEs:   node tools/codecontext/docgen/docgen --until-done --parallel 4"
echo "  2) Detect + score systems:   node tools/codecontext/systems-registry/cli.mjs run"
echo "  3) Browse the registry:   node tools/codecontext/systems-registry/cli.mjs view"
