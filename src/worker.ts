import { pool } from './db.js';
import { processOutbox } from './outbox.js';

let stop = false;
process.on('SIGTERM', () => { stop = true; });
process.on('SIGINT', () => { stop = true; });

async function main() {
  console.log('worker started');
  while (!stop) {
    try {
      const s = await processOutbox();
      if (s.done + s.retried + s.failed > 0) console.log('outbox batch', s);
    } catch (e) {
      console.error('worker error', e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await pool.end();
}
main();
