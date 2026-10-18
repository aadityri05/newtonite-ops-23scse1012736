import { HttpError } from './errors.js';
import type { Q } from './db.js';
import type { PoolClient } from 'pg';
import { authorize, RANK, type Action, type AuthUser, type Role } from './permissions.js';
import { isApproval, requiredRole, type Status } from './workflow.js';

const ITEM_COLS = `w.id, w.title, w.description, w.type, w.priority, w.status,
  w.team_id, t.name AS team_name, w.assignee_id, a.name AS assignee_name,
  w.created_by, cb.name AS created_by_name, w.due_date, w.version, w.created_at, w.updated_at`;
const ITEM_FROM = `work_items w JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id JOIN users cb ON cb.id = w.created_by`;

export async function fetchItem(q: Q, id: number) {
  const { rows } = await q.query(`SELECT ${ITEM_COLS} FROM ${ITEM_FROM} WHERE w.id = $1`, [id]);
  return rows[0];
}

/** Load an item and run the single permission check against ITS team. */
async function loadItem(c: Q, id: number, user: AuthUser, action: Action, minRole?: Role) {
  const { rows } = await c.query(
    `SELECT id, team_id, status, assignee_id, priority, title, description, type, due_date, version
       FROM work_items WHERE id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Item not found');
  authorize(user, action, rows[0].team_id, { existing: true, minRole });
  return rows[0];
}

async function conflict(c: Q, id: number, code: string, message: string): Promise<never> {
  throw new HttpError(409, code, message, { current: await fetchItem(c, id) });
}

/** History and queue writes always use the caller's transaction client. */
const recordEvent = (c: PoolClient, itemId: number, actorId: number, kind: string, data: object = {}) =>
  c.query('INSERT INTO activity_events (item_id, actor_id, kind, data) VALUES ($1,$2,$3,$4)',
    [itemId, actorId, kind, JSON.stringify(data)]);

const enqueue = (c: PoolClient, kind: string, payload: object) =>
  c.query('INSERT INTO outbox (kind, payload) VALUES ($1,$2)', [kind, JSON.stringify(payload)]);

async function assertAssignable(c: Q, teamId: number, userId: number) {
  const { rows } = await c.query('SELECT role FROM memberships WHERE team_id=$1 AND user_id=$2', [teamId, userId]);
  if (!rows[0] || RANK[rows[0].role as Role] < RANK.member) {
    throw new HttpError(422, 'invalid_assignee', 'Assignee must be a member (or higher) of the item\'s team');
  }
}

export interface CreateInput {
  title: string; description?: string; type: string; priority: string;
  team_id: number; assignee_id?: number | null; due_date?: string | null;
}

export async function createItem(c: PoolClient, user: AuthUser, input: CreateInput) {
  authorize(user, 'item:create', input.team_id);
  if (input.assignee_id) await assertAssignable(c, input.team_id, input.assignee_id);
  const { rows } = await c.query(
    `INSERT INTO work_items (title, description, type, priority, team_id, assignee_id, created_by, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [input.title, input.description ?? '', input.type, input.priority, input.team_id,
     input.assignee_id ?? null, user.id, input.due_date ?? null]);
  const id = rows[0].id as number;
  await recordEvent(c, id, user.id, 'created',
    { title: input.title, type: input.type, priority: input.priority });
  if (input.assignee_id) {
    await recordEvent(c, id, user.id, 'assigned', { from: null, to: input.assignee_id });
    await enqueue(c, 'notify_assignee', { itemId: id, userId: input.assignee_id });
  }
  return fetchItem(c, id);
}

export interface UpdateInput {
  version: number; title?: string; description?: string; type?: string;
  priority?: string; due_date?: string | null;
}

/** Optimistic locking: UPDATE ... WHERE version = $client_version. 0 rows => 409 with latest. */
export async function updateItem(c: PoolClient, user: AuthUser, id: number, input: UpdateInput) {
  const cur = await loadItem(c, id, user, 'item:edit');
  if (cur.status === 'closed') throw new HttpError(409, 'item_closed', 'Closed items cannot be edited');

  const fields = ['title', 'description', 'type', 'priority', 'due_date'] as const;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (input[f] !== undefined && (input[f] ?? null) !== (cur[f] ?? null)) {
      changes[f] = { from: cur[f] ?? null, to: input[f] ?? null };
    }
  }
  const names = Object.keys(changes);
  if (names.length === 0) {
    if (cur.version !== input.version) await conflict(c, id, 'version_conflict', 'This item changed, reload');
    return fetchItem(c, id);
  }
  const sets = names.map((n, i) => `${n} = $${i + 3}`).join(', ');
  const res = await c.query(
    `UPDATE work_items SET ${sets}, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING id`,
    [id, input.version, ...names.map((n) => changes[n].to)]);
  if (res.rowCount === 0) await conflict(c, id, 'version_conflict', 'This item changed, reload');

  if (changes.priority) {
    await recordEvent(c, id, user.id, 'priority_changed', changes.priority);
    delete changes.priority;
  }
  if (Object.keys(changes).length) await recordEvent(c, id, user.id, 'updated', { changes });
  return fetchItem(c, id);
}

/** Atomic claim: single conditional UPDATE. Exactly one concurrent caller sees rowCount = 1. */
export async function claimItem(c: PoolClient, user: AuthUser, id: number) {
  await loadItem(c, id, user, 'item:claim');
  const res = await c.query(
    `UPDATE work_items SET assignee_id = $2, version = version + 1, updated_at = now()
      WHERE id = $1 AND assignee_id IS NULL AND status IN ('open','in_progress','awaiting_approval')
      RETURNING id`, [id, user.id]);
  if (res.rowCount === 0) {
    const cur = await fetchItem(c, id);
    if (cur.assignee_id) await conflict(c, id, 'already_claimed', `Already claimed by ${cur.assignee_name}`);
    await conflict(c, id, 'item_not_claimable', `A ${cur.status} item cannot be claimed`);
  }
  await recordEvent(c, id, user.id, 'assigned', { from: null, to: user.id, via: 'claim' });
  await enqueue(c, 'notify_assignee', { itemId: id, userId: user.id });
  return fetchItem(c, id);
}

/** Lead-only (re)assignment, version checked. assignee_id = null unassigns. */
export async function assignItem(
  c: PoolClient, user: AuthUser, id: number, input: { assignee_id: number | null; version: number },
) {
  const cur = await loadItem(c, id, user, 'item:assign');
  if (cur.status === 'closed') throw new HttpError(409, 'item_closed', 'Closed items cannot be reassigned');
  if (input.assignee_id) await assertAssignable(c, cur.team_id, input.assignee_id);
  const res = await c.query(
    `UPDATE work_items SET assignee_id = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING id`, [id, input.version, input.assignee_id]);
  if (res.rowCount === 0) await conflict(c, id, 'version_conflict', 'This item changed, reload');
  await recordEvent(c, id, user.id, 'assigned', { from: cur.assignee_id, to: input.assignee_id, via: 'reassign' });
  if (input.assignee_id) await enqueue(c, 'notify_assignee', { itemId: id, userId: input.assignee_id });
  return fetchItem(c, id);
}

export async function transitionItem(
  c: PoolClient, user: AuthUser, id: number, input: { to: Status; version: number },
) {
  const cur = await loadItem(c, id, user, 'item:transition'); // membership + base role
  const from = cur.status as Status;
  const need = requiredRole(from, input.to); // 409 if the jump is not allowed
  authorize(user, 'item:transition', cur.team_id, { existing: true, minRole: need });
  if (isApproval(from) && cur.assignee_id === user.id) {
    throw new HttpError(403, 'self_approval', 'You cannot approve or reject your own item');
  }
  if (input.to === 'in_progress' && !cur.assignee_id) {
    throw new HttpError(422, 'assignee_required', 'Claim or assign the item before starting work');
  }
  const res = await c.query(
    `UPDATE work_items SET status = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING id`, [id, input.version, input.to]);
  if (res.rowCount === 0) await conflict(c, id, 'version_conflict', 'This item changed, reload');
  await recordEvent(c, id, user.id, 'status_changed', { from, to: input.to });
  return fetchItem(c, id);
}

export async function addComment(c: PoolClient, user: AuthUser, id: number, body: string) {
  await loadItem(c, id, user, 'item:comment');
  const { rows } = await c.query(
    `INSERT INTO activity_events (item_id, actor_id, kind, data) VALUES ($1,$2,'comment',$3)
     RETURNING id, kind, data, created_at`, [id, user.id, JSON.stringify({ body })]);
  return { ...rows[0], item_id: id, actor_id: user.id, actor_name: user.name };
}

export async function getItem(q: Q, user: AuthUser, id: number) {
  await loadItem(q, id, user, 'item:read');
  return fetchItem(q, id);
}

export async function listActivity(q: Q, user: AuthUser, id: number, after: number, limit: number) {
  await loadItem(q, id, user, 'item:read');
  const { rows } = await q.query(
    `SELECT e.id, e.item_id, e.actor_id, u.name AS actor_name, e.kind, e.data, e.created_at
       FROM activity_events e JOIN users u ON u.id = e.actor_id
      WHERE e.item_id = $1 AND e.id > $2 ORDER BY e.id ASC LIMIT $3`, [id, after, limit + 1]);
  const page = rows.slice(0, limit);
  return { events: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

export interface ListQuery {
  view?: 'assigned_to_me' | 'unassigned_urgent' | 'awaiting_my_approval';
  status?: string; priority?: string; type?: string; team_id?: number;
  assignee?: string; q?: string; cursor?: number; limit: number;
}

/** Server-side filtering, search and keyset pagination, always scoped to the caller's teams. */
export async function listItems(q: Q, user: AuthUser, f: ListQuery) {
  const teamIds = [...user.memberships.keys()];
  if (teamIds.length === 0) return { items: [], nextCursor: null };
  const leadTeams = [...user.memberships].filter(([, r]) => RANK[r] >= RANK.lead).map(([t]) => t);

  const params: unknown[] = [teamIds];
  const where = ['w.team_id = ANY($1)'];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

  if (f.view === 'assigned_to_me') { add('w.assignee_id = ?', user.id); where.push("w.status <> 'closed'"); }
  if (f.view === 'unassigned_urgent') {
    where.push("w.assignee_id IS NULL AND w.priority = 'urgent' AND w.status NOT IN ('resolved','closed')");
  }
  if (f.view === 'awaiting_my_approval') {
    where.push("w.status = 'awaiting_approval'");
    add('w.team_id = ANY(?)', leadTeams);
    add('w.assignee_id IS DISTINCT FROM ?', user.id);
  }
  if (f.status) add('w.status = ?', f.status);
  if (f.priority) add('w.priority = ?', f.priority);
  if (f.type) add('w.type = ?', f.type);
  if (f.team_id) add('w.team_id = ?', f.team_id);
  if (f.assignee === 'me') add('w.assignee_id = ?', user.id);
  else if (f.assignee === 'none') where.push('w.assignee_id IS NULL');
  else if (f.assignee) add('w.assignee_id = ?', Number(f.assignee));
  if (f.q) add("w.search @@ plainto_tsquery('simple', ?)", f.q);
  if (f.cursor) add('w.id < ?', f.cursor);

  params.push(f.limit + 1);
  const { rows } = await q.query(
    `SELECT ${ITEM_COLS} FROM ${ITEM_FROM} WHERE ${where.join(' AND ')}
      ORDER BY w.id DESC LIMIT $${params.length}`, params);
  const items = rows.slice(0, f.limit);
  return { items, nextCursor: rows.length > f.limit ? items[items.length - 1].id : null };
}
