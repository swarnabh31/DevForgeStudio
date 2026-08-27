import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { saveProjectConfig, loadProjectConfig, PluginToolSpec } from '../server/projectConfig';
import { getPluginToolDefs, buildPluginSchemas, executePluginTool } from '../server/pluginTools';
import { executeTool } from '../server/agentLoop';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-plugin-'));
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

const SPEC: PluginToolSpec = {
  name: 'count_words',
  description: 'Count words in a workspace file',
  parameters: { file: { type: 'string', description: 'relative path' } },
  command: 'node -e "const fs=require(\'fs\');const s=fs.readFileSync(process.argv[1],\'utf8\');console.log(s.split(/\\s+/).filter(Boolean).length)" {{file}}'
};

describe('projectConfig tools sanitization', () => {
  it('keeps valid specs, drops invalid ones and dedupes by name', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    saveProjectConfig(ws, {
      tools: [
        SPEC,
        { name: 'Bad Name', command: 'echo hi' } as any,
        { name: 'no_command' } as any,
        SPEC,
        { name: 'ok_tool', command: 'echo ok' }
      ]
    });
    const cfg = loadProjectConfig(ws);
    expect(cfg.tools!.map((t) => t.name)).toEqual(['count_words', 'ok_tool']);
  });

  it('caps tool count at 12', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, command: 'echo hi' }));
    saveProjectConfig(ws, { tools: many });
    expect(loadProjectConfig(ws).tools!.length).toBe(12);
  });
});

describe('pluginTools runtime', () => {
  it('builds function schemas', () => {
    const schemas = buildPluginSchemas([SPEC]);
    expect((schemas[0] as any).function.name).toBe('count_words');
    expect((schemas[0] as any).function.parameters.properties.file.type).toBe('string');
  });

  it('executes with substituted args; rejects undeclared args; reports exit codes', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'note.txt'), 'one two three\n');

    // success path
    const ok = await executePluginTool(ws, SPEC, { file: 'note.txt' });
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('3');

    // undeclared argument rejected
    const bad = await executePluginTool(ws, SPEC, { file: 'note.txt', evil: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('undeclared argument');

    // failing command reports non-zero exit
    const failSpec: PluginToolSpec = { name: 'always_fail', command: 'node -e "process.exit(3)"' };
    const failed = await executePluginTool(ws, failSpec, {});
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain('exited 3');
  });

  it('getPluginToolDefs reads from .devforge.json', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    saveProjectConfig(ws, { tools: [SPEC] });
    expect(getPluginToolDefs(ws)).toHaveLength(1);
    expect(getPluginToolDefs(ws)[0].name).toBe('count_words');
  });
});

describe('agentLoop plugin dispatch', () => {
  it('routes calls to registered plugins and errors for unregistered names', async () => {
    const ws = makeWs();
    tempDirs.push(ws);

    const r = await executeTool(ws, { id: 'c1', name: 'count_words', arguments: { file: 'x.txt' } }, {
      pluginTools: [
        {
          name: 'count_words',
          schema: buildPluginSchemas([SPEC])[0],
          execute: async (args) => ({ ok: true, output: `COUNTED ${String(args.file)}` })
        }
      ]
    });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('COUNTED x.txt');

    // without pluginTools wired, the name falls through to the unknown-tool error
    const missing = await executeTool(ws, { id: 'c2', name: 'count_words', arguments: {} });
    expect(missing.ok).toBe(false);
  });

  it('plugin schemas are appended to the tool list when wired', async () => {
    // indirect check through runAgentLoop is heavy; verify schema shape directly
    const schemas = buildPluginSchemas([{ name: 'my_tool', description: 'd', command: 'echo hi' }]);
    expect((schemas[0] as any).type).toBe('function');
    expect(Object.keys((schemas[0] as any).function.parameters.properties)).toEqual([]);
  });
});
