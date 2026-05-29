#!/usr/bin/env node
/**
 * systems-registry — PreToolUse inject hook for Claude Code.
 *
 * Sibling to docgen's inject-readme-context.mjs but operates at the
 * SYSTEM level rather than per-directory: when Claude is about to touch
 * any file whose path matches a glob in docs/systems/*.md front-matter,
 * the matching system's Mermaid + page link gets emitted on stdout and
 * fed into the next LLM turn as additional context.
 *
 * The result: edit services/api/workflow/shortlist.ts → next turn
 * automatically sees docs/systems/request-pipeline.md, including the
 * full loop diagram, without anyone reading it explicitly.
 *
 * Contract with Claude Code:
 *   stdin:  JSON { tool_name, tool_input, session_id }
 *   stdout: extra context for the next LLM view
 *   exit 0: ok; non-zero: block. We NEVER block.
 *
 * Per-session dedup via /tmp/systems-registry-injected-<sid>.json so the
 * same system page never gets re-emitted on every subsequent Read in a
 * file it already injected for. The dedup file mirrors docgen's pattern.
 */

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { loadAll, match, renderInjection } from './registry.mjs';

const TOOLS_WITH_PATHS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep']);

/** Find the HOST repo's root, even when this hook lives inside a submodule.
 *
 *  History: this used to start from the hook file's own directory and run
 *  `git rev-parse --show-toplevel`. That returned the SUBMODULE root once
 *  codecontext was installed as a submodule (e.g. `tools/codecontext/`),
 *  not the host repo — so loadAll() looked for `docs/systems/*.md` inside
 *  the plugin (which is empty), got 0 systems, and the hook silently
 *  exited 0 on every Read. No mermaid ever got injected.
 *
 *  Fix: prefer the payload's cwd (Claude Code passes the host repo's cwd),
 *  fall back to process.cwd(), then ask git for the SUPERPROJECT working
 *  tree (the parent repo of a submodule) — only then fall back to
 *  --show-toplevel from the hook file dir.
 */
function findRepoRoot(hookFilePath, payloadCwd) {
  const candidates = [payloadCwd, process.cwd(), dirname(hookFilePath)].filter(Boolean);
  for (const c of candidates) {
    // First try: are we inside a submodule? If so, jump to the parent repo.
    try {
      const sp = execFileSync('git', ['rev-parse', '--show-superproject-working-tree'], {
        cwd: c, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (sp) return sp;
    } catch { /* not in a repo, or git missing — try next candidate */ }
    // Otherwise: normal toplevel.
    try {
      const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: c, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return out;
    } catch { /* try next */ }
  }
  return null;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function dedupeFilePath(sessionId) {
  return join(tmpdir(), `systems-registry-injected-${sessionId || 'unknown'}.json`);
}

function loadDedupe(path) {
  if (!existsSync(path)) return { systems: [] };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { systems: [] }; }
}

function saveDedupe(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  } catch { /* never block */ }
}

function targetPathFrom(input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path || input.path || input.pattern || null;
}

// reason codes (additive — older callers that only destructured { lines,
// newDedupe } keep working): 'injected' | 'deduped' | 'out-of-repo' |
// 'no-match' | 'system-page' | 'no-target' | 'tool-no-paths'. main()
// only emits telemetry for 'injected' + 'deduped' so the log stops
// drowning in out-of-repo noise (memory files, ~/ paths, etc.).
export function injectionPlan({ payload, repoRoot, systems, dedupe }) {
  const tool = payload?.tool_name;
  if (!TOOLS_WITH_PATHS.has(tool)) return { lines: [], newDedupe: dedupe, reason: 'tool-no-paths' };
  const target = targetPathFrom(payload.tool_input);
  if (!target) return { lines: [], newDedupe: dedupe, reason: 'no-target' };

  const rel = isAbsolute(target) ? relative(repoRoot, target) : target;
  if (!rel || rel.startsWith('..')) return { lines: [], newDedupe: dedupe, reason: 'out-of-repo' };

  // Skip if the target is itself a system page — avoid re-injecting.
  if (rel.startsWith('docs/systems/')) return { lines: [], newDedupe: dedupe, reason: 'system-page' };

  const matched = match(systems, rel);
  if (matched.length === 0) return { lines: [], newDedupe: dedupe, reason: 'no-match' };

  const already = new Set(dedupe.systems || []);
  const lines = [];
  for (const sys of matched) {
    if (already.has(sys.name)) continue;
    already.add(sys.name);
    lines.push(renderInjection(sys));
  }
  if (lines.length === 0) return { lines: [], newDedupe: dedupe, reason: 'deduped' };
  return { lines, newDedupe: { systems: [...already] }, reason: 'injected' };
}

async function main() {
  let exitedOk = false;
  try {
    const raw = readStdin();
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }

    const repoRoot = findRepoRoot(import.meta.url.replace('file://', ''), payload?.cwd) || process.cwd();
    const systems = loadAll(repoRoot);
    if (systems.length === 0) { exitedOk = true; process.exit(0); }

    const sessionId = payload.session_id || process.env.CLAUDE_SESSION_ID || 'unknown';
    const dedupePath = dedupeFilePath(sessionId);
    const dedupe = loadDedupe(dedupePath);

    const { lines, newDedupe, reason } = injectionPlan({ payload, repoRoot, systems, dedupe });
    const targetForLog = payload?.tool_input?.file_path || payload?.tool_input?.path || null;
    if (lines.length > 0) {
      saveDedupe(dedupePath, newDedupe);
      // CRITICAL: a PreToolUse hook's plain stdout goes to the user transcript,
      // NOT the model. The only path into Claude's context is the JSON
      // hookSpecificOutput.additionalContext field (capped ~10k chars).
      // Without this envelope the mermaid+page-link gets dropped silently —
      // we'd notice it ourselves when a Read of a glob-matching file produces
      // a docgen block but no systems-registry block. See docgen's
      // inject-readme-context.mjs for the same pattern.
      const MAX_CONTEXT_CHARS = 10000;
      let contextText = lines.join('\n\n');
      if (contextText.length > MAX_CONTEXT_CHARS) {
        contextText = contextText.slice(0, MAX_CONTEXT_CHARS) + '\n…(injected systems context truncated to fit the 10k limit)';
      }
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: contextText,
        },
      }));
      // Telemetry — best-effort, no-throw. Records each system-manifest
      // injection so the operator can see cumulative context burn.
      try {
        const { writeEvent } = await import('../telemetry/writer.mjs');
        writeEvent({
          hook: 'systems-registry-inject',
          event: 'injected',
          sid: sessionId,
          target_file: targetForLog,
          bytes_emitted: contextText.length,
          extra: { repo_root: repoRoot, blocks: lines.length },
        });
      } catch { /* never block */ }
    } else if (reason === 'deduped') {
      // Telemetry for REAL dedup-only fires (a glob match existed but the
      // system was already injected this session). The other empty-result
      // reasons — 'out-of-repo', 'no-match', 'system-page', 'no-target',
      // 'tool-no-paths' — are skipped silently: they represent the hook
      // firing on a file it has nothing to say about (memory files, ~/
      // paths, unrelated source) and previously flooded the log as fake
      // `deduped` events that obscured what was actually being suppressed.
      try {
        const { writeEvent } = await import('../telemetry/writer.mjs');
        writeEvent({
          hook: 'systems-registry-inject',
          event: 'deduped',
          sid: sessionId,
          target_file: targetForLog,
          bytes_emitted: 0,
          extra: { repo_root: repoRoot },
        });
      } catch { /* never block */ }
    }
    exitedOk = true;
    process.exit(0);
  } catch {
    // Never block on any failure.
    if (!exitedOk) process.exit(0);
  }
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.endsWith('inject.mjs')) {
  main().catch(() => process.exit(0));
}
