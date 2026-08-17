// Staff console auth: scrypt password hashes, DB-backed cookie sessions,
// per-session CSRF tokens, and role gates. No external crypto dependencies.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StaffSession } from '../types';

export const SESSION_COOKIE = 'kz_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

const SALT_BYTES = 16;
const KEY_BYTES = 64;

export interface AuthedStaff {
  staffId: number;
  role: string;
  login: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAuth for every authenticated /console request. */
    staff?: AuthedStaff;
    /** The raw session token (needed for logout and CSRF derivation). */
    sessionToken?: string;
  }
}

/** `${saltHex}:${scryptHex}` — scryptSync(pass, salt, 64) with a random 16-byte salt. */
export function hashPassword(pass: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(pass, salt, KEY_BYTES);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pass: string, stored: string): boolean {
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
  const actual = scryptSync(pass, salt, KEY_BYTES);
  return timingSafeEqual(actual, expected);
}

/** The subset of Store the auth layer needs (structural, for easy faking). */
export interface SessionStore {
  createSession(token: string, staffId: number, expiresAtIso: string): void;
  findSession(token: string): StaffSession | null;
}

export function createSessionFor(store: SessionStore, staffId: number): string {
  const token = randomUUID();
  store.createSession(token, staffId, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return token;
}

/**
 * Anti-CSRF token, derived from the httpOnly session token. Only pages we
 * render (which know the token server-side) can embed it in a form; a
 * cross-site attacker cannot read the cookie and so cannot compute it.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`kz-csrf:${sessionToken}`).digest('hex');
}

export const FORBIDDEN_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>403</title></head>' +
  '<body style="font-family:system-ui;padding:2rem"><h1>403 — недостаточно прав</h1>' +
  '<p><a href="/console">← в консоль</a></p></body></html>';

/**
 * onRequest hook for the /console scope: everything except the login page
 * requires a live session cookie; expired/missing → 302 to the login page.
 */
export function requireAuth(store: SessionStore) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = req.url.split('?')[0];
    if (path === '/console/login') return;
    // Стили тоже открыты: иначе браузер запрашивает их без сессии, получает редирект
    // на логин и рисует самый первый экран владельца голым HTML без единого стиля.
    if (/^\/console\/app\.[\w.-]+\.css$/.test(path)) return;
    const token = req.cookies?.[SESSION_COOKIE];
    const session = token ? store.findSession(token) : null;
    if (!token || !session) {
      await reply.redirect('/console/login');
      return;
    }
    req.staff = { staffId: session.staffId, role: session.role, login: session.login };
    req.sessionToken = token;
  };
}

/** Route-level role gate: preHandler that 403s anyone who is not `role`. */
export function requireRole(role: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.staff?.role !== role) {
      await reply.code(403).type('text/html; charset=utf-8').send(FORBIDDEN_HTML);
    }
  };
}
