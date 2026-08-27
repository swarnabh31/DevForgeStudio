import { describe, it, expect } from 'vitest';
import request from 'supertest';

describe('P5.4 docs endpoints', () => {
  it('GET /api/docs lists the markdown docs', async () => {
    const { app } = await import('../server');
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const names = res.body.docs.map((d: any) => d.name);
    for (const expected of ['architecture', 'contributing', 'why-local', 'project-config']) {
      expect(names).toContain(expected);
    }
  });

  it('GET /api/docs/:name returns markdown content', async () => {
    const { app } = await import('../server');
    const res = await request(app).get('/api/docs/why-local');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.content).toContain('Why Local');
    expect(res.body.content).toContain('#');
  });

  it('rejects path escapes and unknown docs', async () => {
    const { app } = await import('../server');
    const escape = await request(app).get('/api/docs/..%2Fserver');
    expect([400, 404]).toContain(escape.status);

    // a crafted SAFE-looking-but-wrong name 404s
    const missing = await request(app).get('/api/docs/nonexistent-doc');
    expect(missing.status).toBe(404);

    // names with slashes/dots are rejected outright by the pattern guard
    const bad = await request(app).get('/api/docs/foo.bar%2Fbaz');
    expect(bad.status).toBe(400);
  });
});
