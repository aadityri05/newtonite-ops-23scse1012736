import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { processOutbox } from '../src/outbox.js';

const app = createApp();
const PW = 'pw-test-1';
const U: Record<string, number> = {};
const T: Record<string, number> = {};
const tokens: Record<string, string> = {};

async function addUser(key: string, memberships: [string, string][]) {
  const hash = await bcrypt.hash(PW, 4);
  const id = (await pool.query('INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING id',
    [`${key}@t.test`, key, hash])).rows[0].id;
  U[key] = id;
  for (const [team, role] of memberships) await pool.query('INSERT INTO memberships VALUES ($1,$2,$3)', [id, T[team], role]);
  tokens[key] = (await request(app).post('/api/login').send({ email: `${key}@t.test`, password: PW })).body.token;
}
const as = (u: string) => ({ Authorization: `Bearer ${tokens[u]}` });
const newItem = async (u = 'lead', body: object = {}) =>
  (await request(app).post('/api/items').set(as(u))
    .send({ title: 'Payment stuck', type: 'payment', priority: 'high', team_id: T.A, ...body })).body;
const events = async (itemId: number) =>
  (await pool.query('SELECT kind, data FROM activity_events WHERE item_id=$1 ORDER BY id', [itemId])).rows;

beforeAll(async () => { await migrate(); });
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query(`TRUNCATE activity_events, notifications, outbox, idempotency_keys, memberships, work_items, teams, users RESTART IDENTITY CASCADE`);
  T.A = (await pool.query(`INSERT INTO teams (name) VALUES ('A') RETURNING id`)).rows[0].id;
  T.B = (await pool.query(`INSERT INTO teams (name) VALUES ('B') RETURNING id`)).rows[0].id;
  await addUser('lead', [['A', 'lead']]);
  await addUser('m1', [['A', 'member']]);
  await addUser('m2', [['A', 'member']]);
  await addUser('m3', [['A', 'member']]);
  await addUser('viewer', [['A', 'viewer']]);
  await addUser('outsider', [['B', 'lead']]);
});

describe('concurrent claim', () => {
  it('exactly one of many parallel claims wins; the rest get 409', async () => {
    const item = await newItem();
    const users = ['m1', 'm2', 'm3', 'lead', 'm1', 'm2', 'm3', 'lead'];
    const results = await Promise.all(users.map((u) => request(app).post(`/api/items/${item.id}/claim`).set(as(u))));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(users.length - 1);
    expect((await events(item.id)).filter((e) => e.kind === 'assigned')).toHaveLength(1);
    const final = (await request(app).get(`/api/items/${item.id}`).set(as('lead'))).body;
    expect(final.version).toBe(2); // created=1, one successful claim=2
  });
});

describe('stale updates (optimistic locking)', () => {
  it('rejects an old version with 409 + latest item and leaves data unchanged', async () => {
    const item = await newItem();
    const ok = await request(app).patch(`/api/items/${item.id}`).set(as('m1')).send({ version: 1, title: 'First edit' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await request(app).patch(`/api/items/${item.id}`).set(as('m2')).send({ version: 1, title: 'Stale edit' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.current.title).toBe('First edit');
    const row = (await pool.query('SELECT title, version FROM work_items WHERE id=$1', [item.id])).rows[0];
    expect(row).toEqual({ title: 'First edit', version: 2 });
  });

  it('two parallel edits with the same version: one wins, one conflicts', async () => {
    const item = await newItem();
    const [a, b] = await Promise.all(['m1', 'm2'].map((u) =>
      request(app).patch(`/api/items/${item.id}`).set(as(u)).send({ version: 1, priority: 'urgent' })));
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe('idempotency', () => {
  it('same key twice creates one item and returns the same response', async () => {
    const send = () => request(app).post('/api/items').set(as('m1')).set('Idempotency-Key', 'k-1')
      .send({ title: 'Once', type: 'task', priority: 'low', team_id: T.A });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect((await pool.query('SELECT count(*)::int AS n FROM work_items')).rows[0].n).toBe(1);
  });

  it('parallel duplicates (double-click) still create exactly one item', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => request(app).post('/api/items').set(as('m1'))
      .set('Idempotency-Key', 'k-par').send({ title: 'Dbl', type: 'task', priority: 'low', team_id: T.A })));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM work_items')).rows[0].n).toBe(1);
  });

  it('reusing a key with a different body is rejected', async () => {
    const mk = (title: string) => request(app).post('/api/items').set(as('m1')).set('Idempotency-Key', 'k-2')
      .send({ title, type: 'task', priority: 'low', team_id: T.A });
    expect((await mk('one')).status).toBe(201);
    expect((await mk('two')).status).toBe(422);
  });
});

describe('workflow rules', () => {
  const move = (u: string, id: number, to: string, version: number) =>
    request(app).post(`/api/items/${id}/transition`).set(as(u)).send({ to, version });

  it('rejects invalid jumps (open -> closed) with 409', async () => {
    const item = await newItem();
    const r = await move('lead', item.id, 'closed', 1);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('invalid_transition');
  });

  it('requires an owner before work starts', async () => {
    const item = await newItem();
    expect((await move('m1', item.id, 'in_progress', 1)).status).toBe(422);
  });

  it('approval only by a Lead, never by the assignee; full happy path is recorded', async () => {
    const item = await newItem('m1');
    await request(app).post(`/api/items/${item.id}/claim`).set(as('m1'));           // v2
    expect((await move('m1', item.id, 'in_progress', 2)).status).toBe(200);          // v3
    expect((await move('m1', item.id, 'awaiting_approval', 3)).status).toBe(200);    // v4
    const member = await move('m2', item.id, 'resolved', 4);
    expect(member.status).toBe(403);
    const approved = await move('lead', item.id, 'resolved', 4);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('resolved');
    const statusEvents = (await events(item.id)).filter((e) => e.kind === 'status_changed').map((e) => e.data);
    expect(statusEvents.map((d) => d.to)).toEqual(['in_progress', 'awaiting_approval', 'resolved']);
  });

  it('a lead cannot approve their own item', async () => {
    const item = await newItem('lead');
    await request(app).post(`/api/items/${item.id}/claim`).set(as('lead'));
    await move('lead', item.id, 'in_progress', 2);
    await move('lead', item.id, 'awaiting_approval', 3);
    const r = await move('lead', item.id, 'resolved', 4);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('self_approval');
  });

  it('stale transition is rejected with 409', async () => {
    const item = await newItem();
    await request(app).post(`/api/items/${item.id}/claim`).set(as('m1'));
    const r = await move('m1', item.id, 'in_progress', 1);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('version_conflict');
  });
});

describe('resource-level authorization', () => {
  it('a user from another team cannot read or write (404, existence hidden)', async () => {
    const item = await newItem();
    const h = as('outsider');
    expect((await request(app).get(`/api/items/${item.id}`).set(h)).status).toBe(404);
    expect((await request(app).patch(`/api/items/${item.id}`).set(h).send({ version: 1, title: 'x' })).status).toBe(404);
    expect((await request(app).post(`/api/items/${item.id}/claim`).set(h)).status).toBe(404);
    expect((await request(app).post(`/api/items/${item.id}/comments`).set(h).send({ body: 'hi' })).status).toBe(404);
    expect((await request(app).get(`/api/items/${item.id}/activity`).set(h)).status).toBe(404);
  });

  it('creating in a team you do not belong to is 403; list never leaks other teams', async () => {
    await newItem();
    const r = await request(app).post('/api/items').set(as('outsider'))
      .send({ title: 'x', type: 'task', priority: 'low', team_id: T.A });
    expect(r.status).toBe(403);
    expect((await request(app).get('/api/items').set(as('outsider'))).body.items).toHaveLength(0);
    expect((await request(app).get('/api/items').set(as('m1'))).body.items).toHaveLength(1);
  });

  it('viewers can read but not write; only leads can reassign', async () => {
    const item = await newItem();
    expect((await request(app).get(`/api/items/${item.id}`).set(as('viewer'))).status).toBe(200);
    expect((await request(app).post(`/api/items/${item.id}/claim`).set(as('viewer'))).status).toBe(403);
    expect((await request(app).post(`/api/items/${item.id}/comments`).set(as('viewer')).send({ body: 'hi' })).status).toBe(403);
    const asMember = await request(app).post(`/api/items/${item.id}/assign`).set(as('m1')).send({ assignee_id: U.m2, version: 1 });
    expect(asMember.status).toBe(403);
    const asLead = await request(app).post(`/api/items/${item.id}/assign`).set(as('lead')).send({ assignee_id: U.m2, version: 1 });
    expect(asLead.status).toBe(200);
    expect(asLead.body.assignee_id).toBe(U.m2);
  });

  it('rejects requests without a valid token', async () => {
    expect((await request(app).get('/api/items')).status).toBe(401);
    expect((await request(app).get('/api/items').set('Authorization', 'Bearer nope')).status).toBe(401);
  });
});

describe('activity history', () => {
  it('records created, priority, field, assignment and comment events in order', async () => {
    const item = await newItem('m1');
    await request(app).patch(`/api/items/${item.id}`).set(as('m1')).send({ version: 1, priority: 'urgent', title: 'New title' });
    await request(app).post(`/api/items/${item.id}/claim`).set(as('m2'));
    await request(app).post(`/api/items/${item.id}/comments`).set(as('m2')).send({ body: 'On it' });
    const kinds = (await events(item.id)).map((e) => e.kind);
    expect(kinds).toEqual(['created', 'priority_changed', 'updated', 'assigned', 'comment']);
    const api = await request(app).get(`/api/items/${item.id}/activity`).set(as('viewer'));
    expect(api.body.events.map((e: any) => e.kind)).toEqual(kinds);
  });

  it('is append-only at the database level', async () => {
    const item = await newItem();
    await expect(pool.query('DELETE FROM activity_events WHERE item_id=$1', [item.id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`UPDATE activity_events SET kind='x' WHERE item_id=$1`, [item.id])).rejects.toThrow(/append-only/);
  });

  it('a failed change writes neither the item change nor an event', async () => {
    const item = await newItem();
    await request(app).patch(`/api/items/${item.id}`).set(as('m1')).send({ version: 99, title: 'nope' });
    expect(await events(item.id)).toHaveLength(1); // only "created"
  });
});

describe('listing, filters, pagination', () => {
  it('pages through everything exactly once with a cursor', async () => {
    for (let i = 0; i < 25; i++) await newItem('m1', { title: `Item ${i}` });
    const seen: number[] = [];
    let cursor: number | null = null;
    do {
      const res: any = await request(app).get('/api/items').set(as('m1')).query({ limit: 10, ...(cursor ? { cursor } : {}) });
      seen.push(...res.body.items.map((i: any) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('dashboard views and search are computed on the server', async () => {
    const urgent = await newItem('m1', { priority: 'urgent', title: 'Refund gateway down' });
    await newItem('m1', { priority: 'low', title: 'Typo in footer' });
    const claimed = await newItem('m1', { priority: 'high' });
    await request(app).post(`/api/items/${claimed.id}/claim`).set(as('m2'));

    const get = async (u: string, query: object) => (await request(app).get('/api/items').set(as(u)).query(query)).body.items;
    expect((await get('m1', { view: 'unassigned_urgent' })).map((i: any) => i.id)).toEqual([urgent.id]);
    expect((await get('m2', { view: 'assigned_to_me' })).map((i: any) => i.id)).toEqual([claimed.id]);
    expect((await get('m1', { q: 'refund' })).map((i: any) => i.id)).toEqual([urgent.id]);

    // awaiting approval shows up only for leads of that team (and not for the assignee)
    await request(app).post(`/api/items/${claimed.id}/transition`).set(as('m2')).send({ to: 'in_progress', version: 2 });
    await request(app).post(`/api/items/${claimed.id}/transition`).set(as('m2')).send({ to: 'awaiting_approval', version: 3 });
    expect((await get('lead', { view: 'awaiting_my_approval' })).map((i: any) => i.id)).toEqual([claimed.id]);
    expect(await get('m1', { view: 'awaiting_my_approval' })).toHaveLength(0);
  });
});

describe('transactional outbox + worker', () => {
  it('claim writes a job in the same transaction; processing twice yields ONE notification', async () => {
    const item = await newItem();
    await request(app).post(`/api/items/${item.id}/claim`).set(as('m1'));
    expect((await pool.query(`SELECT count(*)::int n FROM outbox WHERE status='pending'`)).rows[0].n).toBe(1);

    expect((await processOutbox()).done).toBe(1);
    await pool.query(`UPDATE outbox SET status='pending'`); // simulate crash-before-ack / duplicate delivery
    await processOutbox();
    const n = (await pool.query('SELECT user_id FROM notifications')).rows;
    expect(n).toHaveLength(1);
    expect(n[0].user_id).toBe(U.m1);
  });

  it('a failing job retries with backoff, then is marked failed after max attempts', async () => {
    await pool.query(`INSERT INTO outbox (kind, payload, max_attempts) VALUES ('always_fails','{}',3)`);
    const handlers = { always_fails: async () => { throw new Error('boom'); } };
    const t0 = new Date();
    const hour = 3600_000;
    expect(await processOutbox({ handlers, now: t0 })).toMatchObject({ retried: 1 });
    expect(await processOutbox({ handlers, now: t0 })).toMatchObject({ retried: 0 }); // backoff: not due yet
    expect(await processOutbox({ handlers, now: new Date(+t0 + hour) })).toMatchObject({ retried: 1 });
    expect(await processOutbox({ handlers, now: new Date(+t0 + 2 * hour) })).toMatchObject({ failed: 1 });
    const row = (await pool.query('SELECT status, attempts, last_error FROM outbox')).rows[0];
    expect(row).toEqual({ status: 'failed', attempts: 3, last_error: 'boom' });
  });

  it('a rolled-back change leaves no job behind', async () => {
    const item = await newItem();
    await request(app).patch(`/api/items/${item.id}`).set(as('m1')).send({ version: 42, title: 'x' });
    expect((await pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n).toBe(0);
  });
});
