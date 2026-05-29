#!/usr/bin/env node
/**
 * systems-registry — scaffold a skeleton manifest from a detection result.
 *
 * Given the detect() output for one system, writes
 * docs/systems/<name>.md with YAML front-matter populated and a
 * "## What it does — TODO" body. Status defaults to `draft`, so the
 * inject hook ignores it until a human (or Claude) fills it in and
 * flips status to `active`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TODAY = new Date().toISOString().slice(0, 10);

export function manifestText(detection, { status = 'draft', summary } = {}) {
  const lines = [];
  lines.push('---');
  lines.push(`name: ${detection.name}`);
  lines.push(`summary: ${summary || 'TODO — one-paragraph description of what this system does and how its loop closes.'}`);
  lines.push('globs:');
  for (const g of detection.anchors) lines.push(`  - ${quoteIfNeeded(g)}`);
  lines.push('inject:');
  lines.push('  mermaid: true');
  lines.push('  page_link: true');
  lines.push('  cap_bytes: 4096');
  lines.push(`status: ${status}`);
  lines.push(`detector_score: ${detection.score}`);
  lines.push('detector_signals:');
  for (const s of detection.signals) lines.push(`  - ${s}`);
  lines.push(`last_refreshed: ${TODAY}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${detection.name}`);
  lines.push('');
  lines.push('## What it does');
  lines.push('');
  lines.push('TODO');
  lines.push('');
  lines.push('## The loop');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart LR');
  lines.push('  TODO[describe the loop]');
  lines.push('```');
  lines.push('');
  lines.push('## Anchors');
  lines.push('');
  for (const g of detection.anchors) lines.push(`- \`${g}\``);
  lines.push('');
  lines.push('## Closing arrow');
  lines.push('');
  lines.push('TODO — where does this system\'s output feed back into the loop?');
  lines.push('');
  lines.push('## Invariants');
  lines.push('');
  lines.push('TODO');
  lines.push('');
  lines.push('## Failure modes');
  lines.push('');
  lines.push('TODO');
  lines.push('');
  lines.push('## Where to start reading');
  lines.push('');
  lines.push('TODO');
  lines.push('');
  return lines.join('\n');
}

function quoteIfNeeded(g) {
  if (g.includes('*') || g.includes(':') || g.includes('#')) return `"${g}"`;
  return g;
}

export function writeManifest(repoRoot, detection, opts = {}) {
  const path = join(repoRoot, 'docs', 'systems', `${detection.name}.md`);
  if (!opts.force && existsSync(path)) {
    return { path, written: false, reason: 'exists' };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, manifestText(detection, opts));
  return { path, written: true };
}
