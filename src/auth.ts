import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import type { AuthUser, Role } from './permissions.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export const signToken = (userId: number) =>
  jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '12h' });

/** Roles are loaded fresh on every request, so a role change takes effect immediately. */
export async function loadUser(id: number): Promise<AuthUser | null> {
  const u = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [id]);
  if (!u.rows[0]) return null;
  const m = await pool.query('SELECT team_id, role FROM memberships WHERE user_id = $1', [id]);
  return {
    ...u.rows[0],
    memberships: new Map<number, Role>(m.rows.map((r) => [r.team_id, r.role])),
  };
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  let userId: number;
  try {
    userId = Number((jwt.verify(token, config.jwtSecret) as jwt.JwtPayload).sub);
  } catch {
    throw new HttpError(401, 'unauthenticated', 'Missing or invalid token');
  }
  const user = await loadUser(userId);
  if (!user) throw new HttpError(401, 'unauthenticated', 'Unknown user');
  req.user = user;
  next();
};
