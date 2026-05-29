import { lib } from './lib.mjs';
import { runner } from './run.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

while (true) {
  const result = lib();
  runner(result);
  writeFileSync('bar-state.json', JSON.stringify(result));
  spawnSync('echo', ['bar tick']);
}
