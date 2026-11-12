import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { readState, writeState, type State } from './config.js';

const SCRYPT_N = 16384;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 5;
export const COOKIE_NAME = 'cremote_session';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [algo, n, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n) });
  return crypto.timingSafeEqual(expected, actual);
}

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

/** Trust X-Real-IP only when the socket peer is loopback (nginx via the tunnel). */
export function clientIp(req: IncomingMessage): string {
  const sock = req.socket.remoteAddress ?? '';
  const real = req.headers['x-real-ip'];
  if (isLoopback(sock) && typeof real === 'string' && real) return real.trim();
  return sock;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  private state: State;
  private failures = new Map<string, number[]>();

  constructor(state: State, private persist: (s: State) => void = writeState) {
    this.state = state;
    this.prune();
  }

  static load(): Auth {
    return new Auth(readState());
  }

  get stateRef(): State {
    return this.state;
  }

  save(): void {
    this.persist(this.state);
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, s] of Object.entries(this.state.authSessions)) {
      if (s.expiresAt < now) delete this.state.authSessions[token];
    }
  }

  isRateLimited(ip: string): boolean {
    const now = Date.now();
    const list = (this.failures.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    this.failures.set(ip, list);
    return list.length >= RATE_MAX_FAILS;
  }

  recordFailure(ip: string): void {
    const list = this.failures.get(ip) ?? [];
    list.push(Date.now());
    this.failures.set(ip, list);
  }

  createSession(): { token: string; maxAgeSec: number } {
    this.prune();
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.state.authSessions[token] = { createdAt: now, expiresAt: now + SESSION_TTL_MS };
    this.save();
    return { token, maxAgeSec: SESSION_TTL_MS / 1000 };
  }

  deleteSession(token: string | undefined): void {
    if (token && this.state.authSessions[token]) {
      delete this.state.authSessions[token];
      this.save();
    }
  }

  tokenFrom(req: IncomingMessage): string | undefined {
    return parseCookies(req.headers.cookie)[COOKIE_NAME];
  }

  isAuthed(req: IncomingMessage): boolean {
    const token = this.tokenFrom(req);
    if (!token) return false;
    const s = this.state.authSessions[token];
    return !!s && s.expiresAt > Date.now();
  }
}

export function sessionCookie(req: IncomingMessage, token: string, maxAgeSec: number): string {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
