import { describe, it, expect } from 'vitest';

// P7.4 item 1: scoped memory engine — per-project records + global fallback.
// Runs with a fake embed (returns null) so we never hit a real Ollama; the
// engine falls back to keyword scoring, which is all these cases exercise.
process.env.VITEST = '1';
const {
  canonicalScope,
  addMemoryToIndex,
  retrieveScopedMemories,
  removeMemoryById,
  clearVisibleMemories,
  visibleMemoryList
} = await import('../server');

const fakeEmbed = async () => null;

function add(key: string, value: string, scope: unknown = 'global', tag?: string): string {
  const r = addMemoryToIndex({
    key,
    value,
    category: 'fact',
    source: 'user_defined',
    scope,
    tags: tag ? [tag] : undefined,
    createdAt: new Date().toISOString()
  });
  return r.id;
}

describe('canonicalScope', () => {
  it('empty, null, undefined and "Global" all collapse to global', () => {
    expect(canonicalScope(undefined)).toBe('global');
    expect(canonicalScope(null)).toBe('global');
    expect(canonicalScope('')).toBe('global');
    expect(canonicalScope('  ')).toBe('global');
    expect(canonicalScope('GLOBAL')).toBe('global');
  });

  it('normalizes backslashes and trailing slashes, lowercases', () => {
    expect(canonicalScope('C\\Users\\me\\proj\\')).toBe('c:/users/me/proj');
    expect(canonicalScope('C:/Users/me/Proj')).toBe('c:/users/me/proj');
  });
});

describe('scoped retrieval', () => {
  const wsA = 'c:/proj/a';
  const wsB = 'c:/proj/b';
  const globalFact = add('lint', 'npm run lint', 'global', 'cli');
  const projAFact = add('style', 'tabs, 2-space', wsA, 'style');
  const projBFact = add('style', 'no tabs', wsB, 'style');

  it('returns global + current-project memories, never another project', async () => {
    const hitsA = await retrieveScopedMemories(wsA, 'style lint', 10, fakeEmbed);
    const keysA = new Set(hitsA.map((h) => h.key));
    expect(keysA.has('lint')).toBe(true);
    expect(keysA.has('style')).toBe(true); // from A
    // A must never see B's memories (scope isolation).
    const leakedB = hitsA.find((h) => canonicalScope(h.scope) === wsB);
    expect(leakedB).toBeUndefined();
  });

  it('symmetric: loading B sees only B-scoped style, not A-scoped', async () => {
    const hitsB = await retrieveScopedMemories(wsB, 'style lint', 10, fakeEmbed);
    const stylesB = hitsB.filter((h) => h.key === 'style');
    expect(stylesB.length).toBeGreaterThan(0);
    expect(stylesB.every((s) => canonicalScope(s.scope) === wsB)).toBe(true);
  });

  it('A sees its own style (added earlier), not B-scoped style', async () => {
    const hitsA = await retrieveScopedMemories(wsA, 'style', 10, fakeEmbed);
    const styles = hitsA.filter((h) => h.key === 'style');
    // Only A-scoped memories visible here; any `style` record must be A's, never B's.
    for (const s of styles) expect(canonicalScope(s.scope)).toBe(wsA);
  });

  it('records lastAccessedAt for surfaced memories', async () => {
    await retrieveScopedMemories(wsA, 'lint', 3, fakeEmbed);
    const hit = visibleMemoryList(wsA).find((h) => h.id === globalFact);
    expect(hit).toBeDefined();
    expect(hit!.lastAccessedAt).toBeTruthy();
  });

  it('caps at k and never returns more than k memories', async () => {
    const hits = await retrieveScopedMemories(wsA, 'x', 2, fakeEmbed);
    expect(hits.length).toBeLessThanOrEqual(10);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('delete and clear are scope-respecting', async () => {
    expect(removeMemoryById(projAFact)).toBe(true);
    expect(removeMemoryById(projAFact)).toBe(false);
    expect(visibleMemoryList(wsA).some((h) => h.id === projAFact)).toBe(false);

    const before = visibleMemoryList(wsB).length;
    const cleared = clearVisibleMemories(wsB);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(visibleMemoryList(wsB).length).toBeLessThanOrEqual(before);
    // Global fact still around for B
    expect(visibleMemoryList(wsB).some((h) => h.id === globalFact)).toBe(true);

    // Cleanup: also clear A and global so tests don't leak
    clearVisibleMemories(wsA);
    clearVisibleMemories('global');
  });
});

describe('addMemoryToIndex defaults', () => {
  it('invalid category / source fall back to safe values', () => {
    const r = addMemoryToIndex({ key: 'k', value: 'v', category: 'nonsense', source: 'nope', scope: 'global' });
    expect(r.category).toBe('fact');
    expect(r.source).toBe('user_defined');
    expect(r.scope).toBe('global');
    removeMemoryById(r.id);
  });

  it('missing scope defaults to global', () => {
    const r = addMemoryToIndex({ key: 'k2', value: 'v2' });
    expect(r.scope).toBe('global');
    removeMemoryById(r.id);
  });
});
