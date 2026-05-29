#!/usr/bin/env node
// CLI viewer for ~/.claude-telemetry/.
//
// Usage:
//   node telemetry/cli.mjs                 — current session (newest .jsonl)
//   node telemetry/cli.mjs --all           — every session, summarised
//   node telemetry/cli.mjs --session <sid> — a specific session
//   node telemetry/cli.mjs --top           — files by total bytes injected (across all sessions)
//   node telemetry/cli.mjs --tail [N]      — last N events (default 20), real-time-ish
//   node telemetry/cli.mjs --hooks         — per-hook event counts + bytes
//   node telemetry/cli.mjs --resets        — every reset event ever (with reason)

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_DIR, sessionFilePath } from './writer.mjs';

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function listSessionFiles() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      sid: f.replace(/\.jsonl$/, ''),
      path: join(SESSIONS_DIR, f),
      mtimeMs: (() => { try { return statSync(join(SESSIONS_DIR, f)).mtimeMs; } catch { return 0; } })(),
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function fmtBytes(n) {
  if (n == null) return '0';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function fmtAgo(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(ms)) return '?';
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))}m ago`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h ago`;
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d ago`;
}

function summariseEvents(events) {
  let totalBytes = 0;
  const byHook = new Map();
  const byEvent = new Map();
  const fileBytes = new Map();
  let resetCount = 0;
  for (const e of events) {
    totalBytes += e.bytes_emitted ?? 0;
    const hk = byHook.get(e.hook) || { count: 0, bytes: 0 };
    hk.count++; hk.bytes += e.bytes_emitted ?? 0;
    byHook.set(e.hook, hk);
    byEvent.set(e.event, (byEvent.get(e.event) ?? 0) + 1);
    if (e.event === 'reset') resetCount++;
    if (Array.isArray(e.files_injected)) {
      for (const f of e.files_injected) {
        fileBytes.set(f, (fileBytes.get(f) ?? 0) + 0); // count
      }
    }
    if (e.target_file && (e.bytes_emitted ?? 0) > 0) {
      fileBytes.set(e.target_file, (fileBytes.get(e.target_file) ?? 0) + (e.bytes_emitted ?? 0));
    }
  }
  return { totalBytes, byHook, byEvent, resetCount, fileBytes };
}

function renderSessionSummary(sid, events) {
  const s = summariseEvents(events);
  console.log('');
  console.log(`session: ${sid}`);
  console.log(`  events:     ${events.length}`);
  console.log(`  bytes:      ${fmtBytes(s.totalBytes)} injected total`);
  console.log(`  resets:     ${s.resetCount}`);
  if (events.length === 0) return;
  const first = events[0]; const last = events[events.length - 1];
  console.log(`  first ev:   ${first.ts}  (${fmtAgo(first.ts)})`);
  console.log(`  last ev:    ${last.ts}  (${fmtAgo(last.ts)})`);
  console.log('  by hook:');
  for (const [hk, v] of [...s.byHook.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`    ${hk.padEnd(34)} ${String(v.count).padStart(4)} events  ${fmtBytes(v.bytes).padStart(8)}`);
  }
  console.log('  by event:');
  for (const [ev, n] of [...s.byEvent.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ev.padEnd(20)} ${n}`);
  }
}

function renderTop(events, n = 15) {
  const map = new Map();
  for (const e of events) {
    if (e.target_file && (e.bytes_emitted ?? 0) > 0) {
      const cur = map.get(e.target_file) || { hits: 0, bytes: 0 };
      cur.hits++; cur.bytes += e.bytes_emitted;
      map.set(e.target_file, cur);
    }
  }
  const ranked = [...map.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, n);
  if (ranked.length === 0) { console.log('(no file-targeted injections yet)'); return; }
  console.log(`top ${ranked.length} files by bytes injected when touched:`);
  for (const [file, v] of ranked) {
    console.log(`  ${fmtBytes(v.bytes).padStart(8)}  ${String(v.hits).padStart(3)}× hits  ${file}`);
  }
}

function renderTail(events, n = 20) {
  const recent = events.slice(-n);
  for (const e of recent) {
    const bytes = e.bytes_emitted ? `+${fmtBytes(e.bytes_emitted)}` : '';
    const target = e.target_file ? ` ${e.target_file}` : '';
    const reason = e.reason ? `  reason=${e.reason}` : '';
    console.log(`  ${fmtAgo(e.ts).padEnd(8)} ${e.hook.padEnd(34)} ${e.event.padEnd(20)} ${bytes.padEnd(8)}${target}${reason}`);
  }
}

function renderHooks(events) {
  const map = new Map();
  for (const e of events) {
    const k = `${e.hook}::${e.event}`;
    const v = map.get(k) || { count: 0, bytes: 0 };
    v.count++; v.bytes += e.bytes_emitted ?? 0;
    map.set(k, v);
  }
  console.log('hook × event counts (across all sessions):');
  for (const [k, v] of [...map.entries()].sort((a, b) => b[1].bytes - a[1].bytes || b[1].count - a[1].count)) {
    console.log(`  ${k.padEnd(56)} ${String(v.count).padStart(5)}×  ${fmtBytes(v.bytes).padStart(8)}`);
  }
}

function renderResets(events) {
  const resets = events.filter(e => e.event === 'reset');
  if (resets.length === 0) { console.log('(no reset events recorded yet)'); return; }
  console.log(`reset events (${resets.length} total — most recent first):`);
  for (const e of resets.slice(-50).reverse()) {
    console.log(`  ${e.ts}  sid=${e.sid}  reason=${e.reason ?? '?'}  removed=${e.dedup_files_removed ?? '?'}`);
  }
}

function loadAllEvents() {
  const files = listSessionFiles();
  const out = [];
  for (const f of files) out.push(...readJsonl(f.path));
  return out;
}

function parseArgs(argv) {
  const a = { mode: 'session' };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--all') a.mode = 'all';
    else if (tok === '--top') a.mode = 'top';
    else if (tok === '--hooks') a.mode = 'hooks';
    else if (tok === '--resets') a.mode = 'resets';
    else if (tok === '--tail') { a.mode = 'tail'; a.tailN = Number(argv[i + 1]) || 20; i++; }
    else if (tok === '--session') { a.mode = 'session'; a.sid = argv[i + 1]; i++; }
    else if (tok === '--help' || tok === '-h') a.mode = 'help';
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    console.log(`Usage:
  --all                  all sessions, summarised
  --session <sid>        one specific session's rollup
  (default)              newest session (currently running)
  --top                  files by total bytes injected
  --hooks                hook × event counts (cross-session)
  --resets               every reset event
  --tail [N]             last N events (cross-session, default 20)`);
    return;
  }
  if (!existsSync(SESSIONS_DIR)) {
    console.log(`No telemetry yet at ${SESSIONS_DIR}.`);
    console.log('Run a Claude session and try again — the hooks will start recording.');
    return;
  }
  if (args.mode === 'top') { renderTop(loadAllEvents()); return; }
  if (args.mode === 'hooks') { renderHooks(loadAllEvents()); return; }
  if (args.mode === 'resets') { renderResets(loadAllEvents()); return; }
  if (args.mode === 'tail') { renderTail(loadAllEvents(), args.tailN); return; }
  if (args.mode === 'all') {
    const files = listSessionFiles();
    console.log(`${files.length} session${files.length === 1 ? '' : 's'} on disk:`);
    for (const f of files) {
      const events = readJsonl(f.path);
      renderSessionSummary(f.sid, events);
    }
    return;
  }
  // Default: current (newest) session.
  const files = listSessionFiles();
  if (!files.length) { console.log('No sessions yet.'); return; }
  const target = args.sid
    ? files.find(f => f.sid.includes(args.sid))
    : files[0];
  if (!target) { console.log(`No session matching ${args.sid}.`); return; }
  const events = readJsonl(target.path);
  renderSessionSummary(target.sid, events);
}

main();
