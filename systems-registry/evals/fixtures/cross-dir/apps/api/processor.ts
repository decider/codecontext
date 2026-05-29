import { Event } from '../../packages/shared/event.ts';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

export class Processor {
  handle(e: Event) {
    while (true) {
      writeFileSync('processor-state.json', JSON.stringify(e));
      spawn('scripts/relay.sh', [e.id]);
      break;
    }
  }
}
