import type { PoolClient } from 'pg';
import { tx } from './db.js';

export type Job = { id: number; kind: string; payload: any; attempts: number; max_attempts: number };
export type Handler = (c: PoolClient, payload: any, job: Job) => Promise<void>;

export const handlers: Record<string, Handler> = {
  // Idempotent: UNIQUE(outbox_id) + ON CONFLICT DO NOTHING => reprocessing never duplicates.
  async notify_assignee(c, p, job) {
    const item = (await c.query('SELECT title FROM work_items WHERE id = $1', [p.itemId])).rows[0];
    await c.query(
      `INSERT INTO notifications (user_id, item_id, outbox_id, message) VALUES ($1,$2,$3,$4)
       ON CONFLICT (outbox_id) DO NOTHING`,
      [p.userId, p.itemId, job.id, `You were assigned: ${item?.title ?? '#' + p.itemId}`]);
  },
};

/**
 * Claim due jobs with FOR UPDATE SKIP LOCKED (safe with several workers), run each inside a
 * savepoint, then mark done / schedule a retry with exponential backoff / mark failed.
 * If the worker dies before COMMIT, the rows stay 'pending' and are retried (at-least-once).
 */
export async function processOutbox(
  opts: { handlers?: Record<string, Handler>; now?: Date; batch?: number } = {},
) {
  const h = opts.handlers ?? handlers;
  const now = opts.now ?? new Date();
  const stats = { done: 0, retried: 0, failed: 0 };
  await tx(async (c) => {
    const { rows } = await c.query<Job>(
      `SELECT id, kind, payload, attempts, max_attempts FROM outbox
        WHERE status = 'pending' AND next_run_at <= $1
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, opts.batch ?? 20]);
    for (const job of rows) {
      await c.query('SAVEPOINT job');
      try {
        const fn = h[job.kind];
        if (!fn) throw new Error(`no handler for ${job.kind}`);
        await fn(c, job.payload, job);
        await c.query('RELEASE SAVEPOINT job');
        await c.query(
          `UPDATE outbox SET status='done', attempts=attempts+1, processed_at=$2 WHERE id=$1`, [job.id, now]);
        stats.done++;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT job');
        const attempts = job.attempts + 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (attempts >= job.max_attempts) {
          await c.query(`UPDATE outbox SET status='failed', attempts=$2, last_error=$3 WHERE id=$1`,
            [job.id, attempts, msg]);
          stats.failed++;
        } else {
          const next = new Date(now.getTime() + 2 ** attempts * 5000);
          await c.query(`UPDATE outbox SET attempts=$2, last_error=$3, next_run_at=$4 WHERE id=$1`,
            [job.id, attempts, msg, next]);
          stats.retried++;
        }
      }
    }
  });
  return stats;
}
