#!/usr/bin/env node
/**
 * merge-settings.mjs — idempotently merge plugin hook entries into a host
 * repo's .claude/settings.json. Preserves any existing hooks; deduplicates
 * by exact command string so re-running install.sh doesn't accumulate.
 *
 * Usage: node merge-settings.mjs <host-settings.json> <plugin-template.json>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [hostPath, pluginPath] = process.argv.slice(2);
if (!hostPath || !pluginPath) {
  process.stderr.write('usage: merge-settings.mjs <host-settings.json> <plugin-template.json>\n');
  process.exit(2);
}

const host = existsSync(hostPath) ? JSON.parse(readFileSync(hostPath, 'utf8')) : {};
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
delete plugin._comment;

host.hooks = host.hooks || {};

for (const event of Object.keys(plugin.hooks || {})) {
  host.hooks[event] = host.hooks[event] || [];
  for (const pluginEntry of plugin.hooks[event]) {
    // Group entries by matcher. Find a host entry with the same matcher and
    // merge the commands into it; otherwise append the whole entry.
    let hostEntry = host.hooks[event].find(e => e.matcher === pluginEntry.matcher);
    if (!hostEntry) {
      host.hooks[event].push(JSON.parse(JSON.stringify(pluginEntry)));
      continue;
    }
    hostEntry.hooks = hostEntry.hooks || [];
    const seen = new Set(hostEntry.hooks.map(h => h.command));
    for (const cmd of pluginEntry.hooks || []) {
      if (!seen.has(cmd.command)) {
        hostEntry.hooks.push(cmd);
        seen.add(cmd.command);
      }
    }
  }
}

writeFileSync(hostPath, JSON.stringify(host, null, 2) + '\n');
process.stdout.write(`merged hooks into ${hostPath}\n`);
