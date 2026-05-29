#!/usr/bin/env node
// PostToolUse hook — refresh auto-docs when the agent opens or updates a PR.
//
// Wired in .claude/settings.json as PostToolUse(Bash). It fires after every
// Bash tool call but does real work ONLY when the command opens or updates a
// PR: `gh pr create` (new PR) or `git push` of a feature branch (PR update).
// That makes the refresh PER-PR — independent of how long a session lasts,
// and independent of git worktrees / squash-merge timing. It runs under the
// user's own Claude Code auth, so there is no CI, no API key, and no
// machine-global git hook to install — clone the repo, use Claude Code, and
// the docs stay fresh.
//
// Portable across repos: it auto-detects which doc tools are present (docgen —
// vendored as either tools/docgen or tools/claude-code-auto-documentation —
// and systems-registry) and refreshes whichever exist.
//
// On a qualifying command it: locates the worktree the command ran in, diffs
// the branch against origin/main, runs scoped refreshes, and — if any docs
// changed — commits them onto the branch and pushes, so the fresh docs ride
// the squash-merge into main.
//
// Safety: ALWAYS exits 0 (never blocks a tool call); is an instant no-op for
// the vast majority of Bash calls; never touches main; a per-HEAD-sha marker
// stops it re-running for the same state (so create-then-push won't
// double-run); AUTODOC_SKIP=1 guards against re-entry; a lockfile stops
// overlapping refreshes from piling up; and each refresh has a generous
// timeout that SIGKILLs a hung/runaway child so nothing is ever left running.

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, realpathSync, statSync, rmSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG = '/tmp/auto-docs-refresh.log';
const log = (m) => { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };

const REFRESH_TIMEOUT_MS = 8 * 60 * 1000;
const LOCK_STALE_MS = 20 * 60 * 1000;

// docgen + systems-registry can be (a) vendored directly in the host repo under
// tools/docgen|tools/claude-code-auto-documentation|tools/systems-registry, or
// (b) shipped inside this codecontext bundle (submodule/plugin) as a sibling of
// this hook. Probe host-repo paths first (a local copy wins), then fall back to
// the tools that ship beside this very file — so the refresh works no matter
// where the bundle is mounted (e.g. tools/codecontext/), without a shim.
const BUNDLE_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // <bundle> (this file is <bundle>/hooks/…)
const DOCGEN_REPO_BINS = ['tools/docgen/docgen', 'tools/claude-code-auto-documentation/docgen'];
const SYSREG_REPO_CLIS = ['tools/systems-registry/cli.mjs'];

/** Ordered absolute docgen-bin candidates: host-repo copies, then the bundled sibling. */
export function docgenCandidates(root) {
  return [...DOCGEN_REPO_BINS.map(p => join(root, p)), join(BUNDLE_DIR, 'docgen', 'docgen')];
}

/** Ordered absolute systems-registry CLI candidates: host-repo copy, then the bundled sibling. */
export function sysregCandidates(root) {
  return [...SYSREG_REPO_CLIS.map(p => join(root, p)), join(BUNDLE_DIR, 'systems-registry', 'cli.mjs')];
}

// ── pure helpers (exported for tests) ───────────────────────────────────────

/** True when the command opens (`gh pr create`) or updates (`git push`) a PR. */
export function isPrCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  if (/\bgh\s+pr\s+create\b/.test(cmd)) return true;
  if (/\bgit\s+push\b/.test(cmd) && !/--delete\b/.test(cmd) && !/\spush\s+\S+\s+:\S/.test(cmd)) return true;
  return false;
}

/** Best-effort working dir: parse `cd X &&` / `git -C X` from the command, else fallback. */
export function workdirFromCommand(cmd, fallback) {
  if (typeof cmd === 'string') {
    const cd = cmd.match(/(?:^|&&|;|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s&;|]+)/);
    if (cd) return cd[1].replace(/^['"]|['"]$/g, '');
    const gc = cmd.match(/git\s+-C\s+("[^"]+"|'[^']+'|[^\s&;|]+)/);
    if (gc) return gc[1].replace(/^['"]|['"]$/g, '');
  }
  return fallback;
}

/** Of a `git status --porcelain` listing, the doc files we own (AUTO_DOCS.md, docgen state, system docs). */
export function docPathsFromStatus(porcelain) {
  return porcelain.split('\n')
    .map(l => l.slice(3).trim()).filter(Boolean)
    .map(p => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
    .filter(p => /(^|\/)AUTO_DOCS\.md$/.test(p) || /(^|\/)\.docgen\/state\.json$/.test(p) || p.startsWith('docs/systems'));
}

// ── side-effecting runner ───────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Real path of the .git dir for this worktree. In a normal clone this is
 *  `<root>/.git`. In a git WORKTREE `.git` is a file pointing to
 *  `<main>/.git/worktrees/<name>` — writing to `<root>/.git/foo` fails
 *  with "not a directory". Use `rev-parse --git-dir` so the marker +
 *  lock land in the right place either way. */
function gitDir(root) {
  try { return git(['rev-parse', '--git-dir'], root); } catch { return join(root, '.git'); }
}

// The hook is split into two phases. `main()` is the fast PostToolUse path
// — it MUST return within milliseconds so Claude Code's Bash tool isn't
// blocked. Everything that does I/O work (fetch, docgen, sysreg-refresh,
// commit, push) runs in `runDetachedWorker()`, spawned by main() as a fully
// detached child whose stdio is reattached to the log file. main() unrefs
// the child and returns 0 immediately. Previously this was all synchronous
// execFileSync inline, which blocked the push for 5-8 minutes per the
// /tmp/auto-docs-refresh.log timeline.
// Best-effort telemetry helper. Used in main() to record both the
// spawn AND the skip-paths so the operator can see when refresh-on-push
// is firing vs being suppressed by markers/locks.
async function _telemetry(sessionId, event, extra) {
  try {
    const { writeEvent } = await import('../telemetry/writer.mjs');
    writeEvent({ hook: 'auto-docs-refresh', event, sid: sessionId, extra });
  } catch { /* never block */ }
}

async function main() {
  if (process.env.AUTODOC_SKIP === '1') return;

  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  let data; try { data = JSON.parse(raw); } catch { return; }
  if (data.tool_name !== 'Bash') return;

  const sid = data.session_id || process.env.CLAUDE_SESSION_ID || 'unknown';
  const cmd = data.tool_input && data.tool_input.command;
  if (!isPrCommand(cmd)) return;

  const cwd = workdirFromCommand(cmd, data.cwd || process.cwd());

  let root;
  try { root = git(['rev-parse', '--show-toplevel'], cwd); } catch { log(`not a git repo: ${cwd}`); await _telemetry(sid, 'refresh-skipped', { reason: 'not-a-git-repo', cwd }); return; }

  let branch;
  try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root); } catch { return; }
  if (!branch || branch === 'HEAD' || branch === 'main' || branch === 'master') { log(`skip branch=${branch}`); await _telemetry(sid, 'refresh-skipped', { reason: 'main-branch', branch, root }); return; }

  // We intentionally do NOT fetch / diff here — those are I/O-bound and run
  // in the worker. We DO do the cheap marker + lock checks so we don't even
  // bother spawning a worker if a recent run already covered this HEAD.
  const head = git(['rev-parse', 'HEAD'], root);
  const gd = gitDir(root);
  const marker = join(gd, 'auto-docs-refresh.sha');
  try { if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === head) { log(`already refreshed ${head}; skip spawn`); await _telemetry(sid, 'refresh-skipped', { reason: 'already-refreshed', head, root }); return; } } catch { /* ignore */ }

  // ATOMIC lock take. We claim the lock HERE (in the fast hook path, before
  // spawning the worker) using openSync with O_CREAT|O_EXCL — the kernel
  // guarantees only one of two concurrent main() calls succeeds, so we
  // can't double-spawn workers for the same HEAD. Stale locks are reaped
  // by mtime, same as before.
  const lock = join(gd, 'auto-docs-refresh.lock');
  try {
    if (existsSync(lock) && (Date.now() - statSync(lock).mtimeMs) < LOCK_STALE_MS) {
      log('another refresh in progress (lock held) — skip spawn');
      await _telemetry(sid, 'refresh-skipped', { reason: 'lock-held', head, root });
      return;
    }
    if (existsSync(lock)) {
      // Stale — reap.
      try { rmSync(lock); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  let lockFd;
  try {
    lockFd = openSync(lock, 'wx'); // O_CREAT | O_EXCL — fails if another claimed first.
    writeFileSync(lockFd, `${process.pid} ${head}`);
  } catch (e) {
    log(`lock-claim race lost: ${e.code || e.message}`);
    await _telemetry(sid, 'refresh-skipped', { reason: 'lock-race-lost', code: e?.code, head, root });
    return;
  }

  // Spawn the worker fully detached. stdio is routed to the log file so the
  // child has no open handles to our stdio (or the parent shell's tty) —
  // that's what lets us return immediately without orphaning a pipe.
  const logFd = openSync(LOG, 'a');
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--detached-worker', root, branch, head], {
    cwd: root,
    env: { ...process.env, AUTODOC_SKIP: '1' },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  worker.unref();
  log(`spawned detached worker pid=${worker.pid} branch=${branch} head=${head}`);
  await _telemetry(sid, 'refresh-spawned', { branch, head, root, worker_pid: worker.pid });
  // Return 0 now. The worker keeps running after the hook exits.
}

/** The slow work, run inside a detached child. The fast main() path already
 *  claimed the lock via O_CREAT|O_EXCL, so this just owns + releases it. */
function runDetachedWorker(root, branch, head) {
  const gd = gitDir(root);
  const lock = join(gd, 'auto-docs-refresh.lock');
  const marker = join(gd, 'auto-docs-refresh.sha');
  // Refresh the lockfile mtime so concurrent stale-checks see us alive.
  try { writeFileSync(lock, `${process.pid} ${head}`); } catch { /* ignore */ }

  try {
    try { git(['fetch', 'origin', 'main', '-q'], root); } catch { /* offline ok */ }

    let changed;
    try { changed = git(['diff', '--name-only', 'origin/main...HEAD'], root).split('\n').map(s => s.trim()).filter(Boolean); }
    catch { log('worker: diff vs origin/main failed'); return; }
    if (!changed.length) { log('worker: no changed files vs origin/main'); return; }

    log(`worker: branch=${branch} head=${head} files=${changed.length}`);
    const env = { ...process.env, AUTODOC_SKIP: '1' };
    const dirs = changedDirs(changed).join(',');
    const runOpts = { cwd: root, env, stdio: 'ignore', timeout: REFRESH_TIMEOUT_MS, killSignal: 'SIGKILL' };

    const docgenBin = docgenCandidates(root).find(existsSync);
    if (docgenBin) {
      try { execFileSync(docgenBin, ['--until-done', '--parallel', '4', '--changed', dirs], runOpts); log('worker: docgen refresh done'); }
      catch (e) { log(`worker: docgen refresh ${e.killed ? 'timed out (killed)' : 'failed'}: ${e.message}`); }
    } else { log('worker: docgen not present; skip'); }

    const sysregCli = sysregCandidates(root).find(existsSync);
    if (sysregCli) {
      try { execFileSync('node', [sysregCli, 'refresh', '--changed', changed.join(',')], runOpts); log('worker: systems-registry refresh done'); }
      catch (e) { log(`worker: systems-registry refresh ${e.killed ? 'timed out (killed)' : 'failed'}: ${e.message}`); }
    } else { log('worker: systems-registry not present; skip'); }

    let docPaths = [];
    try { docPaths = docPathsFromStatus(git(['status', '--porcelain'], root)); } catch { /* ignore */ }
    if (!docPaths.length) { try { writeFileSync(marker, head); } catch { /* ignore */ } log('worker: no doc changes after refresh'); return; }

    try {
      execFileSync('git', ['add', '--', ...docPaths], { cwd: root, env, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=bot', '-c', 'user.email=bot@local', 'commit', '-m', 'docs: auto-refresh (docgen + systems-registry)', '--no-verify'], { cwd: root, env, stdio: 'ignore' });
      const newHead = git(['rev-parse', 'HEAD'], root);
      try { writeFileSync(marker, newHead); } catch { /* ignore */ }
      execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { cwd: root, env, stdio: 'ignore' });
      log(`worker: pushed doc refresh to ${branch} (${docPaths.length} files)`);
    } catch (e) { log(`worker: commit/push failed: ${e.message}`); }
  } finally {
    try { rmSync(lock); } catch { /* ignore */ }
  }
}

/** Unique parent dirs of the changed files (for docgen's --changed scope). */
export function changedDirs(files) {
  return [...new Set(files.map(f => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.')))];
}

// Only run when invoked directly as the hook — not when imported by tests.
// Compare via realpath so a relative argv (`node tools/auto-docs-refresh.mjs`)
// or a symlinked path (/tmp → /private/tmp on macOS) still matches.
function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (invokedDirectly()) {
  // Two entry points: hook (stdin = JSON) vs. detached-worker child.
  // The worker form is `node auto-docs-refresh.mjs --detached-worker <root> <branch> <head>`.
  const a = process.argv;
  if (a.includes('--detached-worker')) {
    const i = a.indexOf('--detached-worker');
    runDetachedWorker(a[i + 1], a[i + 2], a[i + 3]);
  } else {
    main().catch(() => { /* never block on hook failures */ });
  }
}
