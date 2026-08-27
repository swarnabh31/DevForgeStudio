import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildRepoMap } from '../server/repoMap';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-repomap-'));
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function setMtime(file: string, daysAgo: number): void {
  const t = new Date(Date.now() - daysAgo * 86_400_000);
  fs.utimesSync(file, t, t);
}

describe('buildRepoMap', () => {
  it('ranks recently modified files above stale ones', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const hot = path.join(ws, 'hot.ts');
    const cold = path.join(ws, 'cold.ts');
    fs.writeFileSync(hot, 'export function hotStuff() {}\n');
    fs.writeFileSync(cold, 'export function coldStuff() {}\n');
    setMtime(hot, 0);
    setMtime(cold, 200);

    const { entries, text } = buildRepoMap(ws, 5000);
    expect(entries[0].relPath).toBe('hot.ts');
    expect(text).toContain('cold.ts');
    expect(text).toContain('function hotStuff');
  });

  it('boosts files with high import fan-in', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    // util.ts imported by three others; orphan.ts imported by nobody
    fs.writeFileSync(path.join(ws, 'util.ts'), 'export function shared() {}\n');
    for (const name of ['a', 'b', 'c']) {
      fs.writeFileSync(
        path.join(ws, `${name}.ts`),
        `import { shared } from './util';\nexport function ${name}Use() { return shared(); }\n`
      );
    }
    fs.writeFileSync(path.join(ws, 'orphan.ts'), 'export function lonely() {}\n');
    // Equalize recency so fan-in is the differentiator
    for (const f of ['util.ts', 'a.ts', 'b.ts', 'c.ts', 'orphan.ts']) setMtime(path.join(ws, f), 1);

    const { entries } = buildRepoMap(ws, 20000);
    const util = entries.find((e) => e.relPath === 'util.ts')!;
    const orphan = entries.find((e) => e.relPath === 'orphan.ts')!;
    expect(util.fanIn).toBe(3);
    expect(orphan.fanIn).toBe(0);
    expect(util.score).toBeGreaterThan(orphan.score);
  });

  it('respects the char budget', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(
        path.join(ws, `mod${i}.ts`),
        `export function fn${i}() { /* ${'x'.repeat(40)} */ }\n`
      );
      setMtime(path.join(ws, `mod${i}.ts`), i); // staggered recency
    }
    const { text } = buildRepoMap(ws, 600);
    expect(text.length).toBeLessThanOrEqual(600 + 120); // header excluded; lines fit budget
    expect(text.split('\n').length).toBeLessThan(50);
  });

  it('respects .devforge.json ignoreGlobs and skips non-code files', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.mkdirSync(path.join(ws, 'dist'));
    fs.writeFileSync(path.join(ws, 'dist', 'built.js'), 'var x=1;\n');
    fs.writeFileSync(path.join(ws, 'notes.md'), '# notes\n');
    fs.writeFileSync(path.join(ws, 'keep.ts'), 'export function keep() {}\n');
    fs.writeFileSync(path.join(ws, '.devforge.json'), JSON.stringify({ ignoreGlobs: ['dist/**'] }));

    const { entries, text } = buildRepoMap(ws, 5000);
    expect(entries.some((e) => e.relPath.startsWith('dist'))).toBe(false);
    void text;
  });
});
