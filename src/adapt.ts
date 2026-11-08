import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import type { Operation } from './types.js';
import type { Analysis } from './discover/analyze.js';
import { coupledTests, inLayout, matchOperation, moveTarget } from './discover/analyze.js';
import type { TestCase } from './discover/playwright-tests.js';
import type { PostmanCollection, PostmanRequest } from './discover/postman.js';
import { operationFolder } from './generate/templates.js';
import { findPython } from './generate/generate.js';
import { pyLit, pyName } from './generate/python.js';

/**
 * adapt: applies the "move" and "convert Postman" proposals.
 *  - Test code is never rewritten. A moved test keeps everything around it (imports, hooks,
 *    fixtures, module variables); only the other tests are left out and relative imports re-pointed.
 *  - Tests that share state with another test are not moved.
 *  - Postman requests are converted only when nothing has to be guessed.
 *  - After writing, the result must collect (playwright --list / pytest --collect-only), or
 *    everything is rolled back.
 */

export interface FileChange {
  path: string; // relative to root, posix
  action: 'create' | 'rewrite' | 'delete';
  content?: string;
  reason: string;
}

export interface Skipped {
  what: string;
  reason: string;
}

export interface AdaptPlan {
  changes: FileChange[];
  skipped: Skipped[];
}

const toPosix = (p: string) => p.replace(/\\/g, '/');

/* ------------------------------------------------------------------ moving tests */

/** Remove the given (1-based, inclusive) line ranges, then tidy blank lines. */
export function removeRanges(src: string, ranges: { start: number; end: number }[]): string {
  const lines = src.split(/\r?\n/);
  const drop = new Set<number>();
  for (const r of ranges) for (let i = r.start; i <= r.end; i++) drop.add(i - 1);
  // Keep at most two blank lines in a row (PEP 8 uses two between top-level definitions).
  return lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\n+$/, '\n');
}

/** Re-point relative imports after a TS/JS file moves from `from` to `to`. */
export function rewriteRelativeImports(src: string, from: string, to: string): string {
  const fix = (spec: string) => {
    if (!spec.startsWith('.')) return spec;
    const target = posix.normalize(posix.join(posix.dirname(from), spec));
    let rel = posix.relative(posix.dirname(to), target);
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
  };
  return src
    .replace(/(\bfrom\s+['"])([^'"]+)(['"])/g, (_, a, s, b) => a + fix(s) + b)
    .replace(/(\b(?:require|import)\(\s*['"])([^'"]+)(['"]\s*\))/g, (_, a, s, b) => a + fix(s) + b);
}

function planMoves(root: string, analysis: Analysis, ops: Operation[], testsDir: string, changes: FileChange[], skipped: Skipped[]): void {
  const coupled = coupledTests(analysis.tests);
  const byFile = new Map<string, TestCase[]>();
  for (const t of analysis.tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);

  for (const [file, tests] of byFile) {
    if (inLayout(file, testsDir)) continue;
    const src = readFileSync(join(root, file), 'utf8');
    const groups = new Map<string, TestCase[]>();
    const staying: TestCase[] = [];
    for (const t of tests) {
      const target = moveTarget(t, ops, testsDir);
      const why = coupled.get(t) ?? (!t.range ? 'source position unknown' : !target ? 'no API call to classify it by' : undefined);
      if (why || !target) {
        staying.push(t);
        skipped.push({ what: `${file}:${t.line} "${t.title}"`, reason: why ?? 'no target' });
        continue;
      }
      if (existsSync(join(root, target)) || changes.some((c) => c.path === target && c.action === 'create' && !groups.has(target))) {
        staying.push(t);
        skipped.push({ what: `${file}:${t.line} "${t.title}"`, reason: `${target} already exists` });
        continue;
      }
      groups.set(target, [...(groups.get(target) ?? []), t]);
    }
    if (!groups.size) continue;

    for (const [target, mine] of groups) {
      const others = tests.filter((t) => !mine.includes(t) && t.range).map((t) => t.range!);
      let content = removeRanges(src, others);
      if (!file.endsWith('.py')) content = rewriteRelativeImports(content, file, target);
      const header = file.endsWith('.py')
        ? `# Moved by api-test-agent adapt from ${file}: ${mine.map((t) => t.title).join(', ')}.\n# Code unchanged; tests that were not moved here were removed from this copy.\n`
        : `// Moved by api-test-agent adapt from ${file}: ${mine.map((t) => t.title).join(', ')}.\n// Code unchanged; tests that were not moved here were removed from this copy.\n`;
      changes.push({ path: target, action: 'create', content: header + content, reason: `${mine.length} test(s) from ${file}` });
    }
    const moved = [...groups.values()].flat();
    if (!staying.length) changes.push({ path: file, action: 'delete', reason: `all ${moved.length} test(s) moved` });
    else changes.push({ path: file, action: 'rewrite', content: removeRanges(src, moved.map((t) => t.range!)), reason: `${moved.length} moved, ${staying.length} stay` });
  }
}

/* ------------------------------------------------------------------ Postman conversion */

const VAR = /\{\{\s*[\w.-]+\s*\}\}/;

function convertible(r: PostmanRequest, statusesFromSpec: string[]): string | undefined {
  if (r.consumes.length) return `uses variables set elsewhere ({{${r.consumes.join('}}, {{')}}}): needs a precondition, use generate or the skill`;
  if (r.body && VAR.test(r.body)) return 'body contains {{variables}}';
  if (r.headers.some((h) => VAR.test(h.value)) || r.query.some((q) => VAR.test(q.value))) return 'headers or query contain {{variables}}';
  if (r.body) {
    try {
      JSON.parse(r.body);
    } catch {
      return 'body is not JSON';
    }
  }
  if (!r.statuses.length && !statusesFromSpec.length) return 'no status assertion in Postman and the operation is not in the spec';
  return undefined;
}

function renderPostmanTs(c: PostmanCollection, key: string, kind: string, reqs: { r: PostmanRequest; statuses: number[]; source: string }[]): string {
  const L = [
    `// Converted from Postman by api-test-agent adapt. Collection: ${c.name} (${c.source}).`,
    '// Only status assertions are converted; other pm.test lines are kept as comments for review.',
    "import { test, expect } from '@playwright/test';",
    '',
    `test.describe('${key} · ${kind} (from Postman)', () => {`,
  ];
  for (const { r, statuses, source } of reqs) {
    const opts: string[] = [];
    if (r.body) opts.push(`data: ${JSON.stringify(JSON.parse(r.body))}`);
    if (r.headers.length) opts.push(`headers: ${JSON.stringify(Object.fromEntries(r.headers.map((h) => [h.key, h.value])))}`);
    if (r.query.length) opts.push(`params: ${JSON.stringify(Object.fromEntries(r.query.map((q) => [q.key, q.value])))}`);
    L.push(`  test(${JSON.stringify(r.name)}, async ({ request }) => {`);
    L.push(`    const res = await request.${r.method.toLowerCase()}(${JSON.stringify(r.path.replace(/^\//, ''))}${opts.length ? `, { ${opts.join(', ')} }` : ''});`);
    L.push(statuses.length === 1 ? `    expect(res.status()).toBe(${statuses[0]}); // ${source}` : `    expect([${statuses.join(', ')}]).toContain(res.status()); // ${source}`);
    const rest = r.testScript.filter((l) => l.trim() && !/to\.have\.status|response\.code\)|responseCode\.code/.test(l));
    if (rest.length) L.push('    // Not converted, review:', ...rest.map((l) => `    // ${l.trim()}`));
    L.push('  });');
  }
  L.push('});');
  return L.join('\n') + '\n';
}

function renderPostmanPy(c: PostmanCollection, key: string, kind: string, reqs: { r: PostmanRequest; statuses: number[]; source: string }[]): string {
  const L = [
    `"""${key} · ${kind} cases converted from Postman by api-test-agent adapt.`,
    '',
    `Collection: ${c.name} (${c.source}). Only status assertions are converted; other pm.test lines are kept as comments.`,
    'Settings: API_BASE_URL and optional API_TOKEN from the environment (.env is loaded by the generated conftest.py, if present).',
    '"""',
    'import os',
    '',
    'import requests',
    '',
    'BASE_URL = os.environ.get("API_BASE_URL", "").rstrip("/") + "/"',
    'AUTH = {"Authorization": f"Bearer {os.environ[\'API_TOKEN\']}"} if os.environ.get("API_TOKEN") else {}',
    '',
  ];
  const used = new Set<string>();
  for (const { r, statuses, source } of reqs) {
    let fn = `test_${pyName(r.name.toLowerCase()).replace(/_+/g, '_').replace(/^_|_$/g, '') || 'request'}`;
    while (used.has(fn)) fn += '_2';
    used.add(fn);
    const args = [`BASE_URL + ${JSON.stringify(r.path.replace(/^\//, ''))}`];
    if (r.body) args.push(`json=${pyLit(JSON.parse(r.body), 4)}`);
    args.push(r.headers.length ? `headers={**AUTH, **${pyLit(Object.fromEntries(r.headers.map((h) => [h.key, h.value])), 4)}}` : 'headers=AUTH');
    if (r.query.length) args.push(`params=${pyLit(Object.fromEntries(r.query.map((q) => [q.key, q.value])), 4)}`);
    args.push('timeout=30');
    L.push('', `def ${fn}():`, `    """${r.name.replace(/"/g, "'")}"""`);
    L.push(`    res = requests.${r.method.toLowerCase()}(${args.join(', ')})`);
    L.push(statuses.length === 1 ? `    assert res.status_code == ${statuses[0]}, f"got {res.status_code}"  # ${source}` : `    assert res.status_code in (${statuses.join(', ')}), f"got {res.status_code}"  # ${source}`);
    const rest = r.testScript.filter((l) => l.trim() && !/to\.have\.status|response\.code\)|responseCode\.code/.test(l));
    if (rest.length) L.push('    # Not converted, review:', ...rest.map((l) => `    # ${l.trim()}`));
  }
  return L.join('\n') + '\n';
}

function planPostman(root: string, analysis: Analysis, ops: Operation[], testsDir: string, lang: 'typescript' | 'python', changes: FileChange[], skipped: Skipped[]): void {
  const tested = new Set(analysis.coverage.filter((r) => r.positiveTests.length || r.negativeTests.length).map((r) => r.operation));
  const files = new Map<string, { c: PostmanCollection; key: string; kind: string; reqs: { r: PostmanRequest; statuses: number[]; source: string }[] }>();
  for (const c of analysis.postman) {
    for (const r of c.requests) {
      const key = matchOperation(r.method, r.path, ops);
      if (tested.has(key)) continue; // already covered by an existing test
      const op = ops.find((x) => x.key === key);
      const specStatuses = op ? op.responses.map((x) => x.status).filter((s) => /^2\d\d$/.test(s)) : [];
      const why = convertible(r, specStatuses);
      if (why) {
        skipped.push({ what: `Postman "${r.name}" (${key})`, reason: why });
        continue;
      }
      const statuses = r.statuses.length ? r.statuses : specStatuses.map(Number);
      const source = r.statuses.length ? 'from pm.test' : `documented in the spec (${op!.operationId ?? key}); the Postman request had no assertion`;
      const kind = statuses.some((s) => s >= 400) ? 'negative' : 'positive';
      const pseudo = op ?? ({ method: r.method.toLowerCase(), path: key.split(' ')[1] } as Operation);
      const { resource, action } = operationFolder(pseudo);
      const dir = testsDir.replace(/\/$/, '');
      const target = lang === 'python' ? `${dir}/${pyName(resource)}/${pyName(action)}/test_${kind}_postman.py` : `${dir}/${resource}/${action}/${kind}.postman.spec.ts`;
      if (existsSync(join(root, target))) {
        skipped.push({ what: `Postman "${r.name}"`, reason: `${target} already exists` });
        continue;
      }
      const entry = files.get(target) ?? { c, key, kind, reqs: [] };
      entry.reqs.push({ r, statuses, source });
      files.set(target, entry);
    }
  }
  for (const [target, f] of files) {
    changes.push({
      path: target,
      action: 'create',
      content: lang === 'python' ? renderPostmanPy(f.c, f.key, f.kind, f.reqs) : renderPostmanTs(f.c, f.key, f.kind, f.reqs),
      reason: `${f.reqs.length} Postman request(s): ${f.reqs.map((x) => `"${x.r.name}"`).join(', ')}`,
    });
  }
}

/* ------------------------------------------------------------------ plan / apply / verify */

export function buildPlan(o: { root: string; analysis: Analysis; ops: Operation[]; testsDir: string; lang: 'typescript' | 'python'; only?: 'moves' | 'postman' }): AdaptPlan {
  const changes: FileChange[] = [];
  const skipped: Skipped[] = [];
  if (o.only !== 'postman') planMoves(o.root, o.analysis, o.ops, o.testsDir, changes, skipped);
  if (o.only !== 'moves') planPostman(o.root, o.analysis, o.ops, o.testsDir, o.lang, changes, skipped);
  // Python test folders must be packages (test_positive_x.py may repeat across folders).
  const pyDirs = new Set<string>();
  const top = o.testsDir.replace(/\/$/, '');
  for (const c of changes) {
    if (c.action !== 'create' || !c.path.endsWith('.py') || !c.path.startsWith(top + '/')) continue;
    for (let d = posix.dirname(c.path); d.length >= top.length; d = posix.dirname(d)) {
      pyDirs.add(d);
      if (d === top) break;
    }
  }
  for (const d of pyDirs) {
    const init = `${d}/__init__.py`;
    if (!existsSync(join(o.root, init))) changes.push({ path: init, action: 'create', content: '', reason: 'Python package marker' });
  }
  return { changes, skipped };
}

export function gitState(root: string): { repo: boolean; clean: boolean; dirty: string[] } {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inside.status !== 0) return { repo: false, clean: false, dirty: [] };
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const dirty = st.stdout.split('\n').filter(Boolean);
  return { repo: true, clean: dirty.length === 0, dirty };
}

export interface ApplyResult {
  verified: boolean | 'not-available';
  output: string;
  rolledBack: boolean;
}

export async function applyPlan(root: string, plan: AdaptPlan): Promise<ApplyResult> {
  const backups = new Map<string, string | null>(); // path → previous content (null: did not exist)
  for (const c of plan.changes) {
    const full = join(root, c.path);
    backups.set(c.path, existsSync(full) ? await readFile(full, 'utf8') : null);
  }
  const rollback = async () => {
    for (const [p, prev] of backups) {
      const full = join(root, p);
      if (prev === null) {
        await rm(full, { force: true });
        // Remove folders this run created and left empty.
        for (let d = dirname(full); d.length > root.length; d = dirname(d)) {
          try {
            await rmdir(d);
          } catch {
            break; // not empty (or not ours)
          }
        }
      } else {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, prev);
      }
    }
  };
  try {
    for (const c of plan.changes) {
      const full = join(root, c.path);
      if (c.action === 'delete') await rm(full, { force: true });
      else {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, c.content ?? '');
      }
    }
  } catch (e: any) {
    await rollback();
    return { verified: false, output: String(e?.message ?? e), rolledBack: true };
  }

  const touched = plan.changes.filter((c) => c.action !== 'delete' && !c.path.endsWith('__init__.py')).map((c) => c.path);
  const ts = touched.filter((p) => /\.[cm]?[jt]sx?$/.test(p));
  const py = touched.filter((p) => p.endsWith('.py'));
  let output = '';
  let ok: boolean | 'not-available' = true;
  if (ts.length) {
    const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
    if (!existsSync(cli)) ok = 'not-available';
    else {
      const r = spawnSync(process.execPath, [cli, 'test', '--list', ...ts], { cwd: root, encoding: 'utf8' });
      output += (r.stdout ?? '') + (r.stderr ?? '');
      if (r.status !== 0) ok = false;
    }
  }
  if (py.length && ok !== false) {
    const r = spawnSync(findPython(), ['-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider', ...py], { cwd: root, encoding: 'utf8' });
    if (r.error) ok = ok === true ? 'not-available' : ok;
    else {
      output += (r.stdout ?? '') + (r.stderr ?? '');
      if (r.status !== 0) ok = false;
    }
  }
  if (ok === false) {
    await rollback();
    return { verified: false, output, rolledBack: true };
  }
  return { verified: ok, output, rolledBack: false };
}

export const resolveRoot = (p: string) => toPosix(relative(process.cwd(), resolve(p)));
