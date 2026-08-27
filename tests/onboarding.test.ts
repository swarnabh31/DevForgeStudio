import { describe, it, expect } from 'vitest';
import request from 'supertest';

describe('P4.1 onboarding endpoints', () => {
  it('GET /api/onboarding/catalog returns profile, catalog, and a recommendation', async () => {
    const { app } = await import('../server');
    const res = await request(app).get('/api/onboarding/catalog');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.catalog)).toBe(true);
    expect(res.body.catalog.length).toBeGreaterThanOrEqual(4);
    for (const m of res.body.catalog) {
      expect(m).toHaveProperty('id');
      expect(m).toHaveProperty('minVramMB');
      expect(typeof m.fitsHardware).toBe('boolean');
    }
    // recommendation must exist in the catalog
    expect(res.body.catalog.some((m: any) => m.id === res.body.recommendedId)).toBe(true);
  });

  it('POST /api/onboarding/pull rejects missing/invalid model names', async () => {
    const { app } = await import('../server');
    const none = await request(app).post('/api/onboarding/pull').send({});
    expect(none.status).toBe(400);
    const bad = await request(app).post('/api/onboarding/pull').send({ model: 'x; rm -rf' });
    expect(bad.status).toBe(400);
  });

  it('POST /api/onboarding/pull proxies an unreachable Ollama as 502', async () => {
    const { app } = await import('../server');
    // Port 9 on localhost is effectively always closed
    const res = await request(app)
      .post('/api/onboarding/pull')
      .send({ model: 'qwen2.5-coder:3b', endpoint: 'http://127.0.0.1:1' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('unreachable');
  });
});
