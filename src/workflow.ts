import { HttpError } from './errors.js';
import type { Role } from './permissions.js';

export const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'] as const;
export type Status = (typeof STATUSES)[number];

/** from -> to -> minimum role needed. Anything not listed is an invalid jump. */
export const TRANSITIONS: Record<Status, Partial<Record<Status, Role>>> = {
  open: { in_progress: 'member' },
  in_progress: { open: 'member', awaiting_approval: 'member' },
  awaiting_approval: { resolved: 'lead', in_progress: 'lead' }, // approve / reject: leads only
  resolved: { closed: 'member', open: 'lead' }, // reopen: leads only
  closed: {},
};

export function requiredRole(from: Status, to: Status): Role {
  const role = TRANSITIONS[from][to];
  if (!role) {
    throw new HttpError(409, 'invalid_transition', `Cannot move an item from ${from} to ${to}`, {
      allowed: Object.keys(TRANSITIONS[from]),
    });
  }
  return role;
}

export const isApproval = (from: Status) => from === 'awaiting_approval';
