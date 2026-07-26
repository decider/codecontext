#!/usr/bin/env node
// systems-registry — Pass 2.6: revise.
//
// For each system Pass 2.5 flagged, re-run the body LLM with the vet
// issues attached as feedback. Capped at 2 retries; remaining failures
// ship with `status: needs-review` so the run never blocks.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { gatherInputsFor, buildPromptFor } from './pass2.mjs';
import { vetSystem } from './pass25-vet.mjs';
import { CHEAP_MODEL, DEFAULT_TIMEOUT_MS } from './models.mjs';

const MAX_RETRIES = 2;  // 3 total tries: initial body + 2 revisions

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

function stripCodeFence(text) {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/);
  return m ? m[1].trim() : trimmed;
}

export function buildRevisePrompt({ hypothesisEntry, anchors, priorBody, vetIssues }) {
  // Thread vetIssues through `inputs.feedback` so Pass 2's HIGH-PRIORITY
  // pre-task framing fires. Previously the only feedback channel was a
  // postscript appended AFTER the task block; the model consistently
  // deprioritized those because the task block was longer + later in the
  // prompt, so it gravitated to "regenerate fresh" rather than "fix these."
  const inputs = {
    hypothesisEntry,
    anchors,
    priorManifest: priorBody,
    feedback: {
      verdict: 'revise',
      issues: vetIssues.map(p => `[${p.kind}] ${p.detail || ''}`.trim()),
    },
  };
  return buildPromptFor(inputs);
}

/**
 * Revise a single flagged manifest. Tries up to MAX_RETRIES; returns
 * {finalStatus, attempts: [{problems, body}], outPath}.
 *
 * runner is injectable for tests.
 */
export async function reviseSystem(repoRoot, hypothesisEntry, vetReport, { runner, maxRetries = MAX_RETRIES } = {}) {
  const manifestPath = resolve(repoRoot, 'docs/systems', hypothesisEntry.name + '.md');
  const attempts = [];
  let currentReport = vetReport;
  let attempt = 0;

  while (currentReport.status === 'issues' && attempt < maxRetries) {
    attempt++;
    const priorBody = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
    const inputs = gatherInputsFor(repoRoot, hypothesisEntry);
    const prompt = buildRevisePrompt({
      hypothesisEntry,
      anchors: inputs.anchors,
      priorBody,
      vetIssues: currentReport.problems,
    });
    const response = runner ? await runner(prompt) : await callClaude(prompt);
    const revised = stripCodeFence(response);
    writeFileSync(manifestPath, revised);
    attempts.push({ attempt, problems: currentReport.problems, body: revised });

    // Re-vet (cheap only — revise loop doesn't burn LLM judge tokens per cycle)
    currentReport = await vetSystem(repoRoot, manifestPath, { llm: false });
  }

  // If still flagged after maxRetries: mark needs-review by inserting into
  // front-matter so future inject-hook + readers know to question it.
  if (currentReport.status === 'issues') {
    const text = readFileSync(manifestPath, 'utf8');
    const withStatus = text.replace(/^(---\n[\s\S]*?\nstatus:\s*)(\w+)/m, '$1needs-review');
    if (withStatus !== text) writeFileSync(manifestPath, withStatus);
  }

  return {
    finalStatus: currentReport.status,
    attempts,
    finalProblems: currentReport.problems,
    outPath: manifestPath,
  };
}
