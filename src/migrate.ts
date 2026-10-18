import { readFileSync } from 'node:fs';
import { pool } from './db.js';

export async function migrate() {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => console.log('migrated'))
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => pool.end());
}
