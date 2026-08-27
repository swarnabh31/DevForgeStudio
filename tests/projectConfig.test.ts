import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadProjectConfig,
  saveProjectConfig,
  loadProjectInstructions
} from '../server/projectConfig';
import { detectVerifyCommands } from '../server/verify';
import { buildIgnoreMatcher, walkWorkspace } from '../server/fsTools';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-projcfg-'));
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('projectConfig load/save', () => {
  it('returns {} when no config file exists', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    expect(loadProjectConfig(ws)).toEqual({});
  });

  it('round-trips a saved config atomically', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const cfg = saveProjectConfig(ws, {
      instructions: 'Use strict TS.',
      writePolicy: 'review',
      verifyCommands: ['cargo check'],
      ignoreGlobs: ['dist/**']
    });
    expect(cfg.writePolicy).toBe('review');
    expect(loadProjectConfig(ws)).toEqual(cfg);
  });

  it('sanitizes invalid values on save and load', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const saved = saveProjectConfig(ws, {
      instructions: '   '.repeat(10) + 'x'.repeat(20000),
      writePolicy: 'nonsense' as any,
      verifyCommands: ['', 'ok cmd', 42 as any],
      ignoreGlobs: ['../escape', 'fine/**']
    });
    expect(saved.writePolicy).toBeUndefined();
    expect(saved.verifyCommands).toEqual(['ok cmd']);
    expect(saved.ignoreGlobs).toEqual(['fine/**']);
    expect(saved.instructions!.length).toBeLessThanOrEqual(8000);
    // corrupt JSON → {} not throw
    fs.writeFileSync(path.join(ws, '.devforge.json'), '{nope');
    expect(loadProjectConfig(ws)).toEqual({});
  });

  it('cache picks up external edits (mtime-based invalidation)', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    saveProjectConfig(ws, { writePolicy: 'ask' });
    expect(loadProjectConfig(ws).writePolicy).toBe('ask');
    saveProjectConfig(ws, { writePolicy: 'deny' });
    expect(loadProjectConfig(ws).writePolicy).toBe('deny');
  });
});

describe('loadProjectInstructions', () => {
  it('combines .devforge.json instructions and prefers AGENTS.md-style files', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    saveProjectConfig(ws, { instructions: 'From devforge.json' });
    expect(loadProjectInstructions(ws)).toContain('From devforge.json');

    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# Rules\nBe tidy.');
    const text = loadProjectInstructions(ws);
    expect(text).toContain('(from AGENTS.md)');
    expect(text).toContain('Be tidy.');
  });

  it('returns empty string with neither source', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    expect(loadProjectInstructions(ws)).toBe('');
  });
});

describe('verify + ignore glob integration', () => {
  it('custom verify commands run BEFORE detected ones', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } })
    );
    saveProjectConfig(ws, { verifyCommands: ['cargo check'] });
    const cmds = detectVerifyCommands(ws).map((c) => c.command);
    expect(cmds[0]).toBe('cargo check');
    expect(cmds).toContain('npm test');
  });

  it('ignoreGlobs hide files from workspace walks', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.mkdirSync(path.join(ws, 'dist'));
    fs.writeFileSync(path.join(ws, 'keep.txt'), 'a');
    fs.writeFileSync(path.join(ws, 'dist', 'skip.js'), 'b');
    saveProjectConfig(ws, { ignoreGlobs: ['dist/**'] });

    expect(buildIgnoreMatcher(ws).ignores('dist/skip.js')).toBe(true);

    const rels = walkWorkspace(ws).map((e) => e.relPath.replace(/\\/g, '/'));
    expect(rels).toContain('keep.txt');
    expect(rels).not.toContain('dist');
  });
});
