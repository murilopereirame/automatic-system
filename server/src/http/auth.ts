/**
 * Single-user authentication. The user logs in with AUTOWORKER_TOKEN and gets
 * an HttpOnly session cookie. API clients may send the token as a Bearer
 * header instead.
 */
import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { safeEqual } from '../triggers/webhook.js';

const COOKIE = 'autoworker_session';
/** Derived from the token, so changing the token signs everyone out. */
const sessionValue = createHmac('sha256', config.token).update('autoworker-session').digest('hex');

function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

export function isAuthenticated(headers: FastifyRequest['headers']): boolean {
  const bearer = (headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (bearer && safeEqual(bearer, config.token)) return true;
  return safeEqual(readCookie(headers.cookie, COOKIE), sessionValue);
}

export function requireAuth(request: FastifyRequest): void {
  if (!isAuthenticated(request.headers)) throw new HttpError(401, 'Not signed in');
}

export function login(token: string, request: FastifyRequest, reply: FastifyReply): void {
  if (!safeEqual(token, config.token)) throw new HttpError(401, 'Wrong token');
  const secure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
  reply.header('Set-Cookie', `${COOKIE}=${sessionValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`);
}

export function logout(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/**
 * Browsers do not apply the same-origin policy to WebSockets, so the shell
 * endpoint checks that the page opening it was served by this app.
 */
export function isSameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // Not a browser.
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}
