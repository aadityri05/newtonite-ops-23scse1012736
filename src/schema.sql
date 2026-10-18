CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  PRIMARY KEY (user_id, team_id)
);

CREATE TABLE IF NOT EXISTS work_items (
  id bigserial PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority text NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  team_id int NOT NULL REFERENCES teams(id),
  assignee_id int REFERENCES users(id),
  created_by int NOT NULL REFERENCES users(id),
  due_date date,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || description)) STORED
);

CREATE INDEX IF NOT EXISTS idx_items_team_id ON work_items (team_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_team_status ON work_items (team_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_assignee ON work_items (assignee_id, id DESC) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_unassigned_urgent ON work_items (team_id, id DESC)
  WHERE assignee_id IS NULL AND priority = 'urgent' AND status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_items_awaiting ON work_items (team_id, id DESC) WHERE status = 'awaiting_approval';
CREATE INDEX IF NOT EXISTS idx_items_search ON work_items USING gin (search);

-- Append-only history. Comments are events of kind 'comment'.
CREATE TABLE IF NOT EXISTS activity_events (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES work_items(id),
  actor_id int NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_item ON activity_events (item_id, id);

CREATE OR REPLACE FUNCTION forbid_activity_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS activity_append_only ON activity_events;
CREATE TRIGGER activity_append_only BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_activity_change();

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id int NOT NULL REFERENCES users(id),
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code int,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (next_run_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  item_id bigint NOT NULL REFERENCES work_items(id),
  outbox_id bigint UNIQUE NOT NULL,  -- uniqueness makes the worker handler idempotent
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
