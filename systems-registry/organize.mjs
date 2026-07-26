#!/usr/bin/env node
// systems-registry — organize step (LLM folder categorization).
//
// Runs AFTER all system bodies are generated + vetted (it needs the full
// picture, not just Pass-1 summaries). One LLM call sees every final
// manifest's summary + closing-arrow + consumes list, and groups systems
// into free-form semantic categories.
//
// Re-anchoring: if a prior _categories.json exists, it's fed in as the
// current organization. The LLM is told to PREFER keeping it where it
// still fits, but may rename/regroup as the system set evolves. Same
// drift-reduction pattern Pass 1 uses with the prior hypothesis.
//
// Output: docs/systems/_categories.json
//   { "categories": [ { "name": "...", "systems": ["...", ...] } ],
//     "generatedAt": "...", "generator": "..." }
//
// build-static.mjs reads this for sidebar grouping; falls back to
// glob-dir grouping when absent.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { parseFrontMatter } from './registry.mjs';
import { CHEAP_MODEL, DEFAULT_TIMEOUT_MS } from '../models.mjs';

const CATEGORIES_PATH = 'docs/systems/_categories.json';

function callClaude(prompt, { model = CHEAP_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const ch = spawn('claude', ['-p', '--model', model, '--output-format', 'text']);
    const chunks = []; const errs = [];
    const timer = setTimeout(() => { ch.kill('SIGKILL'); reject(new Error('claude -p timeout')); }, timeoutMs);
    ch.stdout.on('data', c => chunks.push(c));
    ch.stderr.on('data', c => errs.push(c));
    ch.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error('claude -p exited ' + code + ': ' + Buffer.concat(errs).toString('utf8').slice(0, 500)));
    });
    ch.on('error', e => { clearTimeout(timer); reject(e); });
    ch.stdin.end(prompt);
  });
}

function parseJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }}
  }
  return null;
}

// Pull a system's summary + a one-line "closing arrow" + consumes from its manifest.
function summarizeManifest(text) {
  const { rest: body, frontMatter } = parseFrontMatter(text);
  const summary = (frontMatter && frontMatter.summary) || '';
  // Extract the "## Closing arrow" first paragraph if present.
  let closing = '';
  const m = (body || '').match(/##\s+Closing arrow\s*\n+([^\n]+)/);
  if (m) closing = m[1].trim();
  return { name: frontMatter && frontMatter.name, summary, closing };
}

export function gatherOrganizeInputs(repoRoot) {
  const dir = join(repoRoot, 'docs/systems');
  const systems = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || f === 'README.md' || f.startsWith('_')) continue;
      try {
        const s = summarizeManifest(readFileSync(join(dir, f), 'utf8'));
        if (s.name) systems.push(s);
      } catch { /* skip */ }
    }
  }
  let priorCategories = null;
  const catPath = join(repoRoot, CATEGORIES_PATH);
  if (existsSync(catPath)) {
    try { priorCategories = JSON.parse(readFileSync(catPath, 'utf8')); } catch { /* ignore */ }
  }
  return { systems, priorCategories };
}

export function buildOrganizePrompt({ systems, priorCategories }) {
  const parts = [];
  parts.push('You are organizing a repository\'s documented systems into semantic folders for a docs sidebar.');
  parts.push('');
  parts.push('## Systems (each with summary + how its loop closes)');
  for (const s of systems) {
    parts.push(`- ${s.name}: ${s.summary}${s.closing ? ` [closes via: ${s.closing}]` : ''}`);
  }
  parts.push('');
  if (priorCategories && Array.isArray(priorCategories.categories)) {
    parts.push('## Current categorization (prefer keeping this where it still fits)');
    for (const c of priorCategories.categories) {
      parts.push(`- ${c.name}: ${(c.systems || []).join(', ')}`);
    }
    parts.push('');
    parts.push('Reduce drift: keep category names + assignments stable when they still make sense.');
    parts.push('Only rename or regroup when the system set genuinely changed. Do not churn for its own sake.');
    parts.push('');
  }
  parts.push('## Your task');
  parts.push('Group EVERY system into 3-6 free-form semantic categories by what they DO');
  parts.push('(e.g. live runtime vs. offline research vs. dev tooling vs. QA gates vs. setup),');
  parts.push('considering how their loops close + which systems feed each other. Every system');
  parts.push('must appear in exactly one category.');
  parts.push('');
  parts.push('Output JSON only:');
  parts.push('{ "categories": [ { "name": "Category Name", "systems": ["sys-a", "sys-b"] } ] }');

  return parts.join('\n');
}

/**
 * Validate + repair the LLM output: ensure every input system appears
 * exactly once. Any system the LLM dropped goes into an "Uncategorized"
 * bucket so the build never loses a system.
 */
export function reconcile(systems, parsed) {
  const allNames = new Set(systems.map(s => s.name));
  const seen = new Set();
  const categories = [];
  for (const c of (parsed && parsed.categories) || []) {
    const members = (c.systems || []).filter(n => allNames.has(n) && !seen.has(n));
    members.forEach(n => seen.add(n));
    if (members.length > 0) categories.push({ name: c.name, systems: members });
  }
  const missing = [...allNames].filter(n => !seen.has(n));
  if (missing.length > 0) categories.push({ name: 'Uncategorized', systems: missing });
  return { categories };
}

export async function runOrganize(repoRoot, { runner, model, write = true } = {}) {
  const inputs = gatherOrganizeInputs(repoRoot);
  if (inputs.systems.length === 0) return { categories: [], outPath: null, inputs };
  const prompt = buildOrganizePrompt(inputs);
  const response = runner ? await runner(prompt) : await callClaude(prompt, { model });
  const parsed = parseJSON(response) || { categories: [] };
  const reconciled = reconcile(inputs.systems, parsed);
  let outPath = null;
  if (write) {
    outPath = resolve(repoRoot, CATEGORIES_PATH);
    writeFileSync(outPath, JSON.stringify({
      ...reconciled,
      generatedAt: new Date().toISOString(),
      generator: model || CHEAP_MODEL,
    }, null, 2));
  }
  return { ...reconciled, outPath, prompt, response, inputs };
}

export function loadCategories(repoRoot) {
  const p = resolve(repoRoot, CATEGORIES_PATH);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export const _internal = { summarizeManifest, parseJSON, CATEGORIES_PATH };
