import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EvalTask, CheckResult, toolCall, text, containsCk } from './tasks';

/**
 * P5.1: SWE-bench-lite-style suite.
 *
 * Inspired by SWE-bench's fail→fix→verify loop, distilled into self-contained
 * mini repos that run locally with zero network access. Each task sets up a
 * project whose test runner FAILS before the fix; the agent must diagnose the
 * failure from the test output and patch the source so `node tests/run.js`
 * exits 0. Verification executes the repo's real test runner — no string
 * matching shortcuts.
 */

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Execute the mini-repo's test runner; pass = exit 0. */
const testsPassCk = (root: string): CheckResult => {
  let ok = false;
  let detail: string | undefined;
  try {
    execSync('node tests/run.js', { cwd: root, stdio: 'pipe', windowsHide: true });
    ok = true;
  } catch (e: any) {
    detail = String(e?.stderr || e?.message || e).slice(-400);
  }
  return { name: 'repo test runner passes (exit 0)', ok, detail };
};

export const SWE_TASKS: EvalTask[] = [
  // --- inspired by django/utils/dateparse: regex accepts out-of-range values
  {
    id: 'swe-dateparse-range',
    name: 'date parser accepts month 13',
    category: 'swe',
    description:
      'parseMonth() validates via regex only, so month 13 slips through. Tests expect a thrown RangeError.',
    setup: (root) => {
      write(
        root,
        'src/dateparse.js',
        '// Parses "YYYY-MM" strings.\n' +
          'const RE = /^(\\d{4})-(\\d{2})$/;\n' +
          'function parseMonth(s) {\n' +
          '  const m = RE.exec(s);\n' +
          '  if (!m) throw new TypeError("invalid format");\n' +
          '  const year = Number(m[1]);\n' +
          '  const month = Number(m[2]);\n' +
          '  return { year, month };\n' +
          '}\n' +
          'module.exports = { parseMonth };\n'
      );
      write(
        root,
        'tests/dateparse.test.js',
        'const assert = require("node:assert");\n' +
          'const { parseMonth } = require("../src/dateparse");\n' +
          'assert.deepEqual(parseMonth("2024-07"), { year: 2024, month: 7 });\n' +
          'assert.throws(() => parseMonth("2024-13"), RangeError);\n' +
          'assert.throws(() => parseMonth("2024-00"), RangeError);\n'
      );
      write(
        root,
        'tests/run.js',
        'const fs = require("fs"), path = require("path");\n' +
          'let failed = 0;\n' +
          'for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js"))) {\n' +
          '  try { require(path.join(__dirname, f)); console.log(f + " ok"); }\n' +
          '  catch (e) { failed++; console.error(f + " FAILED:", e.message); }\n' +
          '}\n' +
          'process.exit(failed ? 1 : 0);\n'
      );
    },
    passes: [
      {
        prompt:
          '`npm test` (node tests/run.js) fails because parseMonth accepts month 13 and month 00 instead of throwing a RangeError. Fix src/dateparse.js so the range is validated after parsing.',
        script: [
          toolCall('read_file', { path: 'src/dateparse.js' }),
          toolCall('apply_patch', {
            path: 'src/dateparse.js',
            oldText: '  const month = Number(m[2]);\n  return { year, month };',
            newText:
              '  const month = Number(m[2]);\n' +
              '  if (month < 1 || month > 12) throw new RangeError("month out of range");\n' +
              '  return { year, month };'
          }),
          text('Added an explicit range check: months outside 1..12 now throw RangeError.')
        ]
      }
    ],
    verify: (root) => [testsPassCk(root), containsCk(root, 'src/dateparse.js', 'RangeError')]
  },

  // --- inspired by requests cookie-parsing: split() loses empty components
  {
    id: 'swe-cookie-split',
    name: 'cookie parser drops empty pairs',
    category: 'swe',
    description: 'split(";") without trim handling corrupts cookies containing "=" in values and trailing semicolons.',
    setup: (root) => {
      write(
        root,
        'src/cookies.js',
        'function parseCookieHeader(header) {\n' +
          '  const out = {};\n' +
          '  for (const part of header.split(";")) {\n' +
          '    if (!part) continue;\n' +
          '    const idx = part.indexOf("=");\n' +
          '    const name = idx === -1 ? part : part.slice(0, idx);\n' +
          '    const value = idx === -1 ? "" : part.slice(idx + 1);\n' +
          '    out[name.trim()] = value;\n' +
          '  }\n' +
          '  return out;\n' +
          '}\n' +
          'module.exports = { parseCookieHeader };\n'
      );
      write(
        root,
        'tests/cookies.test.js',
        'const assert = require("node:assert");\n' +
          'const { parseCookieHeader } = require("../src/cookies");\n' +
          '// Values may legitimately contain "=" (e.g. base64)\n' +
          'assert.deepEqual(parseCookieHeader("token=abc=def; session=x"), { token: "abc=def", session: "x" });\n' +
          '// Whitespace around names AND values must be trimmed\n' +
          'assert.deepEqual(parseCookieHeader("a = 1"), { a: "1" });\n' +
          '// Empty value is preserved as empty string\n' +
          'assert.deepEqual(parseCookieHeader("flag="), { flag: "" });\n'
      );
      write(root, 'tests/run.js', TEST_RUNNER);
    },
    passes: [
      {
        prompt:
          'The cookie header parser fails its tests: it must keep values containing "=", trim whitespace around names, and preserve empty values. Fix src/cookies.js until node tests/run.js passes.',
        script: [
          toolCall('read_file', { path: 'src/cookies.js' }),
          toolCall('apply_patch', {
            path: 'src/cookies.js',
            oldText: '    out[name.trim()] = value;',
            newText:
              '    // Trim whitespace around both the name and the value\n' +
              '    out[name.trim()] = value.trim();'
          }),
          text('Fixed by trimming both the name and the value.')
        ]
      }
    ],
    verify: (root) => [testsPassCk(root)]
  },

  // --- inspired by sympy simplify: wrong precedence when folding constants
  {
    id: 'swe-percent-decode',
    name: 'percent decoder mangles "+"',
    category: 'swe',
    description: 'decodeQuery uses decodeURIComponent directly but first replaces "+" with space, corrupting encoded plus signs.',
    setup: (root) => {
      write(
        root,
        'src/querystring.js',
        'function decodeQuery(qs) {\n' +
          '  const out = {};\n' +
          '  for (const pair of qs.split("&")) {\n' +
          '    const [k, v] = pair.split("=");\n' +
          '    if (!k) continue;\n' +
          '    // BUG: percent-decodes FIRST, then maps "+" to space — this\n' +
          '    // corrupts legitimately encoded plus signs (%2B).\n' +
          '    const key = decodeURIComponent(k).replace(/\\+/g, " ");\n' +
          '    const val = v === undefined ? "" : decodeURIComponent(v).replace(/\\+/g, " ");\n' +
          '    out[key] = val;\n' +
          '  }\n' +
          '  return out;\n' +
          '}\n' +
          'module.exports = { decodeQuery };\n'
      );
      write(
        root,
        'tests/querystring.test.js',
        'const assert = require("node:assert");\n' +
          'const { decodeQuery } = require("../src/querystring");\n' +
          'assert.deepEqual(decodeQuery("a=1&b=two+words"), { a: "1", b: "two words" });\n' +
          '// A literal encoded plus must survive decoding\n' +
          'assert.deepEqual(decodeQuery("eq=1%2B1%3D2"), { eq: "1+1=2" });\n'
      );
      write(root, 'tests/run.js', TEST_RUNNER);
    },
    passes: [
      {
        prompt:
          'decodeQuery corrupts "%2B" sequences: it percent-decodes FIRST and then maps "+" to space, turning encoded pluses into spaces. Reorder the operations in src/querystring.js so literal "+" becomes a space BEFORE percent-decoding.',
        script: [
          toolCall('read_file', { path: 'src/querystring.js' }),
          toolCall('apply_patch', {
            path: 'src/querystring.js',
            oldText:
              '    const key = decodeURIComponent(k).replace(/\\+/g, " ");\n' +
              '    const val = v === undefined ? "" : decodeURIComponent(v).replace(/\\+/g, " ");',
            newText:
              '    const key = decodeURIComponent(k.replace(/\\+/g, " "));\n' +
              '    const val = v === undefined ? "" : decodeURIComponent(v.replace(/\\+/g, " "));'
          }),
          text('Reordered decoding: literal plus signs map to spaces before percent-decoding.')
        ]
      }
    ],
    verify: (root) => [testsPassCk(root)]
  },

  // --- inspired by requests redirect history bookkeeping
  {
    id: 'swe-offbyone-slice',
    name: 'pagination slice returns one short',
    category: 'swe',
    description: 'paginate(page,size) uses page*size as the inclusive start, dropping one item per page after the first.',
    setup: (root) => {
      write(
        root,
        'src/paginate.js',
        'function paginate(items, page, size) {\n' +
          '  const start = page * size; // BUG: page is 1-based\n' +
          '  return items.slice(start, start + size);\n' +
          '}\n' +
          'module.exports = { paginate };\n'
      );
      write(
        root,
        'tests/paginate.test.js',
        'const assert = require("node:assert");\n' +
          'const { paginate } = require("../src/paginate");\n' +
          'const items = Array.from({ length: 10 }, (_, i) => i + 1);\n' +
          'assert.deepEqual(paginate(items, 1, 4), [1, 2, 3, 4]);\n' +
          'assert.deepEqual(paginate(items, 3, 4), [9, 10]);\n'
      );
      write(root, 'tests/run.js', TEST_RUNNER);
    },
    passes: [
      {
        prompt:
          'paginate() treats the 1-based page number as a 0-based index, so every page skips `size` items. Fix src/paginate.js so page 1 starts at item 0 and page 3 of ten items with size 4 returns [9,10].',
        script: [
          toolCall('apply_patch', {
            path: 'src/paginate.js',
            oldText: '  const start = page * size; // BUG: page is 1-based',
            newText: '  const start = (page - 1) * size;'
          }),
          text('Fixed the off-by-one: subtract 1 from the 1-based page number before slicing.')
        ]
      }
    ],
    verify: (root) => [testsPassCk(root)]
  },

  // --- inspired by urllib3 retry logic: retries never reset between hosts
  {
    id: 'swe-state-reset',
    name: 'rate limiter state leaks across keys',
    category: 'swe',
    description: 'RateLimiter.check(key) shares a single timestamp bucket across all keys, so different users block each other.',
    setup: (root) => {
      write(
        root,
        'src/ratelimit.js',
        'class RateLimiter {\n' +
          '  constructor(maxPerWindow, windowMs) {\n' +
          '    this.maxPerWindow = maxPerWindow;\n' +
          '    this.windowMs = windowMs;\n' +
          '    this.hits = [];       // BUG: shared across all keys\n' +
          '  }\n' +
          '  check(key, now = Date.now()) {\n' +
          '    this.hits = this.hits.filter((t) => now - t < this.windowMs);\n' +
          '    if (this.hits.length >= this.maxPerWindow) return false;\n' +
          '    this.hits.push(now);\n' +
          '    return true;\n' +
          '  }\n' +
          '}\n' +
          'module.exports = { RateLimiter };\n'
      );
      write(
        root,
        'tests/ratelimit.test.js',
        'const assert = require("node:assert");\n' +
          'const { RateLimiter } = require("../src/ratelimit");\n' +
          'const rl = new RateLimiter(2, 1000);\n' +
          'assert.equal(rl.check("alice", 0), true);\n' +
          'assert.equal(rl.check("alice", 1), true);\n' +
          'assert.equal(rl.check("alice", 2), false); // alice exhausted her own budget\n' +
          'assert.equal(rl.check("bob", 3), true);    // bob must be independent\n'
      );
      write(root, 'tests/run.js', TEST_RUNNER);
    },
    passes: [
      {
        prompt:
          'RateLimiter.check() blocks bob because alice exhausted the SHARED hit list. Give each key its own bucket in src/ratelimit.js so limits are enforced per key.',
        script: [
          toolCall('read_file', { path: 'src/ratelimit.js' }),
          toolCall('apply_patch', {
            path: 'src/ratelimit.js',
            oldText: '    this.hits = [];       // BUG: shared across all keys',
            newText: '    this.buckets = new Map(); // per-key timestamps'
          }),
          toolCall('apply_patch', {
            path: 'src/ratelimit.js',
            oldText:
              '    this.hits = this.hits.filter((t) => now - t < this.windowMs);\n' +
              '    if (this.hits.length >= this.maxPerWindow) return false;\n' +
              '    this.hits.push(now);',
            newText:
              '    const hits = (this.buckets.get(key) || []).filter((t) => now - t < this.windowMs);\n' +
              '    if (hits.length >= this.maxPerWindow) return false;\n' +
              '    hits.push(now);\n' +
              '    this.buckets.set(key, hits);'
          }),
          text('Refactored to per-key buckets stored in a Map.')
        ]
      }
    ],
    verify: (root) => [testsPassCk(root), containsCk(root, 'src/ratelimit.js', 'Map')]
  }
];

// Shared mini test-runner fixture: runs every *.test.js, exit 1 on any failure.
const TEST_RUNNER =
  'const fs = require("fs"), path = require("path");\n' +
  'let failed = 0;\n' +
  'for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js"))) {\n' +
  '  try { require(path.join(__dirname, f)); console.log(f + " ok"); }\n' +
  '  catch (e) { failed++; console.error(f + " FAILED:", e.message); }\n' +
  '}\n' +
  'process.exit(failed ? 1 : 0);\n';
