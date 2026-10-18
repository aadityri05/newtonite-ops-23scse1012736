import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(20, (v) => Number(v)); // bigint -> number (ids, counts)
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD' string, no timezone shifts

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export type Q = pg.Pool | pg.PoolClient;

/** Run fn inside one transaction. Any throw rolls everything back. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
