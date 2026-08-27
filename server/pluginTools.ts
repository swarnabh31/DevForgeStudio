import { exec } from 'child_process';
import { loadProjectConfig, PluginToolSpec } from './projectConfig';

/**
 * P5.3 Plugin/tool API — user-defined tools declared in `.devforge.json`.
 *
 * A plugin tool is a shell command run in the workspace root with `{{arg}}`
 * placeholders filled from the model's (validated) arguments. Example:
 *
 * {
 *   "tools": [{
 *     "name": "npm_audit",
 *     "description": "Run npm audit and return the report",
 *     "command": "npm audit --json"
 *   },
 *   {
 *     "name": "grep_todos",
 *     "description": "Find TODO markers in a file",
 *     "parameters": { "file": { "type": "string", "description": "relative path" } },
 *     "command": "findstr /n \"TODO\" {{file}}"
 *   }]
 * }
 */

export interface PluginTool extends PluginToolSpec {}

const EXEC_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_TOOLS = 12;

/** Load plugin tool definitions from the workspace's project config. */
export function getPluginToolDefs(rootAbs: string): PluginTool[] {
  const cfg = loadProjectConfig(rootAbs);
  return (cfg.tools || []).slice(0, MAX_TOOLS);
}

/** Build OpenAI/Ollama-style function schemas for the given defs. */
export function buildPluginSchemas(defs: PluginTool[]): Array<Record<string, unknown>> {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description || `User-defined tool "${d.name}"`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(d.parameters || {}).map(([k, v]) => [
            k,
            { type: v.type || 'string', ...(v.description ? { description: v.description } : {}) }
          ])
        )
      }
    }
  }));
}

/**
 * Execute a plugin tool. Only DECLARED parameters are substituted; each value
 * is JSON-encoded before substitution so a malicious argument cannot break out
 * of its quoted/positional slot into new shell syntax beyond what the command
 * author already controls (they own this machine and config).
 */
export function executePluginTool(
  rootAbs: string,
  def: PluginTool,
  args: Record<string, unknown>
): Promise<{ ok: boolean; output: string }> {
  let command = def.command;

  // Reject undeclared args outright
  const declared = new Set(Object.keys(def.parameters || {}));
  for (const key of Object.keys(args || {})) {
    if (!declared.has(key)) {
      return Promise.resolve({ ok: false, output: `ERROR: undeclared argument "${key}" (declared: ${[...declared].join(', ') || 'none'})` });
    }
  }

  // Substitute declared tokens with JSON-encoded values
  for (const [key, value] of Object.entries(args || {})) {
    const token = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    command = command.replace(token, JSON.stringify(value));
  }
  // Whole-args JSON token
  command = command.replace(/\{\{\s*__json\s*\}\}/g, JSON.stringify(args));

  return new Promise((resolve) => {
    exec(
      command,
      { cwd: rootAbs, timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        let output = [stdout?.toString(), stderr?.toString()].filter(Boolean).join('\n').trim();
        if (output.length > MAX_OUTPUT_CHARS) {
          output = '…[head truncated]\n' + output.slice(output.length - MAX_OUTPUT_CHARS);
        }
        const code = (err as any)?.code;
        const exitCode = typeof code === 'number' ? code : err ? 1 : 0;
        resolve({
          ok: exitCode === 0,
          output: `${output || '(no output)'}\n[plugin tool "${def.name}" exited ${exitCode}]`
        });
      }
    );
  });
}
