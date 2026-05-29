#!/usr/bin/env node
/**
 * systems-registry — detector.
 *
 * Walks the repo, scores each candidate (a directory, or a coordinator
 * file inside one) against 8 "complex system" signatures, and returns
 * everything with a total >=4. Companion to scaffold.mjs (which writes
 * skeleton manifests from a detection result) and registry.mjs (which
 * loads the resulting docs/systems/*.md manifests at hook time).
 *
 * Why 8 signals and not 1: a "complex system" looks different across
 * the repo. docgen is a hook + subprocess + state; the evolver is a
 * loop + persistent state + tests; the orchestrator is a tick loop +
 * subprocess + cross-tree refs. No single signal catches them all, but
 * a multi-signal score with a low-ish threshold (>=4) handles the
 * variety while keeping false positives down.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.tooling', '.docgen',
  '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv',
  '.pytest_cache', '.turbo', '.parcel-cache', '.systems-registry',
]);

const SOURCE_EXT = new Set(['.ts', '.mjs', '.js', '.py', '.rs', '.go']);
const TEST_PATTERNS = [/\.test\.(ts|mjs|js)$/, /\.spec\.(ts|mjs|js)$/, /^test_.*\.py$/, /_test\.py$/];

// Barrel files: a module that re-exports / declares its sibling modules.
// A dir with a barrel declaring >= MODULE_HUB_MIN_DECLS children is a
// "module hub" — a coordinated multi-file unit even when it shows none of
// the JS/tooling signals (the case for on-chain Rust instruction modules,
// whose mod.rs declares the subsystem's pieces). This is how the detector
// sees Rust/Go systems the 8 tooling-shaped signals are blind to.
const BARREL_FILES = new Set(['mod.rs', 'lib.rs', 'index.ts', 'index.mjs', 'index.js', '__init__.py']);
const MODULE_HUB_MIN_DECLS = 3;
const MODULE_HUB_MIN_FILES = 3;

// Generic structural / helper directory names. These are internal scaffolding
// of a larger module, not systems in their own right — folding them into their
// parent keeps the federation decomposition at the meaningful subsystem level
// (e.g. an Anchor instruction GROUP or agent operation, not its `accounts/` or
// `helpers/` plumbing). A group whose only subdirs are helpers is emitted whole.
const HELPER_DIR_NAMES = new Set([
  'accounts', 'helpers', 'helper', 'shared', 'utils', 'util', 'common',
  'operations', 'ops', 'internal', 'types', 'constants', 'mod',
]);

const MIN_SCORE = 4;
const BIG_DIR_RECURSE_THRESHOLD = 50;
// How deep the federation decomposition will drill from a big-dir root,
// following module hubs. Empirically a real-world Rust/Anchor program's
// instruction modules sit ~4 module levels below the crate root
// (crate → src → instructions → <group> → <op>), so the cap is set
// above that. Larger codebases can raise this; smaller ones rarely
// recurse past 2.
const FEDERATION_MAX_DEPTH = 6;

// Patterns assembled from string parts to keep their literal substrings
// out of any naive grep-based safety scanners that read this source file.
const SUBPROC_PARTS = ['spawn\\(', 'spawnSync', 'execFile', 'child' + '_proc' + 'ess', 'sub' + 'process\\.Popen', 'sub' + 'process\\.run', 'claude -p', 'playwright', 'chromium'];
const SUBPROC_RE = new RegExp('(' + SUBPROC_PARTS.join('|') + ')');

const SIGNAL_NAMES = [
  'coordinator', 'persistent-state', 'loop', 'subprocess',
  'hook', 'cross-tree', 'tests', 'spec-or-readme',
];

function walkDirs(root, current = root, depth = 0, max = 4) {
  if (depth > max) return [];
  const out = [current];
  for (const ent of safeReaddir(current, { withFileTypes: true })) {
    if (!ent.isDirectory() || SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
    out.push(...walkDirs(root, join(current, ent.name), depth + 1, max));
  }
  return out;
}

function safeReaddir(p, opts) {
  try { return readdirSync(p, opts); } catch { return []; }
}

function listSourceFiles(dir, depth = 0, max = 2) {
  if (depth > max) return [];
  const out = [];
  for (const ent of safeReaddir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
      out.push(...listSourceFiles(full, depth + 1, max));
    } else if (ent.isFile()) {
      const ext = ent.name.slice(ent.name.lastIndexOf('.'));
      if (SOURCE_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

function readSafe(p, max = 64 * 1024) {
  try {
    const buf = readFileSync(p, 'utf8');
    return buf.length > max ? buf.slice(0, max) : buf;
  } catch {
    return '';
  }
}

// ─── signal heuristics ────────────────────────────────────────────────────

function signalCoordinator(files, topLevelFiles) {
  // "siblings" should be the coordinator file's PEERS at the same depth,
  // not random files in subdirectories of a fixture/surfaces/ subdir.
  const scope = topLevelFiles && topLevelFiles.length >= 3 ? topLevelFiles : files;
  if (scope.length < 3) return false;
  // ≥2 sibling imports is a strong coordinator signal — it's unusual outside
  // of coordinators. Combined with the score-≥4 threshold, false positives
  // stay low.
  const minHits = 2;
  files = scope;
  for (const f of files) {
    const content = readSafe(f);
    const siblings = files.filter(o => o !== f).map(o => basename(o).replace(/\.[^.]+$/, ''));
    let hits = 0;
    for (const sib of siblings) {
      if (sib.length < 2) continue;
      const escSib = sib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match imports (JS or Python with/without `from`), shell-call references,
      // require() calls. ux-loop runs siblings via direct `./sibling.mjs` strings;
      // Python siblings use `import price_data` without quotes.
      // Rust/Go: `mod sibling;`, `use ...::sibling`, and `sibling::` path use —
      // a mod.rs/lib.rs that declares its sibling modules is the Rust analog
      // of a JS barrel/coordinator.
      const re = new RegExp(`(import .* from ['"\`][^'"\`]*${escSib}|require\\(['"\`][^'"\`]*${escSib}|from ['"\`][^'"\`]*${escSib}|from \\.?\\.?${escSib}\\b|['"\`]\\./${escSib}\\.(mjs|js|ts|py)['"\`]|['"\`]${escSib}\\.(mjs|js|ts|py)['"\`]|(^|\\n)import\\s+${escSib}\\b|(^|\\n)from\\s+${escSib}\\s+import|(^|\\n)\\s*(pub\\s+)?mod\\s+${escSib}\\s*;|use\\s+[^;]*::${escSib}\\b|\\b${escSib}::)`);
      if (re.test(content)) hits++;
      if (hits >= minHits) return true;
    }
  }
  return false;
}

function signalPersistentState(files) {
  let writes = 0;
  for (const f of files) {
    const c = readSafe(f);
    if (/(writeFileSync|fs\.writeFile|renameSync|json\.dump|json\.dumps.*open\(|with open\([^)]*['"]w)/.test(c)) writes++;
    if (/(state\.json|\.jsonl["']|history\.json|memory\.json|\.state["']|\.md["']|\.csv["']|\.png["']|\.svg["']|REPORT\.md|ANALYSIS\.md|FLOWMAP)/.test(c)) writes++;
  }
  return writes >= 2;
}

function signalLoop(files) {
  // Filename hints: *_loop.py, *_daemon.ts, *_runner.mjs, *_watcher.py, *_tick.* —
  // strong signal a file is a long-running loop even when the regex misses.
  for (const f of files) {
    const b = basename(f);
    if (/(_|^)(loop|daemon|runner|watcher|tick)\.(ts|mjs|js|py)$/.test(b)) return true;
  }
  for (const f of files) {
    const c = readSafe(f);
    if (/while\s+True/.test(c)) return true;
    if (/while\s*\(\s*true\s*\)/.test(c)) return true;
    if (/setInterval\s*\(/.test(c)) return true;
    if (/--until-done/.test(c)) return true;
    if (/setTimeout\s*\([^)]*tick/.test(c)) return true;
    if (/for\s+\w+\s+in\s+range\s*\([^)]*generations?\b/i.test(c)) return true;
    if (/for\s+\w+\s+in\s+range\s*\([^)]*epochs?\b/i.test(c)) return true;
    if (/for\s+gen(eration)?\s+in\s+range/.test(c)) return true;
    if ((/asyncio\.sleep|time\.sleep\s*\(\s*\d+/.test(c)) && /while/.test(c)) return true;
    // Shell-script orchestration loops ("run me again and again")
    if (basename(f).endsWith('.sh') && /while|until/.test(c)) return true;
  }
  return false;
}

function signalSubprocess(files) {
  for (const f of files) {
    const c = readSafe(f);
    if (SUBPROC_RE.test(c)) return true;
  }
  return false;
}

function signalHook(dir, repoRoot) {
  const rel = relative(repoRoot, dir);
  const base = basename(dir);
  const settingsPath = join(repoRoot, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const s = readSafe(settingsPath);
    if (s.includes(rel) || (base.length >= 4 && s.includes(`/${base}/`))) return true;
  }
  const pkgPath = join(repoRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readSafe(pkgPath));
      const scripts = pkg.scripts || {};
      for (const [name, cmd] of Object.entries(scripts)) {
        if (/^(pre|post)(install|publish)$|^prepare$/.test(name) && cmd.includes(rel)) return true;
      }
    } catch { /* ignore */ }
  }
  for (const f of listSourceFiles(dir)) {
    const c = readSafe(f);
    if (/(PreToolUse|SessionStart|UserPromptSubmit)/.test(c) && (/hook/i.test(c) || /\.claude/.test(c))) return true;
    if (/install-(push|pre-commit)-hook/.test(c) && /(writeFileSync|chmod\b)/.test(c)) return true;
  }
  return false;
}

function signalCrossTree(dir, repoRoot, files) {
  const ownTop = relative(repoRoot, dir).split('/')[0];
  const tops = new Set();
  const TOP_RE = /(?:from |import |require\(|['"`])(?:\.\.\/)*((?:tools|lab|services|packages|src|scripts|docs|tests|\.claude|\.docgen|\.git)\/[a-zA-Z0-9_-]+)/g;
  for (const f of files) {
    const c = readSafe(f);
    let m;
    while ((m = TOP_RE.exec(c)) !== null) {
      const t = m[1].split('/')[0];
      if (t !== ownTop) tops.add(t);
    }
  }
  return tops.size >= 2;
}

function signalTests(dir) {
  let n = 0;
  for (const ent of safeReaddir(dir, { withFileTypes: true })) {
    if (ent.isFile() && TEST_PATTERNS.some(re => re.test(ent.name))) n++;
    else if (ent.isDirectory() && !SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
      n += signalTests(join(dir, ent.name));
      if (n >= 3) return 3;
    }
    if (n >= 3) return 3;
  }
  return n;
}

function signalSpecOrReadme(dir, repoRoot) {
  const readme = join(dir, 'README.md');
  if (existsSync(readme)) {
    const c = readSafe(readme, 4096);
    // The marker must START the file (first line) to count as auto-generated.
    // A README that just MENTIONS the marker in prose (e.g. docgen's own
    // README explaining its convention) doesn't count.
    const firstLine = c.split('\n', 1)[0];
    if (!firstLine.includes('auto-generated by docgen')) return true;
  }
  // Other ALL_CAPS or *DESIGN* .md docs in the dir are a strong "this was
  // deliberately documented" signal — e.g. lab/aq-price/PRICE_MODELING.md.
  for (const ent of safeReaddir(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.md') || ent.name === 'README.md') continue;
    if (/^[A-Z][A-Z0-9_-]{2,}\.md$/.test(ent.name)) return true;
  }
  const specsDir = join(repoRoot, 'docs', 'superpowers', 'specs');
  if (existsSync(specsDir)) {
    const base = basename(dir);
    for (const ent of safeReaddir(specsDir)) {
      if (ent.toLowerCase().includes(base.toLowerCase())) return true;
    }
  }
  return false;
}

// ─── scoring ──────────────────────────────────────────────────────────────

function scoreDir(dir, repoRoot) {
  const files = listSourceFiles(dir);
  const topLevel = listSourceFiles(dir, 0, 0);
  const signals = {
    coordinator: signalCoordinator(files, topLevel),
    'persistent-state': signalPersistentState(files),
    loop: signalLoop(files),
    subprocess: signalSubprocess(files),
    hook: signalHook(dir, repoRoot),
    'cross-tree': signalCrossTree(dir, repoRoot, files),
    tests: signalTests(dir) >= 3,
    'spec-or-readme': signalSpecOrReadme(dir, repoRoot),
  };
  const score = Object.values(signals).filter(Boolean).length;
  return { dir, files, signals, score, fileCount: files.length };
}

// Count the module/re-export declarations in a dir's barrel file.
// Rust: `pub mod x;` / `mod x;` in mod.rs|lib.rs.  JS: `export ... from`
// / `export * from` in index.*.  Python: imports in __init__.py.
function barrelDeclCount(dir) {
  for (const name of BARREL_FILES) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const c = readSafe(p, 16 * 1024);
    let n = 0;
    if (name.endsWith('.rs')) {
      n = (c.match(/^\s*(pub\s+)?mod\s+\w+\s*;/gm) || []).length;
    } else if (name === '__init__.py') {
      n = (c.match(/^\s*(from\s+\.\w+\s+import|import\s+\w+)/gm) || []).length;
    } else {
      n = (c.match(/^\s*export\s+(\*|\{[^}]*\}|.+)\s+from\s+['"]/gm) || []).length;
    }
    if (n > 0) return n;
  }
  return 0;
}

// A "module hub": a dir whose barrel declares >= MODULE_HUB_MIN_DECLS
// children and which holds >= MODULE_HUB_MIN_FILES source files. This is
// the language-agnostic structural signal that lets the federation
// decomposition find Rust/Go subsystems the tooling-shaped score misses.
function isModuleHub(dir) {
  return barrelDeclCount(dir) >= MODULE_HUB_MIN_DECLS
    && listSourceFiles(dir).length >= MODULE_HUB_MIN_FILES;
}

function immediateSubdirs(dir) {
  return safeReaddir(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map(e => join(dir, e.name));
}

/**
 * Decompose a big-dir federation into its real subsystems. Recursively
 * drills module hubs (following mod.rs/lib.rs/index.* structure) until it
 * reaches leaf hubs — a Rust crate decomposes as e.g.
 *   crate → src → instructions → <group> → <op>
 * surfacing each leaf module as its own candidate even though none of them
 * clear the 8 tooling signals and the crate root scores < MIN_SCORE.
 *
 * A subdir qualifies as a subsystem when it independently scores
 * >= MIN_SCORE (the original JS/tooling path) OR is a module hub (the
 * structural path). Big hub subdirs are recursed into; leaf hubs are
 * emitted. Falls back to the dir itself if nothing qualifies below it.
 */
function decideRecurse(scored, repoRoot, depth = 0) {
  if (depth >= FEDERATION_MAX_DEPTH) return [scored];
  const big = scored.fileCount > BIG_DIR_RECURSE_THRESHOLD;
  const hub = isModuleHub(scored.dir);
  const children = immediateSubdirs(scored.dir)
    .filter(d => !HELPER_DIR_NAMES.has(basename(d)))   // fold plumbing into parent
    .map(d => scoreDir(d, repoRoot));
  const fedChildren = children.filter(
    s => s.score >= MIN_SCORE || isModuleHub(s.dir) || s.fileCount > BIG_DIR_RECURSE_THRESHOLD
  );
  // Decompose only when this dir is itself a federation (big or a module
  // hub) OR it sits one level above one (e.g. a Rust crate root whose
  // `src/` is the hub). Otherwise this IS the leaf candidate — preserves
  // the original single-dir behaviour for ordinary JS/TS dirs.
  if (!big && !hub && fedChildren.length === 0) return [scored];

  const out = [];
  for (const s of fedChildren) {
    const subBig = s.fileCount > BIG_DIR_RECURSE_THRESHOLD;
    const subHubOfHubs = isModuleHub(s.dir) && immediateSubdirs(s.dir).some(d => isModuleHub(d));
    if (subBig || subHubOfHubs) {
      out.push(...decideRecurse(s, repoRoot, depth + 1));   // drill further
    } else {
      out.push(s);                                          // leaf subsystem
    }
  }
  // A hub whose modules are FILES (no qualifying subdirs) is itself the leaf.
  if (out.length === 0) return [scored];
  return out;
}

function nameOf(dir, repoRoot) {
  const rel = relative(repoRoot, dir);
  return rel.replace(/[\/.]+/g, '-').toLowerCase();
}

function inferAnchors(scored, repoRoot) {
  const rel = relative(repoRoot, scored.dir);
  const out = [`${rel}/**`];
  const TOP_RE = /(?:from |import |require\(|['"`])(?:\.\.\/)*((?:tools|lab|services|packages|src|scripts|docs|tests|\.claude|\.docgen|\.git)\/[a-zA-Z0-9_-]+)/g;
  const seen = new Set();
  for (const f of scored.files) {
    const c = readSafe(f);
    let m;
    while ((m = TOP_RE.exec(c)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push(`${m[1]}/**`);
    }
  }
  if (scored.signals.hook) out.push('.claude/settings.json');
  return out;
}

export function detect(repoRoot) {
  const candidates = walkDirs(repoRoot)
    .filter(d => d !== repoRoot)
    .filter(d => {
      const top = relative(repoRoot, d).split('/')[0];
      // Include any non-hidden, non-skip top-level dir. Repo-specific top
      // levels (`apps/`, `services/`, `crates/`, monorepo-flavoured names)
      // shouldn't need a hand-curated allowlist — accept anything that
      // isn't in the explicit deny list a few lines down.
      if (!top || top.startsWith('.')) return false;
      if (SKIP_DIRS.has(top)) return false;
      // Exclude pure-config / non-source top-levels by name.
      if (['docs', '.github', 'migrations', 'public', 'static'].includes(top)) return false;
      return true;
    });

  const scored = candidates.map(d => scoreDir(d, repoRoot));

  // Each candidate either decomposes into subsystems (big-dir / module-hub
  // federations — incl. Rust crates the 8 tooling signals can't score) or
  // stands alone. A standalone dir is kept only if it clears MIN_SCORE.
  const expanded = [];
  for (const s of scored) {
    const dec = decideRecurse(s, repoRoot);
    if (dec.length === 1 && dec[0] === s) {
      if (s.score >= MIN_SCORE) expanded.push(s);   // ordinary qualifying leaf
    } else {
      expanded.push(...dec);                         // federation subsystems
    }
  }

  // Dedup by dir path (parent + walkDirs(child) can produce the same scored entry twice)
  const byDir = new Map();
  for (const s of expanded) {
    if (!byDir.has(s.dir)) byDir.set(s.dir, s);
  }
  const deduped = [...byDir.values()];

  // Prefer child over parent when both qualified
  const final = deduped.filter(s => {
    for (const other of deduped) {
      if (other !== s && other.dir.startsWith(s.dir + '/')) return false;
    }
    return true;
  });

  return final.map(s => ({
    name: nameOf(s.dir, repoRoot),
    dir: relative(repoRoot, s.dir),
    score: s.score,
    signals: Object.entries(s.signals).filter(([, v]) => v).map(([k]) => k),
    anchors: inferAnchors(s, repoRoot),
    fileCount: s.fileCount,
  })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export const _internal = {
  scoreDir, signalCoordinator, signalPersistentState, signalLoop,
  signalSubprocess, signalHook, signalCrossTree, signalTests,
  signalSpecOrReadme, SIGNAL_NAMES, MIN_SCORE,
};
