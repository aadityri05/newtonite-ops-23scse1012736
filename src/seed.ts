import bcrypt from 'bcryptjs';
import { pool } from './db.js';

export const DEMO_PASSWORD = 'Passw0rd!';
const TEAMS = ['Payments Ops', 'Customer Support', 'Compliance', 'Platform'];
// [email, name, [[team, role], ...]]
const USERS: [string, string, [string, string][]][] = [
  ['admin@ops.test', 'Ava Admin', TEAMS.map((t) => [t, 'admin'])],
  ['lead.payments@ops.test', 'Priya Lead (Payments)', [['Payments Ops', 'lead'], ['Platform', 'member']]],
  ['lead.support@ops.test', 'Sam Lead (Support)', [['Customer Support', 'lead']]],
  ['lead.compliance@ops.test', 'Cara Lead (Compliance)', [['Compliance', 'lead']]],
  ['alice@ops.test', 'Alice Member', [['Payments Ops', 'member']]],
  ['bob@ops.test', 'Bob Member', [['Payments Ops', 'member'], ['Customer Support', 'member']]],
  ['carol@ops.test', 'Carol Member', [['Customer Support', 'member']]],
  ['dan@ops.test', 'Dan Member', [['Compliance', 'member'], ['Platform', 'member']]],
  ['eve@ops.test', 'Eve Member', [['Platform', 'member'], ['Payments Ops', 'member']]],
  ['viewer@ops.test', 'Vik Viewer', [['Payments Ops', 'viewer'], ['Customer Support', 'viewer']]],
];
const TITLES = ['Payment failed for order', 'Customer cannot login', 'KYC document mismatch', 'Settlement delay',
  'Chargeback review', 'Compliance audit request', 'Refund stuck', 'Duplicate debit reported', 'Webhook retries failing'];
const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
const PRIOS = ['low', 'medium', 'high', 'urgent'];
const STATUS = ['open', 'open', 'open', 'in_progress', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export async function seed(itemCount = 5000) {
  if ((await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) return console.log('already seeded');
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const teamId = new Map<string, number>();
  for (const t of TEAMS) teamId.set(t, (await pool.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [t])).rows[0].id);

  const workers = new Map<number, number[]>(); // teamId -> users who can be assignees
  let creator = 0;
  for (const [email, name, memberships] of USERS) {
    const uid = (await pool.query('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, name, hash])).rows[0].id;
    if (!creator) creator = uid;
    for (const [t, role] of memberships) {
      await pool.query('INSERT INTO memberships VALUES ($1,$2,$3)', [uid, teamId.get(t), role]);
      if (role !== 'viewer') workers.set(teamId.get(t)!, [...(workers.get(teamId.get(t)!) ?? []), uid]);
    }
  }

  const cols: Record<string, unknown[]> = { title: [], description: [], type: [], priority: [], status: [], team: [], assignee: [], created: [] };
  const teams = [...teamId.values()];
  for (let i = 1; i <= itemCount; i++) {
    const team = pick(teams);
    const status = pick(STATUS);
    const pool_ = workers.get(team)!;
    const assignee = status === 'open' && Math.random() < 0.7 ? null : pick(pool_);
    cols.title.push(`${pick(TITLES)} #${i}`);
    cols.description.push(`Seeded item ${i}. Needs a look from the ${pick(['night', 'day', 'weekend'])} shift.`);
    cols.type.push(pick(TYPES)); cols.priority.push(pick(PRIOS)); cols.status.push(status);
    cols.team.push(team); cols.assignee.push(assignee);
    cols.created.push(new Date(Date.now() - Math.random() * 60 * 86400_000));
  }
  for (let s = 0; s < itemCount; s += 1000) {
    const sl = (k: string) => cols[k].slice(s, s + 1000);
    await pool.query(
      `INSERT INTO work_items (title, description, type, priority, status, team_id, assignee_id, created_by, created_at, updated_at)
       SELECT t, d, ty, p, st, tm, a, $9, c, c FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::timestamptz[])
         AS x(t, d, ty, p, st, tm, a, c)`,
      [sl('title'), sl('description'), sl('type'), sl('priority'), sl('status'), sl('team'), sl('assignee'), sl('created'), creator]);
  }
  await pool.query(`INSERT INTO activity_events (item_id, actor_id, kind, data, created_at)
    SELECT id, created_by, 'created', jsonb_build_object('title', title, 'seeded', true), created_at FROM work_items`);
  console.log(`seeded ${itemCount} items, ${USERS.length} users (password: ${DEMO_PASSWORD})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
}
