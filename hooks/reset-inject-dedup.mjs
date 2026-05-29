#!/usr/bin/env node
/**
 * reset-inject-dedup.mjs — wipe the per-session dedup files used by
 * docgen's inject-readme-context.mjs and systems-registry's inject.mjs.
 *
 * Why this exists:
 *   Both inject hooks dedup by session_id so that the same README or
 *   system page doesn't get re-emitted on every subsequent file touch.
 *   That assumption ("session_id == what's still in the model's working
 *   context") breaks when the conversation is compacted — the diagrams
 *   and READMEs are evicted from context, but the dedup file still
 *   says "already injected" and the hooks silently skip them.
 *
 *   This hook clears the dedup files so the very next file Read after
 *   compaction (or a new session, or a /clear) re-injects the relevant
 *   per-dir README + system diagram.
 *
 * Wire it as PreCompact AND SessionStart in .claude/settings.json:
 *   PreCompact   — fires before compaction; clears the slate so the
 *                  re-population starts fresh after compact lands.
 *   SessionStart — defense in depth for /clear and brand-new sessions;
 *                  a new session_id usually means a fresh dedup file
 *                  anyway, but cleanup also removes orphaned files
 *                  from previous /clear'd sessions in the same shell.
 *
 * Contract:
 *   stdin:  JSON { session_id?, ... }  (the hook payload; we only need
 *           session_id, everything else is ignored)
 *   stdout: nothing (no JSON envelope needed — PreCompact/SessionStart
 *           don't inject context, they just reset state)
 *   exit:   always 0 (never block compaction or session start)
 *
 * Both inject scripts have minor naming differences in their dedup
 * paths — docgen sanitizes session_id chars and uses /tmp, while
 * systems-registry uses os.tmpdir() and the raw session_id. This script
 * mirrors both naming schemes so a single PreCompact firing clears
 * both regardless of which OS tmpdir resolves to.
 */

import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/** All possible dedup file paths for a session_id, across both scripts'
 *  conventions and across both tmpdir resolutions. We try each and
 *  delete what exists. Each `unlinkSync` is wrapped in try/catch so a
 *  missing file (the normal case) never bubbles. */
export function candidatePaths(sessionId) {
  const raw = sessionId || 'unknown';
  const safe = (sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_');
  const dirs = new Set([tmpdir(), '/tmp']);
  const paths = [];
  for (const dir of dirs) {
    paths.push(join(dir, `systems-registry-injected-${raw}.json`));
    paths.push(join(dir, `docgen-injected-${safe}.json`));
    if (raw !== 'unknown') paths.push(join(dir, `systems-registry-injected-unknown.json`));
    if (safe !== 'nosession') paths.push(join(dir, `docgen-injected-nosession.json`));
  }
  return [...new Set(paths)];
}

export function resetDedup(sessionId) {
  const removed = [];
  for (const p of candidatePaths(sessionId)) {
    try {
      if (existsSync(p)) {
        unlinkSync(p);
        removed.push(p);
      }
    } catch { /* ignore — never block on cleanup */ }
  }
  return removed;
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { /* keep empty */ }
  const sessionId = payload.session_id || process.env.CLAUDE_SESSION_ID || null;
  // hook_event_name is provided by Claude Code (PreCompact or SessionStart)
  // so we know WHY the reset fired — the operator wants both visible.
  const reason = payload.hook_event_name || process.env.CLAUDE_HOOK_EVENT || 'reset';
  const removed = resetDedup(sessionId);

  // Telemetry — best-effort, no-throw. The "track when we reset context"
  // signal the operator asked for explicitly. Reset events are sparse
  // (a handful per session) so this is a low-volume but high-value row.
  try {
    const { writeEvent, writeIndexEntry } = await import('../telemetry/writer.mjs');
    writeEvent({
      hook: 'reset-inject-dedup',
      event: 'reset',
      sid: sessionId,
      reason,
      extra: { dedup_files_removed: removed?.length ?? 0, removed_paths: removed },
    });
    // Also rollup at the index level so cross-session reset-frequency
    // is one read away.
    writeIndexEntry({
      sid: sessionId,
      kind: 'session-reset',
      extra: { reason, dedup_files_removed: removed?.length ?? 0 },
    });
  } catch { /* never block */ }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => { /* never block */ }).finally(() => process.exit(0));
}
