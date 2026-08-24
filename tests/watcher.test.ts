import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { watchWorkspace, unwatchWorkspace } from '../server/watcher';

const tempRoots: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-watch-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe('watchWorkspace (real fs.watch integration)', () => {
  it('fires onChange when a watched file is externally modified', async () => {
    const root = makeTempWorkspace();
    const file = path.join(root, 'app.ts');
    fs.writeFileSync(file, 'export const a = 1;\n');

    const events: Array<{ absPath: string; event: string }> = [];
    watchWorkspace(root, (absPath, event) => events.push({ absPath, event }));

    // External edit
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(file, 'export const a = 2;\n');

    const deadline = Date.now() + 5000;
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    unwatchWorkspace(root);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].absPath.toLowerCase()).toBe(file.toLowerCase());
    expect(events[0].event).toBe('change');
  }, 15000);

  it('does NOT fire for ignored directories like node_modules', async () => {
    const root = makeTempWorkspace();
    const nm = path.join(root, 'node_modules', 'some-pkg');
    fs.mkdirSync(nm, { recursive: true });
    const file = path.join(nm, 'index.js');
    fs.writeFileSync(file, 'module.exports = 1;\n');

    let fired = false;
    watchWorkspace(root, () => {
      fired = true;
    });

    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(file, 'module.exports = 2;\n');

    // Give the debounce window plenty of time to prove nothing fires
    await new Promise((r) => setTimeout(r, 1200));
    unwatchWorkspace(root);

    expect(fired).toBe(false);
  }, 15000);

  it('unwatchWorkspace stops event delivery', async () => {
    const root = makeTempWorkspace();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'one\n');

    let fired = false;
    watchWorkspace(root, () => {
      fired = true;
    });
    unwatchWorkspace(root);

    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(file, 'two\n');
    await new Promise((r) => setTimeout(r, 1000));

    expect(fired).toBe(false);
  }, 15000);
});
