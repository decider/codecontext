import { capture } from './capture.mjs';
import { score } from './score.mjs';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export async function runFoo() {
  while (true) {
    const snap = await capture();
    const s = score(snap);
    writeFileSync('state.json', JSON.stringify({ s }));
    spawn('echo', ['tick']);
  }
}
