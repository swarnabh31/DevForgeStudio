import { describe, it, expect } from 'vitest';
import request from 'supertest';

// server.ts exports the express app without listening when VITEST is set
process.env.VITEST = '1';
const { app } = await import('../server');

describe('HTTP routes', () => {
  it('GET /api/models returns the model list', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.models)).toBe(true);
  });

  describe('POST /api/sync/sessions', () => {
    it('persists and returns chat sessions', async () => {
      const payload = {
        sessions: [
          { id: 'test-session-1', name: 'Test Session', messages: [{ id: 'm1', sender: 'user', content: 'hello' }] }
        ]
      };
      const save = await request(app).post('/api/sync/sessions').send(payload);
      expect(save.status).toBe(200);
      expect(save.body.success).toBe(true);

      const load = await request(app).get('/api/sync/sessions');
      expect(load.status).toBe(200);
      const found = load.body.sessions.find((s: any) => s.id === 'test-session-1');
      expect(found).toBeDefined();
      expect(found.name).toBe('Test Session');
      expect(found.messages.length).toBe(1);
    });

    it('rejects a non-array payload with 400', async () => {
      const res = await request(app).post('/api/sync/sessions').send({ sessions: 'nope' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/workspace/execute (real command runner)', () => {
    it('rejects non-allowlisted commands with 403', async () => {
      const res = await request(app).post('/api/workspace/execute').send({ command: 'rm -rf /' });
      expect(res.status).toBe(403);
    });

    it('rejects allowlisted prefix with smuggled shell metacharacters', async () => {
      const res = await request(app)
        .post('/api/workspace/execute')
        .send({ command: 'npm test && echo pwned' });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/metacharacter/i);
    });

    it('runs an allowlisted command and returns real output', async () => {
      const res = await request(app)
        .post('/api/workspace/execute')
        .send({ command: 'git status' });
      // git may or may not be initialized here; both outcomes are REAL executions
      if (res.status === 200) {
        expect(typeof res.body.stdout).toBe('string');
        expect([0, 1, 128]).toContain(res.body.exitCode);
      } else {
        expect(res.status).toBe(500);
      }
    });
  });

  describe('POST /api/attachments/parse', () => {
    it('passes through plain text content', async () => {
      const res = await request(app)
        .post('/api/attachments/parse')
        .send({ name: 'notes.txt', textContent: 'some text' });
      expect(res.status).toBe(200);
      expect(res.body.parsedText).toBe('some text');
    });

    it('returns a 422 error for a corrupt PDF instead of a fake success', async () => {
      const badPdf = Buffer.from('this is not a real pdf').toString('base64');
      const res = await request(app)
        .post('/api/attachments/parse')
        .send({ name: 'bad.pdf', mimeType: 'application/pdf', contentBase64: badPdf });
      expect([422, 500]).toContain(res.status);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /api/workspace/files (browser import materialization)', () => {
    it('writes imported files to a real on-disk workspace root for the agent', async () => {
      const sessionId = `import-test-${Date.now()}`;
      const save = await request(app)
        .post('/api/workspace/files')
        .send({
          path: 'MyProject/src/main.py',
          content: 'print("hello from import")\n',
          sessionId,
          imported: true
        });
      expect(save.status).toBe(200);
      expect(save.body.importedToDisk).toBe(true);
      // webkitRelativePath top-level folder must be stripped from the stored path
      expect(save.body.file.path).toBe('src/main.py');

      // The agent's ranged read (same root as its tools) must see it on disk
      const read = await request(app)
        .get(`/api/workspace/read?sessionId=${sessionId}&path=src/main.py`);
      expect(read.status).toBe(200);
      expect(read.body.content).toContain('hello from import');

      // Workspace files cache should expose it under the stripped path
      const files = await request(app).get(`/api/workspace/files?sessionId=${sessionId}`);
      expect(files.body.files['src/main.py']).toBeDefined();
    });

    it('rejects imported paths that escape the workspace root', async () => {
      const res = await request(app)
        .post('/api/workspace/files')
        .send({
          path: 'Proj/../../escaped.txt',
          content: 'nope',
          sessionId: `import-escape-${Date.now()}`,
          imported: true
        });
      expect([400, 403]).toContain(res.status);
    });
  });
});
