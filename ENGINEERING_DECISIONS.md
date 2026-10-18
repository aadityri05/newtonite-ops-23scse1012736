# Engineering decisions

## 1. Concurrency: conditional SQL instead of application-level locks
**Context.** Two people can claim the same item, edit from stale screens, or fire the same request twice.
**Options.** (a) read-then-write in the app, (b) `SELECT … FOR UPDATE` row locks, (c) conditional
`UPDATE … WHERE` checks that express the rule in the statement itself.
**Choice.** (c). Claim is `UPDATE … SET assignee_id=$u WHERE id=$id AND assignee_id IS NULL`; edits and
transitions add `AND version=$client_version` and bump `version`. Zero rows updated means someone else won,
and the API answers 409 with the latest item so the UI can show "this item changed, reload".
**Trade-off.** Clients must send `version` and handle 409s (a little UI work), and failed attempts are
retried by the user rather than queued. In return there is no lock held across requests, no deadlock
risk, and Postgres guarantees only one concurrent writer wins.

## 2. History is written in the same transaction as the change
**Context.** An audit log that can disagree with the item is worse than none.
**Choice.** Every service function receives the transaction client and writes the item change, the
`activity_events` row, and any outbox row together. A failed change (e.g. 409) rolls back all of it, which
tests assert. `activity_events` is append-only, enforced by a database trigger rather than by convention.
Comments are events of kind `comment` instead of a separate table.
**Trade-off.** Slightly more writes per request and one hot table (see scale below). Comments cannot be
edited or deleted, which is intentional for accountability.

## 3. Authorization: one function, scoped to the item's team, enforced on the server
**Context.** Hidden buttons are not security.
**Choice.** `authorize(user, action, teamId, {minRole})` in `permissions.ts` is the only place roles are
compared; every service function calls it after loading the item, using the item's own `team_id`. Roles are
read from the database on every request, so a demotion applies immediately. Non-members get **404** on
existing items (existence is not leaked) and **403** when creating in a team they are not in. The approval
step is a workflow rule (`awaiting_approval → resolved` needs a Lead) plus a four-eyes rule (the assignee
cannot approve their own item).
**Trade-off.** One extra query per request for memberships, and clients must handle 404-vs-403. Roles are
per team, so someone who is Lead in one team and Member in another is handled correctly.

## 4. Idempotency keys stored in the same transaction as the work
**Context.** Double-clicks and network retries must not create duplicates.
**Choice.** Clients send an `Idempotency-Key` header on mutations. The key row is inserted in the same
transaction as the change, primary key `(user_id, key)`. A concurrent duplicate blocks on that unique key
until the first transaction commits, then replays the stored response (`Idempotent-Replay: true`). Reusing a
key with a different body returns 422. Failed requests roll the key back, so a retry runs again.
**Trade-off.** Keys accumulate (no TTL cleanup yet) and only successful responses are replayed.

## 5. Async work through a transactional outbox, polled by a worker
**Context.** Notifying a new assignee must not be lost, and must not block or fail the request.
**Options.** Call the notifier inline, publish to a queue after commit, or write an outbox row in the transaction.
**Choice.** Outbox row written with the change; a worker claims due rows with `FOR UPDATE SKIP LOCKED`, runs the
handler in a savepoint, then marks the job `done`, reschedules it with exponential backoff, or marks it `failed`
after `max_attempts`. The handler is idempotent (`UNIQUE(outbox_id)` + `ON CONFLICT DO NOTHING`), so at-least-once
delivery produces exactly one notification.
**Trade-off.** Polling every 2 s adds latency and load compared with a broker; a "notification" is a row, not an email.

## 6. Search and pagination live in the database
Lists use keyset pagination (`id < cursor ORDER BY id DESC LIMIT n+1`), never OFFSET, so page cost stays flat as
the table grows and rows never repeat or skip while new items arrive. Indexes: `(team_id, id DESC)`,
`(team_id, status, id DESC)`, `(assignee_id, id DESC)`, partial indexes for the unassigned-urgent and
awaiting-approval dashboards, and a GIN index on a generated `tsvector` for search. Trade-off: results are
ordered by creation, not last activity, and search matches whole words only (`simple` config, no stemming or typo tolerance).

## What I chose not to build
Email delivery, attachments, SSO, websockets (the UI refetches after each action), sign-up, password reset, styling.

## Known limitations
* Login has no rate limiting or lockout; tokens cannot be revoked before they expire (12 h).
* Search is word-based only; no relevance ranking or fuzzy matching.
* The activity table grows forever; no archiving or partitioning. Idempotency keys and finished outbox rows are never purged.
* The worker holds one transaction for a whole batch, so a slow handler delays others in its batch.
* The UI is basic: only "claim" is optimistic, there are no live updates, and assignment events show user ids instead of names.
* No browser end-to-end tests; the UI was only checked manually.

## At 10× scale I would
Partition `activity_events` by time, move search to a dedicated engine, add read replicas for dashboards, replace polling
with a real queue (or `LISTEN/NOTIFY`) and push updates over SSE/websockets, and purge idempotency keys and finished jobs on a schedule.
