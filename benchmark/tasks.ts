import fs from 'node:fs';
import path from 'node:path';
import { loadLedger } from '../server/taskLedger';

// ---------------- types ----------------

export type PassMsg = Record<string, unknown>;

export interface Pass {
  prompt: string;
  /** Mock-mode script: one entry per LLM request, in order. Last entry must be a text answer. */
  script: PassMsg[];
  /** False = fresh conversation (no priorMessages), e.g. ledger-resume from disk. Default true. */
  continues?: boolean;
}

export interface EvalMeta {
  mode: 'mock' | 'live';
  model?: string;
  /** Per pass: raw JSON bodies of every LLM request that pass made (mock mode only). */
  passBodies: string[][];
  /** Final reply per pass. */
  replies: string[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface EvalTask {
  id: string;
  name: string;
  category: 'bugfix' | 'refactor' | 'feature' | 'testing' | 'ledger' | 'tricky' | 'swe';
  description: string;
  /** When set, the run gets a durable task ledger at .devforge/tasks/<runId>.md */
  runId?: string;
  /** Iteration cap for live mode (mock mode caps at script length + 2). */
  liveMaxIterations?: number;
  /**
   * P7.4: context budget (est. tokens) pushed to the loop as sampling.numCtxTokens.
   * Triggers the self-summarizing compaction path inside runAgentLoop (mock or live).
   */
  numCtxTokens?: number;
  /** P7.4: recent turns kept verbatim when compaction digests older ones. */
  compactionKeepTurns?: number;
  setup: (root: string) => void;
  passes: Pass[];
  verify: (root: string, meta: EvalMeta) => CheckResult[];
}

// ---------------- response helpers ----------------

export const toolCall = (name: string, args: Record<string, unknown>): PassMsg => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }]
});

export const text = (content: string): PassMsg => ({ role: 'assistant', content });

// ---------------- fixture helpers ----------------

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function cnt(s: string, needle: string): number {
  return s.split(needle).length - 1;
}

// ---------------- check helpers ----------------

const existsCk = (root: string, rel: string): CheckResult => ({
  name: `${rel} exists`,
  ok: fs.existsSync(path.join(root, rel))
});

export const containsCk = (root: string, rel: string, needle: string): CheckResult => {
  let ok = false;
  let detail: string | undefined;
  try {
    ok = read(root, rel).includes(needle);
  } catch (e) {
    detail = String((e as Error).message || e);
  }
  return { name: `${rel} contains "${needle}"`, ok, detail };
};

const notContainsCk = (root: string, rel: string, needle: string): CheckResult => {
  let ok = true;
  let detail: string | undefined;
  try {
    ok = !read(root, rel).includes(needle);
  } catch (e) {
    ok = false;
    detail = String((e as Error).message || e);
  }
  return { name: `${rel} does NOT contain "${needle}"`, ok, detail };
};

const countAtLeastCk = (root: string, rel: string, needle: string, min: number): CheckResult => {
  let n = 0;
  try {
    n = cnt(read(root, rel), needle);
  } catch {
    n = 0;
  }
  return { name: `${rel} contains "${needle}" ${min}+ times (found ${n})`, ok: n >= min };
};

// ---------------- the 20 tasks ----------------

export const TASKS: EvalTask[] = [
  // ================= bugfix =================

  {
    id: 'bug-offbyone',
    name: 'off-by-one loop bound',
    category: 'bugfix',
    description: 'sumRange excludes the last value; fix the loop bound so sumRange(1,5) === 15.',
    setup: (root) =>
      write(
        root,
        'src/math.ts',
        'export function sumRange(start: number, end: number): number {\n' +
          '  let total = 0;\n' +
          '  for (let i = start; i < end - 1; i++) {\n' +
          '    total += i;\n' +
          '  }\n' +
          '  return total;\n' +
          '}\n'
      ),
    passes: [
      {
        prompt: 'The sumRange function misses its last value (sumRange(1,5) returns 14). Fix the loop so it includes `end`.',
        script: [
          toolCall('apply_patch', { path: 'src/math.ts', oldText: 'i < end - 1', newText: 'i <= end' }),
          text('Fixed: the loop now runs i <= end, so the final value is included.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/math.ts', 'i <= end'),
      notContainsCk(root, 'src/math.ts', 'i < end - 1')
    ]
  },

  {
    id: 'bug-boundary',
    name: 'inclusive boundary check',
    category: 'bugfix',
    description: 'getGrade fails at exact cutoffs; >= needed at both thresholds.',
    setup: (root) =>
      write(
        root,
        'src/grade.ts',
        'export function getGrade(score: number): string {\n' +
          '  if (score > 90) return \'A\';\n' +
          '  if (score > 75) return \'B\';\n' +
          '  return \'C\';\n' +
          '}\n'
      ),
    passes: [
      {
        prompt: 'getGrade(90) must return "A" and getGrade(75) must return "B", but both use exclusive >. Make both comparisons inclusive.',
        script: [
          toolCall('apply_patch', { path: 'src/grade.ts', oldText: 'if (score > 90) return \'A\';', newText: 'if (score >= 90) return \'A\';' }),
          toolCall('apply_patch', { path: 'src/grade.ts', oldText: 'if (score > 75) return \'B\';', newText: 'if (score >= 75) return \'B\';' }),
          text('Both cutoffs are now inclusive.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/grade.ts', 'score >= 90'),
      containsCk(root, 'src/grade.ts', 'score >= 75'),
      notContainsCk(root, 'src/grade.ts', 'score > 90')
    ]
  },

  {
    id: 'bug-missing-wiring',
    name: 'wire an existing export into a second file',
    category: 'bugfix',
    description: 'formatPrice exists in utils.ts but shop.ts prints raw numbers; import and use it.',
    setup: (root) => {
      write(root, 'src/utils.ts', 'export function formatPrice(value: number): string {\n  return "\\$" + value.toFixed(2);\n}\n');
      write(
        root,
        'src/shop.ts',
        'export function renderLine(name: string, price: number): string {\n' +
          '  return name + \' \' + price;\n' +
          '}\n'
      );
    },
    passes: [
      {
        prompt: 'renderLine prints raw numbers. formatPrice already exists in src/utils.ts — wire it in so renderLine("Widget", 9.99) yields "Widget $9.99".',
        script: [
          toolCall('apply_patch', {
            path: 'src/shop.ts',
            oldText:
              'export function renderLine(name: string, price: number): string {\n  return name + \' \' + price;\n}',
            newText:
              "import { formatPrice } from './utils';\n\n" +
              'export function renderLine(name: string, price: number): string {\n' +
              '  return name + \' \' + formatPrice(price);\n' +
              '}'
          }),
          text('renderLine now formats prices through formatPrice from ./utils.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/shop.ts', "from './utils'"),
      containsCk(root, 'src/shop.ts', 'formatPrice(price)')
    ]
  },

  {
    id: 'bug-nullguard',
    name: 'null guard for an optional field',
    category: 'bugfix',
    description: 'displayName throws when user.name is undefined; guard it and return a fallback.',
    setup: (root) =>
      write(
        root,
        'src/profile.ts',
        'export function displayName(user: { name?: string }): string {\n' +
          '  return user.name.trim();\n' +
          '}\n'
      ),
    passes: [
      {
        prompt: 'displayName crashes when user.name is undefined. Return "(anonymous)" when the name is missing.',
        script: [
          toolCall('apply_patch', {
            path: 'src/profile.ts',
            oldText: 'return user.name.trim();',
            newText: "return user.name ? user.name.trim() : '(anonymous)';"
          }),
          text('Missing names now fall back to "(anonymous)" instead of throwing.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/profile.ts', "user.name ? user.name.trim() : '(anonymous)'")
    ]
  },

  {
    id: 'bug-wrongvar',
    name: 'function ignores its own parameter',
    category: 'bugfix',
    description: 'discountedPrice returns the raw price; it should subtract the discount.',
    setup: (root) =>
      write(
        root,
        'src/checkout.ts',
        'export function discountedPrice(price: number, discount: number): number {\n' +
          '  return price;\n' +
          '}\n'
      ),
    passes: [
      {
        prompt: 'discountedPrice ignores the discount argument. Make it return price minus discount.',
        script: [
          toolCall('apply_patch', { path: 'src/checkout.ts', oldText: 'return price;', newText: 'return price - discount;' }),
          text('discountedPrice now returns price - discount.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/checkout.ts', 'return price - discount;'),
      notContainsCk(root, 'src/checkout.ts', 'return price;')
    ]
  },

  // ================= refactor =================

  {
    id: 'refactor-rename',
    name: 'rename a function across three files',
    category: 'refactor',
    description: 'calcTotal → calculateTotal in the definition file and both callers.',
    setup: (root) => {
      write(root, 'src/total.ts', 'export function calcTotal(items: number[]): number {\n  return items.reduce((s, x) => s + x, 0);\n}\n');
      write(
        root,
        'src/order.ts',
        "import { calcTotal } from './total';\n\n" +
          'export function orderTotal(items: number[]): number {\n' +
          '  return calcTotal(items);\n' +
          '}\n'
      );
      write(
        root,
        'src/receipt.ts',
        "import { calcTotal } from './total';\n\n" +
          'export const receiptTotal = calcTotal([1, 2, 3]);\n'
      );
    },
    passes: [
      {
        prompt: 'Rename calcTotal to calculateTotal everywhere — the definition in src/total.ts and both callers in src/order.ts and src/receipt.ts.',
        script: [
          toolCall('apply_patch', { path: 'src/total.ts', oldText: 'function calcTotal(', newText: 'function calculateTotal(' }),
          toolCall('write_file', {
            path: 'src/order.ts',
            content:
              "import { calculateTotal } from './total';\n\n" +
              'export function orderTotal(items: number[]): number {\n' +
              '  return calculateTotal(items);\n' +
              '}\n'
          }),
          toolCall('write_file', {
            path: 'src/receipt.ts',
            content: "import { calculateTotal } from './total';\n\nexport const receiptTotal = calculateTotal([1, 2, 3]);\n"
          }),
          text('Renamed in all three files.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/total.ts', 'function calculateTotal('),
      containsCk(root, 'src/order.ts', 'calculateTotal(items)'),
      containsCk(root, 'src/receipt.ts', 'calculateTotal([1, 2, 3])'),
      notContainsCk(root, 'src/total.ts', 'calcTotal'),
      notContainsCk(root, 'src/order.ts', 'calcTotal'),
      notContainsCk(root, 'src/receipt.ts', 'calcTotal')
    ]
  },

  {
    id: 'refactor-extract-helper',
    name: 'extract a duplicated helper',
    category: 'refactor',
    description: 'Two functions paste the same normalisation; extract one shared helper both call.',
    setup: (root) =>
      write(
        root,
        'src/text.ts',
        'export function normalizeFirst(s: string): string {\n' +
          '  const t = s.trim().toLowerCase();\n' +
          '  return t.replace(/\\s+/g, \' \');\n' +
          '}\n\n' +
          'export function normalizeLast(s: string): string {\n' +
          '  const t = s.trim().toLowerCase();\n' +
          '  return t.replace(/\\s+/g, \' \');\n' +
          '}\n'
      ),
    passes: [
      {
        prompt: 'normaliseFirst and normaliseLast duplicate the same logic. Extract a shared helper and make both functions use it.',
        script: [
          toolCall('write_file', {
            path: 'src/text.ts',
            content:
              'function normalize(s: string): string {\n' +
              '  const t = s.trim().toLowerCase();\n' +
              '  return t.replace(/\\s+/g, \' \');\n' +
              '}\n\n' +
              'export function normalizeFirst(s: string): string {\n' +
              '  return normalize(s);\n' +
              '}\n\n' +
              'export function normalizeLast(s: string): string {\n' +
              '  return normalize(s);\n' +
              '}\n'
          }),
          text('Both functions now share the normalize() helper.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/text.ts', 'function normalize(s: string): string'),
      countAtLeastCk(root, 'src/text.ts', 'return normalize(s);', 2),
      containsCk(root, 'src/text.ts', 'export function normalizeFirst'),
      containsCk(root, 'src/text.ts', 'export function normalizeLast')
    ]
  },

  {
    id: 'refactor-constant',
    name: 'hoist a magic number to a named constant',
    category: 'refactor',
    description: '0.85 appears twice; introduce DISCOUNT_RATE and use it in both places.',
    setup: (root) =>
      write(
        root,
        'src/pricing.ts',
        'export function withDiscount(price: number): number {\n' +
          '  return price * 0.85;\n' +
          '}\n\n' +
          'export function withClearance(price: number): number {\n' +
          '  return price * 0.85;\n' +
          '}\n'
      ),
    passes: [
      {
        prompt: 'The 0.85 multiplier is a magic number repeated in two functions. Extract it to an exported DISCOUNT_RATE constant and use it in both.',
        script: [
          toolCall('write_file', {
            path: 'src/pricing.ts',
            content:
              'export const DISCOUNT_RATE = 0.85;\n\n' +
              'export function withDiscount(price: number): number {\n' +
              '  return price * DISCOUNT_RATE;\n' +
              '}\n\n' +
              'export function withClearance(price: number): number {\n' +
              '  return price * DISCOUNT_RATE;\n' +
              '}\n'
          }),
          text('Discount rate is now a named constant used by both functions.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/pricing.ts', 'export const DISCOUNT_RATE = 0.85'),
      countAtLeastCk(root, 'src/pricing.ts', 'price * DISCOUNT_RATE', 2),
      notContainsCk(root, 'src/pricing.ts', 'price * 0.85')
    ]
  },

  {
    id: 'refactor-early-return',
    name: 'flatten nesting with early returns',
    category: 'refactor',
    description: 'handle() nests two ifs; rewrite with guard clauses, same behaviour.',
    setup: (root) =>
      write(
        root,
        'src/handler.ts',
        'export function handle(request: { id?: string; body?: string } | null): string {\n' +
          '  if (request) {\n' +
          '    if (request.id) {\n' +
          "      return 'ok:' + request.id;\n" +
          '    }\n' +
          '  }\n' +
          "  return 'noop';\n" +
          '}\n'
      ),
    passes: [
      {
        prompt: 'handle() has unnecessary nested ifs. Rewrite it with early-return guard clauses without changing its behaviour.',
        script: [
          toolCall('write_file', {
            path: 'src/handler.ts',
            content:
              'export function handle(request: { id?: string; body?: string } | null): string {\n' +
              "  if (!request) return 'noop';\n" +
              "  if (!request.id) return 'noop';\n" +
              "  return 'ok:' + request.id;\n" +
              '}\n'
          }),
          text('Flattened to guard clauses; behaviour unchanged.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/handler.ts', "if (!request) return 'noop';"),
      containsCk(root, 'src/handler.ts', "if (!request.id) return 'noop';"),
      notContainsCk(root, 'src/handler.ts', 'if (request) {')
    ]
  },

  {
    id: 'refactor-split-function',
    name: 'split a long function into named helpers',
    category: 'refactor',
    description: 'processOrder inlines discount + tax; extract applyBulkDiscount and addTax.',
    setup: (root) =>
      write(
        root,
        'src/order.ts',
        'export function processOrder(price: number, loyalty: boolean): number {\n' +
          '  let total = price;\n' +
          '  if (price > 100) {\n' +
          '    total = total * 0.9;\n' +
          '  }\n' +
          '  const tax = total * 0.1;\n' +
          '  const final = total + tax;\n' +
          '  return final;\n' +
          '}\n'
      ),
    passes: [
      {
        prompt: 'processOrder mixes discounting and tax. Split it into exported applyBulkDiscount and addTax helpers and call them from processOrder, keeping the math identical.',
        script: [
          toolCall('write_file', {
            path: 'src/order.ts',
            content:
              'export function applyBulkDiscount(price: number): number {\n' +
              '  if (price > 100) {\n' +
              '    return price * 0.9;\n' +
              '  }\n' +
              '  return price;\n' +
              '}\n\n' +
              'export function addTax(amount: number): number {\n' +
              '  return amount + amount * 0.1;\n' +
              '}\n\n' +
              'export function processOrder(price: number, loyalty: boolean): number {\n' +
              '  const discounted = applyBulkDiscount(price);\n' +
              '  return addTax(discounted);\n' +
              '}\n'
          }),
          text('Split into applyBulkDiscount and addTax; processOrder composes them.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/order.ts', 'export function applyBulkDiscount'),
      containsCk(root, 'src/order.ts', 'export function addTax'),
      containsCk(root, 'src/order.ts', 'applyBulkDiscount(price)'),
      containsCk(root, 'src/order.ts', 'addTax(discounted)')
    ]
  },

  // ================= feature =================

  {
    id: 'feature-new-module',
    name: 'create a new module and wire it in',
    category: 'feature',
    description: 'Add src/greeting.ts with greet() and make main() use it.',
    setup: (root) =>
      write(root, 'src/main.ts', 'export function main(): string {\n  return \'\';\n}\n'),
    passes: [
      {
        prompt: 'Create src/greeting.ts exporting greet(name) which returns "hello, <name>", and update src/main.ts so main() returns greet("devforge").',
        script: [
          toolCall('write_file', {
            path: 'src/greeting.ts',
            content: 'export function greet(name: string): string {\n  return \'hello, \' + name;\n}\n'
          }),
          toolCall('apply_patch', {
            path: 'src/main.ts',
            oldText: 'export function main(): string {\n  return \'\';\n}',
            newText:
              "import { greet } from './greeting';\n\n" +
              'export function main(): string {\n' +
              "  return greet('devforge');\n" +
              '}'
          }),
          text('New greeting module created and wired into main().')
        ]
      }
    ],
    verify: (root) => [
      existsCk(root, 'src/greeting.ts'),
      containsCk(root, 'src/greeting.ts', 'export function greet(name: string)'),
      containsCk(root, 'src/main.ts', "from './greeting'"),
      containsCk(root, 'src/main.ts', "greet('devforge')")
    ]
  },

  {
    id: 'feature-add-function',
    name: 'add a new exported function to an existing module',
    category: 'feature',
    description: 'Add clamp(v, lo, hi) to src/util.ts alongside sign().',
    setup: (root) =>
      write(
        root,
        'src/util.ts',
        'export function sign(n: number): number {\n  return n >= 0 ? 1 : -1;\n}\n'
      ),
    passes: [
      {
        prompt: 'Add an exported clamp(v, lo, hi) function to src/util.ts that clamps v into [lo, hi].',
        script: [
          toolCall('apply_patch', {
            path: 'src/util.ts',
            oldText: 'export function sign(n: number): number',
            newText:
              'export function clamp(v: number, lo: number, hi: number): number {\n' +
              '  if (v < lo) return lo;\n' +
              '  if (v > hi) return hi;\n' +
              '  return v;\n' +
              '}\n\n' +
              'export function sign(n: number): number'
          }),
          text('clamp() added to src/util.ts.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/util.ts', 'export function clamp(v: number, lo: number, hi: number)'),
      containsCk(root, 'src/util.ts', 'if (v < lo) return lo;'),
      containsCk(root, 'src/util.ts', 'if (v > hi) return hi;'),
      containsCk(root, 'src/util.ts', 'export function sign')
    ]
  },

  {
    id: 'feature-csv',
    name: 'multi-file feature: CSV export',
    category: 'feature',
    description: 'Create src/csv.ts exporting toCsv(rows) and make src/reports.ts return real data through it.',
    setup: (root) => {
      write(
        root,
        'src/data.ts',
        'export interface Row {\n  name: string;\n  qty: number;\n}\n\n' +
          'export const rows: Row[] = [\n  { name: \'widget\', qty: 2 },\n  { name: \'gadget\', qty: 5 }\n];\n'
      );
      write(root, 'src/reports.ts', "export function report(): string {\n  return 'TODO';\n}\n");
    },
    passes: [
      {
        prompt: 'Build a CSV export: create src/csv.ts with toCsv(rows) that emits a "name,qty" header plus one row per entry, and update src/reports.ts so report() returns toCsv(rows) using the data from src/data.ts.',
        script: [
          toolCall('write_file', {
            path: 'src/csv.ts',
            content:
              "import type { Row } from './data';\n\n" +
              'export function toCsv(rows: Row[]): string {\n' +
              "  const head = 'name,qty';\n" +
              "  const body = rows.map((r) => r.name + ',' + r.qty).join('\\n');\n" +
              "  return head + '\\n' + body;\n" +
              '}\n'
          }),
          toolCall('apply_patch', {
            path: 'src/reports.ts',
            oldText: "export function report(): string {\n  return 'TODO';\n}",
            newText:
              "import { rows } from './data';\n" +
              "import { toCsv } from './csv';\n\n" +
              'export function report(): string {\n' +
              '  return toCsv(rows);\n' +
              '}'
          }),
          text('CSV module created; reports.ts now returns real CSV data.')
        ]
      }
    ],
    verify: (root) => [
      existsCk(root, 'src/csv.ts'),
      containsCk(root, 'src/csv.ts', 'export function toCsv(rows: Row[])'),
      containsCk(root, 'src/csv.ts', "'name,qty'"),
      containsCk(root, 'src/reports.ts', "from './csv'"),
      containsCk(root, 'src/reports.ts', 'toCsv(rows)'),
      notContainsCk(root, 'src/reports.ts', "'TODO'")
    ]
  },

  {
    id: 'feature-extend-config',
    name: 'extend a config shape and its consumer',
    category: 'feature',
    description: 'Add retries to Config with a default of 3 and make client.ts consume it.',
    setup: (root) => {
      write(
        root,
        'src/config.ts',
        'export interface Config {\n  host: string;\n}\n\n' +
          'export function loadConfig(): Config {\n  return { host: \'localhost\' };\n}\n'
      );
      write(
        root,
        'src/client.ts',
        "import { loadConfig } from './config';\n\n" +
          'export function connect(retries: number): string {\n' +
          '  const cfg = loadConfig();\n' +
          '  return cfg.host + \':\' + retries;\n' +
          '}\n'
      );
    },
    passes: [
      {
        prompt: 'Add an optional retries field to Config (default 3 from loadConfig), and change client.ts to use cfg.retries when present, falling back to a caller-provided value, then 1.',
        script: [
          toolCall('write_file', {
            path: 'src/config.ts',
            content:
              'export interface Config {\n  host: string;\n  retries?: number;\n}\n\n' +
              'export function loadConfig(): Config {\n  return { host: \'localhost\', retries: 3 };\n}\n'
          }),
          toolCall('write_file', {
            path: 'src/client.ts',
            content:
              "import { loadConfig } from './config';\n\n" +
              'export function connect(fallback?: number): string {\n' +
              '  const cfg = loadConfig();\n' +
              '  const retries = cfg.retries ?? fallback ?? 1;\n' +
              '  return cfg.host + \':\' + retries;\n' +
              '}\n'
          }),
          text('Config now carries retries (default 3) and client.ts consumes it.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/config.ts', 'retries?: number'),
      containsCk(root, 'src/config.ts', 'retries: 3'),
      containsCk(root, 'src/client.ts', 'cfg.retries'),
      containsCk(root, 'src/client.ts', 'fallback ?? 1')
    ]
  },

  // ================= testing =================

  {
    id: 'test-write-tests',
    name: 'write a test file for an existing module',
    category: 'testing',
    description: 'Create tests/calc.test.ts with vitest assertions for add and mul.',
    setup: (root) =>
      write(
        root,
        'src/calc.ts',
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n\n' +
          'export function mul(a: number, b: number): number {\n  return a * b;\n}\n'
      ),
    passes: [
      {
        prompt: 'Write tests/calc.test.ts (vitest) covering: add(2,3) is 5, add(-1,1) is 0, mul(4,5) is 20.',
        script: [
          toolCall('write_file', {
            path: 'tests/calc.test.ts',
            content:
              "import { describe, it, expect } from 'vitest';\n" +
              "import { add, mul } from '../src/calc';\n\n" +
              "describe('calc', () => {\n" +
              "  it('adds numbers', () => {\n" +
              '    expect(add(2, 3)).toBe(5);\n' +
              '    expect(add(-1, 1)).toBe(0);\n' +
              '  });\n' +
              "  it('multiplies numbers', () => {\n" +
              '    expect(mul(4, 5)).toBe(20);\n' +
              '  });\n' +
              '});\n'
          }),
          text('Wrote tests/calc.test.ts with three assertions.')
        ]
      }
    ],
    verify: (root) => [
      existsCk(root, 'tests/calc.test.ts'),
      containsCk(root, 'tests/calc.test.ts', "from '../src/calc'"),
      containsCk(root, 'tests/calc.test.ts', 'expect(add(2, 3)).toBe(5)'),
      containsCk(root, 'tests/calc.test.ts', 'expect(add(-1, 1)).toBe(0)'),
      containsCk(root, 'tests/calc.test.ts', 'expect(mul(4, 5)).toBe(20)')
    ]
  },

  {
    id: 'test-error-paths',
    name: 'add error handling and pin it with tests',
    category: 'testing',
    description: 'parseAmount must throw RangeError on non-finite input; tests cover both paths.',
    setup: (root) =>
      write(
        root,
        'src/parse.ts',
        'export function parseAmount(raw: string): number {\n  return Number(raw);\n}\n'
      ),
    passes: [
      {
        prompt: 'Make parseAmount throw a RangeError when the parsed number is not finite, and add tests/parse.test.ts covering the happy path ("12.5" → 12.5) and the throwing case ("oops").',
        script: [
          toolCall('apply_patch', {
            path: 'src/parse.ts',
            oldText: 'return Number(raw);',
            newText:
              'const n = Number(raw);\n' +
              'if (!Number.isFinite(n)) {\n' +
              "  throw new RangeError('not a finite amount');\n" +
              '}\n' +
              'return n;'
          }),
          toolCall('write_file', {
            path: 'tests/parse.test.ts',
            content:
              "import { it, expect } from 'vitest';\n" +
              "import { parseAmount } from '../src/parse';\n\n" +
              "it('parses a finite amount', () => {\n" +
              '  expect(parseAmount(\'12.5\')).toBe(12.5);\n' +
              '});\n\n' +
              "it('rejects non-finite input', () => {\n" +
              '  expect(() => parseAmount(\'oops\')).toThrow(RangeError);\n' +
              '});\n'
          }),
          text('parseAmount now throws RangeError on bad input; both paths are tested.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/parse.ts', 'throw new RangeError'),
      notContainsCk(root, 'src/parse.ts', 'return Number(raw);'),
      existsCk(root, 'tests/parse.test.ts'),
      containsCk(root, 'tests/parse.test.ts', 'toBe(12.5)'),
      containsCk(root, 'tests/parse.test.ts', 'toThrow(RangeError)')
    ]
  },

  // ================= ledger =================

  {
    id: 'ledger-progress',
    name: 'durable ledger: record progress end-to-end',
    category: 'ledger',
    runId: 'eval-ledger-1',
    description: 'update_task twice (plan, then all-complete) around a write; ledger on disk must reflect it.',
    setup: () => {},
    passes: [
      {
        prompt: 'Do a small 3-step task: mark planning done while writing the artifact, then close all steps in the task ledger.',
        script: [
          toolCall('update_task', {
            title: 'Eval ledger task',
            steps: [
              { text: 'plan the work', status: 'completed' },
              { text: 'write artifact.txt', status: 'in_progress' },
              { text: 'summarize', status: 'pending' }
            ],
            add_finding: 'workspace is an eval fixture',
            next_action: 'write artifact.txt'
          }),
          toolCall('write_file', { path: 'artifact.txt', content: 'done\n' }),
          toolCall('update_task', {
            title: 'Eval ledger task',
            steps: [
              { text: 'plan the work', status: 'completed' },
              { text: 'write artifact.txt', status: 'completed' },
              { text: 'summarize', status: 'completed' }
            ],
            next_action: 'none'
          }),
          text('All steps complete; artifact.txt written.')
        ]
      }
    ],
    verify: (root, meta) => {
      const l = loadLedger(root, 'eval-ledger-1');
      const ledgerExists = l !== null;
      const titleOk = l?.title === 'Eval ledger task';
      const stepsOk = !!l && l.steps.length === 3 && l.steps.every((s) => s.status === 'completed');
      const findingOk = !!l && l.keyFindings.includes('workspace is an eval fixture');
      const touchedOk = !!l && l.filesTouched.includes('artifact.txt');
      return [
        { name: 'ledger exists on disk', ok: ledgerExists },
        { name: 'ledger title is "Eval ledger task"', ok: !!titleOk },
        { name: 'all 3 steps completed', ok: !!stepsOk },
        { name: 'finding recorded', ok: !!findingOk },
        { name: 'artifact.txt auto-tracked in filesTouched', ok: !!touchedOk },
        { name: 'ledger refreshed into LLM requests', ok: meta.passBodies[0]?.some((b) => b.includes('<<<TASK_LEDGER')) ?? false }
      ];
    }
  },

  {
    id: 'ledger-resume',
    name: 'durable ledger: resume from disk with fresh context',
    category: 'ledger',
    runId: 'eval-ledger-2',
    description: 'Pass 1 records mid-task state; pass 2 starts a brand-new conversation and must see the saved progress.',
    setup: () => {},
    passes: [
      {
        prompt: 'Start the crash task: finish phase one and get into phase two.',
        script: [
          toolCall('update_task', {
            title: 'Crash task',
            steps: [
              { text: 'phase one', status: 'completed' },
              { text: 'phase two', status: 'in_progress', note: 'half patched' }
            ],
            next_action: 'finish phase two'
          }),
          text('Phase one done, phase two started.')
        ]
      },
      {
        prompt: 'Continue where the previous conversation left off.',
        continues: false,
        script: [text('Resuming from the ledger: phase two was half patched; next action is to finish phase two.')]
      }
    ],
    verify: (root, meta) => {
      const l = loadLedger(root, 'eval-ledger-2');
      const stepState = !!l && l.steps.length === 2 && l.steps[1].status === 'in_progress';
      const body = (meta.passBodies[1] || [])[0] || '';
      const b = (needle: string) => body.includes(needle);
      const liveFallback =
        meta.mode === 'live'
          ? meta.replies[1]?.includes('phase two') === true && meta.replies[1]?.includes('half patched') === true
          : b('Crash task') && b('half patched') && b('finish phase two') && b('<<<TASK_LEDGER');
      return [
        { name: 'pass 1 left phase two in_progress on disk', ok: !!stepState },
        {
          name: meta.mode === 'mock' ? 'pass 2 request carried the saved ledger' : 'pass 2 reply reflects saved ledger state',
          ok: !!liveFallback
        }
      ];
    }
  },

  // ================= tricky =================

  {
    id: 'tricky-whitespace-drift',
    name: 'fuzzy patch across indentation drift',
    category: 'tricky',
    description: 'The patch\'s context uses different indentation than the file; fuzzy matching must still land it.',
    setup: (root) =>
      write(
        root,
        'src/service.ts',
        'export function greet(name: string): string {\n  return \'hi \' + name;\n}\n\n' +
          'export function bye(name: string): string {\n  return \'bye \' + name;\n}\n'
      ),
    passes: [
      {
        prompt: 'Change bye() to append an exclamation mark, and add a farewell() alias that calls bye().',
        script: [
          toolCall('apply_patch', {
            path: 'src/service.ts',
            oldText:
              'export function bye(name: string): string {\n' +
              '    return \'bye \' + name;\n' +
              '}',
            newText:
              'export function bye(name: string): string {\n' +
              '  return \'bye \' + name + \'!\';\n' +
              '}\n\n' +
              'export function farewell(name: string): string {\n' +
              '  return bye(name);\n' +
              '}'
          }),
          text('bye() now ends with "!" and farewell() aliases it.')
        ]
      }
    ],
    verify: (root) => [
      containsCk(root, 'src/service.ts', "return 'bye ' + name + '!';"),
      containsCk(root, 'src/service.ts', 'export function farewell(name: string): string'),
      containsCk(root, 'src/service.ts', 'return bye(name);'),
      containsCk(root, 'src/service.ts', "return 'hi ' + name;")
    ]
  },

  {
    id: 'tricky-large-file-tail',
    name: 'edit the tail of a large file after a ranged read',
    category: 'tricky',
    description: '301-line file; locate VERSION near the end via an offset/limit read, then patch it.',
    setup: (root) => {
      const lines: string[] = [];
      for (let i = 1; i <= 300; i++) lines.push('const N' + i + ' = ' + i + ';');
      lines.push('export const VERSION = 1;');
      write(root, 'big.ts', lines.join('\n') + '\n');
    },
    passes: [
      {
        prompt: 'big.ts is large; VERSION lives at the very end. Read just the tail (offset ~290) and bump VERSION from 1 to 2.',
        script: [
          toolCall('read_file', { path: 'big.ts', offset: 290, limit: 20 }),
          toolCall('apply_patch', { path: 'big.ts', oldText: 'export const VERSION = 1;', newText: 'export const VERSION = 2;' }),
          text('Bumped VERSION to 2.')
        ]
      }
    ],
    verify: (root) => {
      let content = '';
      try {
        content = read(root, 'big.ts');
      } catch {
        /* file missing */
      }
      return [
        containsCk(root, 'big.ts', 'export const VERSION = 2;'),
        notContainsCk(root, 'big.ts', 'export const VERSION = 1;'),
        { name: 'earlier lines intact (300 consts + new version)', ok: content.includes('const N150 = 150;') && content.includes('const N300 = 300;') }
      ];
    }
  },

  // ================= P7.4: compaction quality bar =================

  {
    id: 'tricky-compaction-survival',
    name: 'finish a multi-step task across 3+ live compactions',
    category: 'tricky',
    runId: 'eval-compact-1',
    numCtxTokens: 350,
    compactionKeepTurns: 1,
    description:
      'Phase 7.4 quality bar (mock + live): a 950-line fixture with a 350-token budget forces 3+ real self-summarizing compactions before the model writes findings.txt. Surviving means (a) the loop still completes all 6 window reads + write + ledger close, (b) findings.txt is byte-exact in file order (the format/order only lives in the user prompt, which survives via non-lossy transcripts), and (c) every required window is preserved verbatim on disk under .opencode/memory/.',
    setup: (root) => {
      const lines: string[] = [];
      for (let i = 1; i <= 950; i++) {
        lines.push('const V' + String(i).padStart(3, '0') + ' = ' + i + ' * ' + i + ';');
      }
      write(root, 'big.ts', lines.join('\n') + '\n');
    },
    passes: [
      {
        prompt:
          'Context-stress test: your context budget is tiny, so compaction WILL run many times. Follow these steps exactly, in order: ' +
          '(1) scan these 6 windows with read_file of big.ts, EXACTLY these offset/limit pairs and nothing else: 119/25, 279/25, 439/25, 599/25, 759/25, 899/25; ' +
          '(2) then write_file findings.txt containing ONLY the 4 FINDING lines for the windows 120, 280, 440, 600, in that file-position order, each formatted exactly FINDING <offset>: <first token of the first line of that window> (e.g. FINDING 120: V120); ' +
          '(3) then update_task once, marking every step completed. Use no other tools.',
        script: [
          toolCall('read_file', { path: 'big.ts', offset: 119, limit: 25 }),
          toolCall('read_file', { path: 'big.ts', offset: 279, limit: 25 }),
          toolCall('read_file', { path: 'big.ts', offset: 439, limit: 25 }),
          toolCall('read_file', { path: 'big.ts', offset: 599, limit: 25 }),
          toolCall('read_file', { path: 'big.ts', offset: 759, limit: 25 }),
          toolCall('read_file', { path: 'big.ts', offset: 899, limit: 25 }),
          toolCall('write_file', {
            path: 'findings.txt',
            content: 'FINDING 120: V120\nFINDING 280: V280\nFINDING 440: V440\nFINDING 600: V600\n'
          }),
          toolCall('update_task', {
            title: 'Compaction survival scan',
            steps: [
              { text: 'scan windows 120, 280, 440, 600, 760, 900', status: 'completed' },
              { text: 'write findings.txt in file order', status: 'completed' }
            ],
            next_action: 'none'
          }),
          text('Scanned all six windows and wrote findings.txt in file order.')
        ]
      }
    ],
    verify: (root, meta) => {
      // (a) loop finished the whole job: write + ledger close + closing reply
      const wrote = (meta.replies[0] || '').includes('findings.txt') || (meta.replies[0] || '').includes('windows');
      const l = loadLedger(root, 'eval-compact-1');
      const closed = !!l && l.steps.length > 0 && l.steps.every((s) => s.status === 'completed');

      // (b) artifact is byte-exact, in file-position order
      let body = '';
      try {
        body = read(root, 'findings.txt');
      } catch {
        body = '';
      }
      const exact =
        body === 'FINDING 120: V120\nFINDING 280: V280\nFINDING 440: V440\nFINDING 600: V600\n';
      const orderOk =
        body.indexOf('FINDING 120') !== -1 &&
        body.indexOf('FINDING 120') < body.indexOf('FINDING 280') &&
        body.indexOf('FINDING 280') < body.indexOf('FINDING 440') &&
        body.indexOf('FINDING 440') < body.indexOf('FINDING 600');

      // (c) 3+ compaction events, every required window verbatim on disk
      const memDir = path.join(root, '.opencode', 'memory');
      const files = (() => {
        try {
          return fs
            .readdirSync(memDir)
            .filter((n) => n.startsWith('eval-compact-1-') && n.endsWith('.md'))
            .length;
        } catch {
          return 0;
        }
      })();
      const required = ['const V120 = 120 * 120;', 'const V280 = 280 * 280;', 'const V440 = 440 * 440;', 'const V600 = 600 * 600;'];
      let covered = 0;
      if (files > 0) {
        try {
          const all = fs
            .readdirSync(memDir)
            .filter((n) => n.startsWith('eval-compact-1-') && n.endsWith('.md'))
            .map((n) => fs.readFileSync(path.join(memDir, n), 'utf8'))
            .join('\n');
          covered = required.filter((w) => all.includes(w)).length;
        } catch {
          covered = 0;
        }
      }
      return [
        { name: '3+ non-lossy transcripts persisted on disk (' + files + ' found)', ok: files >= 3 },
        { name: 'all 4 required windows preserved verbatim (' + covered + '/4)', ok: covered >= 4 },
        { name: 'findings.txt byte-exact', ok: exact, detail: exact ? undefined : 'got: ' + JSON.stringify(body.slice(0, 200)) },
        { name: 'findings.txt in file-position order (120,280,440,600)', ok: orderOk },
        { name: 'run finished with a closing summary', ok: wrote },
        { name: 'task ledger closed (all steps completed)', ok: closed }
      ];
    }
  }
];
