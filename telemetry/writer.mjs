// Cross-session telemetry for context-injection hooks.
//
// Lives at ~/.claude-telemetry/ (machine-wide, NOT in any single repo) so
// the operator can audit context burn across every Claude session and every
// repo they touch. The hooks (inject-readme-context, auto-docs-refresh,
// reset-inject-dedup, systems-registry inject) call writeEvent() at their
// natural recording points and exit normally.
//
// Best-effort: every failure is swallowed. Telemetry MUST NEVER block a
// hook — a write that throws would interrupt the actual context flow into
// Claude.
//
// File layout:
//   ~/.claude-telemetry/
//     sessions/<sid>.jsonl    one event per line, append-only
//     index.jsonl             session-level summaries (start/end/totals)

import { existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Tests + tooling can redirect the log location via CLAUDE_TELEMETRY_ROOT
// (e.g. point it at a mkdtemp dir so the suite doesn't write to the
// operator's real ~/.claude-telemetry/). Resolved per-call rather than
// at import-time so subprocess-spawned tests that flip the env right
// before calling can redirect a freshly-spawned hook instance.
export function telemetryRoot() {
  return process.env.CLAUDE_TELEMETRY_ROOT || join(homedir(), '.claude-telemetry');
}
export function sessionsDir() { return join(telemetryRoot(), 'sessions'); }
export function indexPath() { return join(telemetryRoot(), 'index.jsonl'); }

// Back-compat constants — frozen at import-time, kept so existing
// imports keep resolving. Callers that need test-redirection should
// use telemetryRoot() / sessionsDir() / indexPath() instead.
export const TELEMETRY_ROOT = telemetryRoot();
export const SESSIONS_DIR = sessionsDir();
export const INDEX_PATH = indexPath();

// Disabling switch: set CLAUDE_TELEMETRY_DISABLED=1 to suppress every
// hook's logging in one toggle (useful if a hook is somehow causing
// disk pressure). Default is on — that's the whole point of having it.
export function isDisabled() {
  return process.env.CLAUDE_TELEMETRY_DISABLED === '1';
}

// Best-effort directory ensure. If this throws (read-only HOME, weird
// permissions), the caller's catch eats it. Reads from sessionsDir()
// each call so env-redirection works for subprocess-spawned hooks.
function ensureRoot() {
  const dir = sessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Sanitise a session id for use as a filename. Sessions arrive as
// Claude-supplied opaque strings — usually UUIDs, occasionally "unknown".
function sanitiseSid(sid) {
  return String(sid || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

// writeEvent({hook, event, sid, cwd, target_file, bytes_emitted,
//             files_injected, reason, extra})
//   hook            — which hook fired (string)
//   event           — what happened: 'injected' | 'deduped' | 'reset' |
//                     'refresh-spawned' | 'refresh-skipped' | 'noop' | …
//   sid             — Claude session id, or 'unknown' if absent
//   cwd             — process.cwd() at fire time (so we know which repo)
//   target_file     — the file the hook was triggered around (optional)
//   bytes_emitted   — payload size delivered to stdout (optional)
//   files_injected  — list of README/system paths emitted (optional)
//   reason          — for resets: 'PreCompact' | 'SessionStart'
//   extra           — arbitrary metadata bag (kept flat, no nesting)
// Returns true on successful write, false on any failure.
export function writeEvent(input) {
  if (isDisabled()) return false;
  try {
    ensureRoot();
    const sid = sanitiseSid(input?.sid);
    const path = join(sessionsDir(), `${sid}.jsonl`);
    const row = {
      ts: new Date().toISOString(),
      sid,
      cwd: input?.cwd ?? process.cwd(),
      hook: input?.hook ?? 'unknown',
      event: input?.event ?? 'noop',
      target_file: input?.target_file ?? null,
      bytes_emitted: typeof input?.bytes_emitted === 'number' ? input.bytes_emitted : null,
      files_injected: Array.isArray(input?.files_injected) ? input.files_injected : null,
      reason: input?.reason ?? null,
      ...(input?.extra && typeof input.extra === 'object' ? input.extra : {}),
    };
    appendFileSync(path, JSON.stringify(row) + '\n');
    return true;
  } catch {
    return false;
  }
}

// writeIndexEntry — coarse session-level rollup. Called by the
// PreCompact/SessionStart reset path so we get a heartbeat row in the
// index whenever context boundaries cross. Also called from the CLI
// when generating session summaries.
export function writeIndexEntry(input) {
  if (isDisabled()) return false;
  try {
    ensureRoot();
    const row = {
      ts: new Date().toISOString(),
      sid: sanitiseSid(input?.sid),
      kind: input?.kind ?? 'session-boundary',
      ...(input?.extra && typeof input.extra === 'object' ? input.extra : {}),
    };
    appendFileSync(indexPath(), JSON.stringify(row) + '\n');
    return true;
  } catch {
    return false;
  }
}

// sessionFilePath(sid) — for the CLI viewer to enumerate events.
export function sessionFilePath(sid) {
  return join(sessionsDir(), `${sanitiseSid(sid)}.jsonl`);
}

// sessionFileSize(sid) — quick rollup; returns 0 on missing file.
export function sessionFileSize(sid) {
  try {
    const s = statSync(sessionFilePath(sid));
    return s.size;
  } catch {
    return 0;
  }
}
