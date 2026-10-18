import { HttpError } from './errors.js';

export type Role = 'viewer' | 'member' | 'lead' | 'admin';
export const RANK: Record<Role, number> = { viewer: 0, member: 1, lead: 2, admin: 3 };

export type Action =
  | 'item:read' | 'item:create' | 'item:edit' | 'item:claim'
  | 'item:comment' | 'item:transition' | 'item:assign';

/** Role x action matrix: the minimum role (inside the item's team) for each action. */
export const MIN_ROLE: Record<Action, Role> = {
  'item:read': 'viewer',
  'item:create': 'member',
  'item:edit': 'member',
  'item:claim': 'member',
  'item:comment': 'member',
  'item:transition': 'member', // approval transitions raise this via workflow.ts
  'item:assign': 'lead',
};

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  memberships: Map<number, Role>; // teamId -> role
}

/**
 * The ONE permission check used by every endpoint.
 * existing=true: the resource exists, so a non-member gets 404 (don't leak existence).
 * existing=false (e.g. creating in a team): non-member gets 403.
 */
export function authorize(
  user: AuthUser,
  action: Action,
  teamId: number,
  opts: { existing?: boolean; minRole?: Role } = {},
): Role {
  const role = user.memberships.get(teamId);
  if (!role) {
    if (opts.existing) throw new HttpError(404, 'not_found', 'Item not found');
    throw new HttpError(403, 'forbidden', 'You are not a member of this team');
  }
  let need = MIN_ROLE[action];
  if (opts.minRole && RANK[opts.minRole] > RANK[need]) need = opts.minRole;
  if (RANK[role] < RANK[need]) {
    throw new HttpError(403, 'forbidden', `This action requires the ${need} role in this team`);
  }
  return role;
}
