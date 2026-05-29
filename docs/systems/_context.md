# Repo context (injected into every systems-registry LLM pass)

> NOTE: a full `systems-registry run` may prune this file as an "orphan".
> It is intentionally committed and is read by `pass1.mjs`. Restore with
> `git checkout` if a full run removes it; incremental `refresh` won't.

codecontext is an LLM-driven auto-documentation toolkit + Claude Code plugin.
It is itself a small monorepo of cooperating tools:

1. **docgen** — writes one `AUTO_DOCS.md` per directory via an LLM.
2. **systems-registry** — detects cross-file systems, writes per-system manifests
   with mermaid loops, scores them with an LLM judge, builds a static HTML viewer.
3. **context-injection** — PreToolUse hooks that inject the nearest map + matching
   system mermaid into Claude's context when it reads/edits a file.
4. **auto-docs-refresh** — a PostToolUse hook that refreshes docs on push and
   commits the diff back onto the branch.

Validators default to `claude -p`; override with `DOCGEN_JUDGE_CMD` /
`SYSREG_JUDGE_CMD`. Keep all examples vendor-neutral. Do NOT promote
`systems-registry/evals/` to a system.
