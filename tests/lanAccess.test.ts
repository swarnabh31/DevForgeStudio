import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createLanGate, generateToken } from '../server/lanAccess';

const TOKEN = 'test-token-abcdef0123456789';

function makeApp(): express.Express {
  const app = express();
  app.use(createLanGate(TOKEN));
  app.get('/hello', (_req, res) => res.json({ ok: true }));
  return app;
}

function remote(app: express.Express): request.Test {
  // supertest connects over loopback; spoof a LAN address via X-Forwarded-For
  // is not honored without trust proxy — so we simulate by clearing ip instead.
  return request(app).get('/hello').set('X-Forwarded-For', '192.168.1.50');
}

describe('createLanGate', () => {
  it('allows loopback clients without a token', async () => {
    const res = await request(makeApp()).get('/hello');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('token checks (ip-agnostic unit path)', () => {
  function checkWith(ip: string | undefined, headers: Record<string, string>, query?: Record<string, any>): { called: boolean; status?: number; cookie?: string } {
    let called = false;
    let status: number | undefined;
    let cookie: string | undefined;
    const gate = createLanGate(TOKEN);
    gate(
      { ip, headers, query },
      {
        status(code: number) { status = code; return this; },
        json() {},
        setHeader(_n: string, v: string) { cookie = v; }
      },
      () => { called = true; }
    );
    return { called, status, cookie };
  }

  it('rejects remote without token', () => {
    const r = checkWith('10.0.0.8', {}, {});
    expect(r.called).toBe(false);
    expect(r.status).toBe(401);
  });

  it('accepts x-devforge-token header', () => {
    expect(checkWith('10.0.0.8', { 'x-devforge-token': TOKEN }).called).toBe(true);
  });

  it('accepts bearer authorization', () => {
    expect(checkWith('10.0.0.8', { authorization: `Bearer ${TOKEN}` }).called).toBe(true);
  });

  it('accepts valid ?token= and sets the session cookie', () => {
    const r = checkWith('10.0.0.8', {}, { token: TOKEN });
    expect(r.called).toBe(true);
    expect(r.cookie).toContain('devforge_token=');
  });

  it('rejects wrong token and garbage', () => {
    expect(checkWith('10.0.0.8', { 'x-devforge-token': 'wrong' }).called).toBe(false);
    expect(checkWith(undefined, {}, { token: '' }).called).toBe(false);
  });

  it('loopback always passes', () => {
    expect(checkWith('127.0.0.1', {}).called).toBe(true);
    expect(checkWith('::ffff:127.0.0.1', {}).called).toBe(true);
  });

  it('generateToken produces long random hex', () => {
    const t = generateToken();
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(/^[a-f0-9]+$/.test(t)).toBe(true);
    expect(t).not.toBe(generateToken());
  });
});

describe('CSRF + rate limiting (Phase 6.2 hardening)', () => {
  function gateCheck(
    ip: string,
    headers: Record<string, string>,
    method = 'GET',
    query: Record<string, any> = {}
  ): { called: boolean; status?: number; body?: string } {
    let called = false;
    let status: number | undefined;
    let body: string | undefined;
    const gate = createLanGate(TOKEN);
    gate(
      { ip, headers, method, query },
      {
        status(code: number) { status = code; return this; },
        json(b: unknown) { body = JSON.stringify(b); },
        setHeader() {}
      },
      () => { called = true; }
    );
    return { called, status, body };
  }

  it('allows GET without CSRF header (browser navigation)', () => {
    expect(gateCheck('10.0.0.9', { 'x-devforge-token': TOKEN }, 'GET').called).toBe(true);
  });

  it('blocks POST without the CSRF header even with a valid token', () => {
    const r = gateCheck('10.0.0.9', { 'x-devforge-token': TOKEN }, 'POST');
    expect(r.called).toBe(false);
    expect(r.status).toBe(403);
  });

  it('allows POST with a valid token + CSRF header', () => {
    const r = gateCheck('10.0.0.9', { 'x-devforge-token': TOKEN, 'x-devforge-csrf': 'devforge' }, 'POST');
    expect(r.called).toBe(true);
  });

  it('blocks DELETE without CSRF header', () => {
    const r = gateCheck('10.0.0.9', { 'x-devforge-token': TOKEN }, 'DELETE');
    expect(r.called).toBe(false);
    expect(r.status).toBe(403);
  });

  it('exposes CSRF constants for the frontend', async () => {
    const m = await import('../server/lanAccess');
    expect(m.CSRF_HEADER).toBe('x-devforge-csrf');
    expect(m.CSRF_VALUE).toBe('devforge');
  });
});

describe('lockout on repeated failed attempts', () => {
  it('locks an IP after more than the allowed failures within the window', () => {
    const gate = createLanGate(TOKEN, { maxAttemptsPerWindow: 3, windowMs: 60_000, lockMs: 60_000 });
    const tryOne = (): number | undefined => {
      let status: number | undefined;
      let called = false;
      gate(
        { ip: '10.1.2.3', headers: { 'x-devforge-csrf': 'devforge' }, method: 'POST', query: {} },
        { status(c: number) { status = c; return this; }, json() {}, setHeader() {} },
        () => { called = true; }
      );
      return status;
    };
    for (let i = 0; i < 2; i++) expect(tryOne()).toBe(401);
    // the failure that reaches the cap is what trips the lock
    expect(tryOne()).toBe(429);
    // even a correct token is locked out now
    const withGoodToken = (() => {
      let status: number | undefined;
      let called = false;
      gate(
        { ip: '10.1.2.3', headers: { 'x-devforge-token': TOKEN, 'x-devforge-csrf': 'devforge' }, method: 'POST', query: {} },
        { status(c: number) { status = c; return this; }, json() {}, setHeader() {} },
        () => { called = true; }
      );
      return { called, status };
    })();
    expect(withGoodToken.called).toBe(false);
    expect(withGoodToken.status).toBe(429);
  });
});

