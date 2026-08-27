import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { findModelPreset, MODEL_PRESETS } from '../server/modelMatrix';

describe('findModelPreset', () => {
  it('matches families across tag formats', () => {
    expect(findModelPreset('qwen2.5-coder:14b-instruct-q4_K_M')?.family).toBe('qwen2.5-coder');
    expect(findModelPreset('QWEN3-CODER:30B')?.family).toBe('qwen3');
    expect(findModelPreset('deepseek-coder-v2:16b')?.family).toBe('deepseek-coder-v2');
    expect(findModelPreset('llama3.1:8b')?.family).toBe('llama3');
    expect(findModelPreset('codellama:13b')?.family).toBe('codellama');
    expect(findModelPreset('devstral-latest')?.family).toBe('mistral');
    expect(findModelPreset('deepseek-r1-distill-7b')?.family).toBe('deepseek-r1');
  });

  it('returns null for unknown or empty ids', () => {
    expect(findModelPreset('totally-unknown-model')).toBeNull();
    expect(findModelPreset('')).toBeNull();
    expect(findModelPreset(undefined)).toBeNull();
    expect(findModelPreset(null)).toBeNull();
  });

  it('every preset is well-formed and uniquely matched by its first match key', () => {
    for (const p of MODEL_PRESETS) {
      expect(p.match.length).toBeGreaterThan(0);
      expect(p.notes.length).toBeGreaterThan(10);
      if (p.maxCtxTokens) expect(p.maxCtxTokens).toBeGreaterThanOrEqual(16384);
      const hit = findModelPreset(p.match[0]);
      expect(hit?.family).toBe(p.family);
    }
  });
});

describe('GET /api/models/matrix', () => {
  it('returns the presets list', async () => {
    const { app } = await import('../server');
    const res = await request(app).get('/api/models/matrix');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.presets.length).toBeGreaterThanOrEqual(5);
    expect(res.body.presets[0]).toHaveProperty('family');
    expect(res.body.presets[0]).toHaveProperty('notes');
  });
});

describe('catalog integration', () => {
  it('onboarding catalog entries carry family notes when known', async () => {
    const { app } = await import('../server');
    const res = await request(app).get('/api/onboarding/catalog');
    expect(res.status).toBe(200);
    const withNotes = res.body.catalog.filter((m: any) => m.notes);
    expect(withNotes.length).toBeGreaterThan(0);
    for (const m of withNotes) expect(typeof m.family).toBe('string');
  });
});
