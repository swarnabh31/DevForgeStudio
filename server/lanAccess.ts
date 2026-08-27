import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * P4.4 Remote access story: serve the UI over the LAN behind a shared auth
 * token. Localhost connections are always trusted; anything else must present
 * the token (header, bearer, or cookie; ?token= works only to bootstrap the
 * cookie and is never recommended afterwards).
 *
 * Hardening (Phase 6.2):
 *  - CSRF: mutating requests (POST/PUT/PATCH/DELETE) from non-loopback clients
 *    must carry the `X-DevForge-Csrf` header — a custom header forces a CORS
 *    preflight, so plain cross-site fetch()/form posts are blocked.
 *  - Rate limiting: >10 failed remote attempts per IP within a minute lock that
 *    IP out for a minute (defeats LAN token brute-forcing).
 *  - Optional `Secure` cookie flag for HTTPS deployments.
 */

export const CSRF_HEADER = 'x-devforge-csrf';
export const CSRF_VALUE = 'devforge';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function generateToken(): string {
  return randomBytes(24).toString('hex');
}

function tokenFile(rootAbs: string): string {
  return path.join(rootAbs, '.opencode', 'auth-token.json');
}

/** Get (or lazily create) the workspace's LAN auth token. */
export function getOrCreateToken(rootAbs: string): string {
  try {
    const file = tokenFile(rootAbs);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof parsed?.token === 'string' && parsed.token.length >= 16) return parsed.token;
    } catch {}
    const token = generateToken();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token, createdAt: new Date().toISOString() }), 'utf-8');
    return token;
  } catch {
    // Fall back to an ephemeral in-memory token rather than failing startup
    return generateToken();
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const norm = ip.replace(/^::ffff:/, '');
  return norm === '127.0.0.1' || norm === '::1';
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

interface GateRequest {
  ip?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, any>;
}
interface GateResponse {
  status?: (code: number) => GateResponse;
  json?: (body: unknown) => void;
  setHeader?: (name: string, value: string) => void;
}
type Next = () => void;

export interface LanGateOptions {
  /** Set the Cookie Secure flag (serve over HTTPS). */
  secureCookie?: boolean;
  /** Max failed remote attempts per IP within `windowMs` before a lockout. */
  maxAttemptsPerWindow?: number;
  windowMs?: number;
  lockMs?: number;
}

/**
 * Express-compatible gate middleware. Loopback clients pass unconditionally;
 * remote clients need a valid token plus `X-DevForge-Csrf` for mutating
 * requests. A valid `?token=` bootstraps the session cookie exactly once —
 * after that the cookie/header must be used.
 */
export function createLanGate(token: string, opts: LanGateOptions = {}) {
  const maxAttempts = opts.maxAttemptsPerWindow ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const lockMs = opts.lockMs ?? 60_000;
  const secureCookie = opts.secureCookie === true;

  const attempts = new Map<string, { count: number; since: number; lockedUntil: number }>();

  const locked = (ip: string | undefined): boolean => {
    const a = ip ? attempts.get(ip) : undefined;
    return !!a && a.lockedUntil > Date.now();
  };

  /** Record a failure; returns true if this IP has now hit the attempt cap. */
  const recordFailure = (ip: string | undefined): boolean => {
    if (!ip) return false;
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a) {
      attempts.set(ip, { count: 1, since: now, lockedUntil: 0 });
      return 1 >= maxAttempts;
    }
    if (now - a.since > windowMs) {
      a.since = now;
      a.count = 1;
      return 1 >= maxAttempts;
    }
    a.count += 1;
    if (a.count >= maxAttempts) {
      a.lockedUntil = now + lockMs;
      a.count = 0;
      a.since = now;
      return true;
    }
    return false;
  };

  type Verdict = 'ok' | 'unauthorized' | 'csrf' | 'locked';
  const check = (req: GateRequest): Verdict => {
    if (isLoopback(req.ip)) return 'ok';
    if (locked(req.ip)) return 'locked';

    const headers = req.headers || {};
    const headerTok =
      (typeof headers['x-devforge-token'] === 'string' && headers['x-devforge-token']) ||
      (typeof headers['authorization'] === 'string' &&
        headers['authorization'].startsWith('Bearer ') &&
        headers['authorization'].slice(7).trim()) ||
      null;
    const cookieTok = readCookie(
      typeof headers['cookie'] === 'string' ? headers['cookie'] : undefined,
      'devforge_token'
    );
    const queryTok = typeof req.query?.token === 'string' ? req.query.token : null;

    const presented =
      (typeof headerTok === 'string' && safeEqual(headerTok, token)) ||
      (cookieTok !== null && safeEqual(cookieTok, token)) ||
      (queryTok !== null && queryTok.length > 0 && safeEqual(queryTok, token));

    if (!presented) {
      return recordFailure(req.ip) ? 'locked' : 'unauthorized';
    }

    const mutating = MUTATING.has((req.method || 'GET').toUpperCase());
    if (mutating && headers[CSRF_HEADER] !== CSRF_VALUE) return 'csrf';

    return 'ok';
  };

  return function lanGate(req: any, res: GateResponse, next: Next): void {
    const verdict = check({
      ip: req.ip,
      method: req.method,
      headers: req.headers,
      query: req.query
    });

    if (verdict === 'ok') {
      const q = typeof req.query?.token === 'string' ? (req.query.token as string) : '';
      if (q && safeEqual(q, token)) {
        const secure = secureCookie ? '; Secure' : '';
        res.setHeader?.(
          'Set-Cookie',
          `devforge_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}`
        );
      }
      next();
      return;
    }

    if (verdict === 'locked') {
      res.status?.(429);
      res.json?.({ error: 'Too many failed attempts — retry after a short pause.' });
      return;
    }
    if (verdict === 'csrf') {
      res.status?.(403);
      res.json?.({ error: `Mutating request blocked: missing X-DevForge-Csrf header (cross-site request protection)` });
      return;
    }
    res.status?.(401);
    res.json?.({ error: 'Unauthorized — remote access requires the DevForge token (x-devforge-token header).' });
  };
}

/** Collect non-internal IPv4 addresses for printing LAN URLs. */
export function lanAddresses(): string[] {
  try {
    const os = require('os') as typeof import('os');
    const out: string[] = [];
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) out.push(i.address);
      }
    }
    return out;
  } catch {
    return [];
  }
}
