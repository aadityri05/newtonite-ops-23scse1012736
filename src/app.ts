import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireAuth, signToken, loadUser } from './auth.js';
import { pool, tx } from './db.js';
import { HttpError } from './errors.js';
import * as items from './items.js';
import { STATUSES } from './workflow.js';

const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).optional(),
  type: z.enum(TYPES), priority: z.enum(PRIORITIES), team_id: id,
  assignee_id: id.nullish(), due_date: date.nullish(),
});
const updateSchema = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  type: z.enum(TYPES).optional(), priority: z.enum(PRIORITIES).optional(),
  due_date: date.nullable().optional(),
});
const listSchema = z.object({
  view: z.enum(['assigned_to_me', 'unassigned_urgent', 'awaiting_my_approval']).optional(),
  status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TYPES).optional(), team_id: id.optional(), assignee: z.string().optional(),
  q: z.string().trim().max(200).optional(), cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Runs fn in one transaction. With an Idempotency-Key header, the key row is inserted in the
 * SAME transaction: a concurrent duplicate blocks on the unique key until the first commits,
 * then replays the stored response instead of running fn again.
 */
async function mutate(req: Request, res: Response, okStatus: number, fn: (c: PoolClient) => Promise<unknown>) {
  const key = req.header('Idempotency-Key');
  if (!key) return void res.status(okStatus).json(await tx(fn));
  if (key.length > 200) throw new HttpError(400, 'bad_request', 'Idempotency-Key too long');

  const hash = createHash('sha256').update(`${req.method} ${req.path} ${JSON.stringify(req.body ?? {})}`).digest('hex');
  const out = await tx(async (c) => {
    const ins = await c.query(
      'INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [req.user!.id, key, hash]);
    if (ins.rowCount === 0) {
      const { rows } = await c.query(
        'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id=$1 AND key=$2',
        [req.user!.id, key]);
      if (rows[0].request_hash !== hash) {
        throw new HttpError(422, 'idempotency_key_reuse', 'This Idempotency-Key was used with a different request');
      }
      return { status: rows[0].status_code as number, body: rows[0].response, replay: true };
    }
    const body = await fn(c);
    await c.query('UPDATE idempotency_keys SET status_code=$3, response=$4 WHERE user_id=$1 AND key=$2',
      [req.user!.id, key, okStatus, JSON.stringify(body)]);
    return { status: okStatus, body, replay: false };
  });
  if (out.replay) res.set('Idempotent-Replay', 'true');
  res.status(out.status).json(out.body);
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(new URL('../public', import.meta.url).pathname));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/login', async (req, res) => {
    const { email, password } = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE lower(email) = lower($1)', [email]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
      throw new HttpError(401, 'bad_credentials', 'Wrong email or password');
    }
    const user = (await loadUser(rows[0].id))!;
    res.json({ token: signToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
  });

  const api = express.Router();
  api.use(requireAuth);

  api.get('/me', async (req, res) => {
    const u = req.user!;
    const { rows } = await pool.query(
      `SELECT t.id, t.name, m.role,
              (SELECT json_agg(json_build_object('id', u2.id, 'name', u2.name, 'role', m2.role) ORDER BY u2.name)
                 FROM memberships m2 JOIN users u2 ON u2.id = m2.user_id WHERE m2.team_id = t.id) AS members
         FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.name`, [u.id]);
    res.json({ user: { id: u.id, name: u.name, email: u.email }, teams: rows });
  });

  api.get('/items', async (req, res) => {
    res.json(await items.listItems(pool, req.user!, listSchema.parse(req.query)));
  });
  api.post('/items', (req, res) =>
    mutate(req, res, 201, (c) => items.createItem(c, req.user!, createSchema.parse(req.body))));
  api.get('/items/:id', async (req, res) => {
    res.json(await items.getItem(pool, req.user!, id.parse(req.params.id)));
  });
  api.patch('/items/:id', (req, res) =>
    mutate(req, res, 200, (c) => items.updateItem(c, req.user!, id.parse(req.params.id), updateSchema.parse(req.body))));
  api.post('/items/:id/claim', (req, res) =>
    mutate(req, res, 200, (c) => items.claimItem(c, req.user!, id.parse(req.params.id))));
  api.post('/items/:id/assign', (req, res) => {
    const body = z.object({ assignee_id: id.nullable(), version: z.number().int().positive() }).parse(req.body);
    return mutate(req, res, 200, (c) => items.assignItem(c, req.user!, id.parse(req.params.id), body));
  });
  api.post('/items/:id/transition', (req, res) => {
    const body = z.object({ to: z.enum(STATUSES), version: z.number().int().positive() }).parse(req.body);
    return mutate(req, res, 200, (c) => items.transitionItem(c, req.user!, id.parse(req.params.id), body));
  });
  api.post('/items/:id/comments', (req, res) => {
    const body = z.object({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
    return mutate(req, res, 201, (c) => items.addComment(c, req.user!, id.parse(req.params.id), body.body));
  });
  api.get('/items/:id/activity', async (req, res) => {
    const q = z.object({ cursor: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    res.json(await items.listActivity(pool, req.user!, id.parse(req.params.id), q.cursor, q.limit));
  });
  api.get('/notifications', async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, item_id, message, created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 20',
      [req.user!.id]);
    res.json({ notifications: rows });
  });
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'No such endpoint')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return void res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err instanceof z.ZodError) {
      return void res.status(400).json({ error: { code: 'validation_error', message: 'Invalid input', issues: err.issues } });
    }
    if (err instanceof SyntaxError) {
      return void res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  });
  return app;
}
