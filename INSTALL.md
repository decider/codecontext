# Installing codecontext into a repo

There are two distribution models. Pick by who needs it:

- **Plugin path** — fastest for an individual; per-user, not committed to the
  host repo (won't travel to other contributors or CI).
- **Submodule / clone path** — committed *into* the host repo, so the hooks are
  shared by every contributor and run in CI. Use this for a repo you want to
  keep self-documenting for a whole team. (See below.)

## Plugin path (native Claude Code plugin — one command)

codecontext ships a native plugin manifest (`.claude-plugin/plugin.json`) and a
single-plugin marketplace (`.claude-plugin/marketplace.json`), so you can install
it through Claude Code's plugin system:

```text
# In Claude Code:
/plugin marketplace add decider/codecontext      # register the marketplace (once)
/plugin install codecontext@codecontext           # install; hooks auto-wire
/plugin update codecontext@codecontext            # later, pull the latest
```

The hooks reference `${CLAUDE_PLUGIN_ROOT}`, so they resolve wherever Claude Code
installs the plugin — no `tools/codecontext/` path in the host repo. After
installing, bootstrap docs the same way (see "After install — bootstrap").

A repo can auto-enable it for its contributors by committing to `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": { "codecontext": { "source": { "source": "github", "repo": "decider/codecontext" } } },
  "enabledPlugins": { "codecontext@codecontext": true }
}
```

> Note: a plugin install is per-user. For docs that travel with the repo and run
> in CI, use the submodule path below (the two can coexist).

## Quick path (clone + install)

```bash
# 1. Clone the plugin (one-time per machine — pick any path)
git clone https://github.com/decider/codecontext.git ~/.local/share/codecontext

# 2. From inside the host repo:
~/.local/share/codecontext/scripts/install.sh
```

This symlinks the plugin at `<host>/tools/codecontext/`, merges hook entries into `<host>/.claude/settings.json`, ensures `<host>/docs/systems/` exists, and shims `<host>/tools/docgen/` for legacy callers.

## Submodule path (committed into the host repo)

```bash
# Inside the host repo
git submodule add https://github.com/decider/codecontext.git tools/codecontext
tools/codecontext/scripts/install.sh   # detects the submodule is already at tools/codecontext
                                        # and only merges settings + scaffolds dirs

# Update later
git submodule update --remote tools/codecontext
```

## After install — bootstrap

```bash
# Per-directory AUTO_DOCS maps (one-time bootstrap)
node tools/codecontext/docgen/docgen --until-done --parallel 4

# Detect + score systems (one-time full sweep; incremental on push thereafter)
node tools/codecontext/systems-registry/cli.mjs run

# Browse the registry in a local browser
node tools/codecontext/systems-registry/cli.mjs view
```

## After install — day-to-day

Nothing. The push hook (`PostToolUse(Bash)`) sees every `gh pr create` and `git push`, runs both refreshes detached in the background, and commits the diff onto the feature branch. Watch progress at `/tmp/auto-docs-refresh.log`.

## Uninstall

```bash
~/.local/share/codecontext/scripts/install.sh --uninstall
```

This removes `<host>/tools/codecontext/`. The `.claude/settings.json` entries become no-ops (commands point at missing files); edit it manually if you want a clean slate.

## Pluggable judges

Both validators default to `claude -p`. Cross-model judges via env:

```bash
DOCGEN_JUDGE_CMD="codex exec"  node tools/codecontext/docgen/validate-readme.mjs <dir>
SYSREG_JUDGE_CMD="gemini -p"   node tools/codecontext/systems-registry/cli.mjs validate --target <name>
```

## Per-repo context override

Drop `<host>/docs/systems/_context.md` with repo-specific facts the code alone doesn't reveal. Every systems-registry pass appends it to the LLM prompt.

## Updating the plugin

```bash
cd ~/.local/share/codecontext
git pull
# No re-install needed — symlink already points at the updated content.
```

For submodule installs:
```bash
git submodule update --remote tools/codecontext
```
