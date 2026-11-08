import { parse } from '@babel/parser';

/**
 * Static analysis of existing Playwright API tests (TS/JS), no AI:
 *  - which HTTP calls each test makes (method + path template),
 *  - which call the test actually asserts on (status assertions) → positive / negative,
 *  - preconditions: hooks, fixtures and helper functions that create data,
 *  - data flow: an id from one response used in a later URL → dependency edge,
 *  - quality issues (hard-coded secrets/URLs, waits, missing cleanup, status-only checks, test-order coupling).
 */

export const HTTP = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

export interface ApiCall {
  id: number;
  method: string; // upper case
  path: string; // "/orders/{orderId}" (placeholders named after the expression)
  line: number;
  via?: string; // helper / fixture name when the call happens inside it
  cleanup: boolean; // inside finally / after* hook / cleanup-named helper
}

export interface FlowEdge {
  from: ApiCall;
  to: ApiCall;
  variable: string;
}

export interface TestCase {
  file: string;
  title: string;
  line: number;
  calls: ApiCall[];
  preconditions: ApiCall[]; // from hooks / fixtures used by this test
  asserted: { call: ApiCall; statuses: number[] }[];
  polarity: 'positive' | 'negative' | 'unknown';
  bodyAssertions: number;
  /** First and last source line of the whole test (decorators included), for moving it. */
  range?: { start: number; end: number };
  /** The test reads a value another test writes: it cannot be moved on its own. */
  dependsOnTest?: string;
}

export interface FileIssue {
  file: string;
  line?: number;
  code: 'hardcoded-secret' | 'hardcoded-url' | 'wait-for-timeout' | 'no-cleanup' | 'status-only' | 'order-dependent' | 'no-assertion' | 'parse-error';
  message: string;
}

export interface ParsedTests {
  tests: TestCase[];
  edges: FlowEdge[];
  issues: FileIssue[];
}

interface Helper {
  name: string;
  calls: ApiCall[];
  returns?: ApiCall;
}

type Node = any;

function parseSource(src: string): Node {
  return parse(src, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'], errorRecovery: true, allowReturnOutsideFunction: true });
}

function walk(node: Node, visit: (n: Node, parents: Node[]) => boolean | void, parents: Node[] = []): void {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parents) === false) return;
  const next = [...parents, node];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, visit, next);
    else if (v && typeof v.type === 'string') walk(v, visit, next);
  }
}

const identifiersIn = (node: Node): string[] => {
  const out: string[] = [];
  walk(node, (n) => {
    if (n.type === 'Identifier') out.push(n.name);
  });
  return out;
};

const calleeName = (callee: Node): string | undefined => {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier') return callee.property.name;
  return undefined;
};

const calleePath = (callee: Node): string[] => {
  if (callee?.type === 'Identifier') return [callee.name];
  if (callee?.type === 'MemberExpression') return [...calleePath(callee.object), callee.property?.name ?? '?'];
  return [];
};

function urlTemplate(node: Node, src: string): string | undefined {
  if (!node) return undefined;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    let s = '';
    node.quasis.forEach((q: Node, i: number) => {
      s += q.value.cooked ?? q.value.raw;
      const e = node.expressions[i];
      if (e) s += `{${src.slice(e.start, e.end).replace(/^encodeURIComponent\((.*)\)$/, '$1')}}`;
    });
    return s;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = urlTemplate(node.left, src) ?? `{${src.slice(node.left.start, node.left.end)}}`;
    const r = urlTemplate(node.right, src) ?? `{${src.slice(node.right.start, node.right.end)}}`;
    return l + r;
  }
  return undefined;
}

/** "/orders/{created.id}?x=1" or "https://h/api/orders" → "/orders/{created.id}" (origin, base-URL placeholders and query removed). */
export function normalizeUrl(raw: string): string {
  let p = raw.replace(/^https?:\/\/[^/]+/i, '').replace(/^\{[^}]*\}(?=\/)/, '').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '') || '/';
}

const REQUESTISH = /request|api|ctx|context|client|http|req/i;
const NOT_REQUEST = new Set(['page', 'map', 'headers', 'searchParams', 'params', 'cache', 'Map', 'URLSearchParams', 'localStorage', 'cookies']);

export class PlaywrightAnalyzer {
  private helpers = new Map<string, Helper>();
  private nextId = 1;

  /** Pass 1: index helper functions and fixtures from every file (support and test files). */
  indexHelpers(file: string, src: string): void {
    let ast: Node;
    try {
      ast = parseSource(src);
    } catch {
      return;
    }
    const add = (name: string, fn: Node, isFixture = false) => {
      if (!name || !fn?.body) return;
      const scope = this.analyzeFunction(fn, src, file, name, new Map(), [], isFixture);
      if (scope.calls.length) this.helpers.set(name, { name, calls: scope.calls, returns: scope.returns ?? scope.calls.find((c) => c.method === 'POST') ?? scope.calls[scope.calls.length - 1] });
    };
    walk(ast, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id) add(n.id.name, n);
      else if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && /Function|ArrowFunction/.test(n.init?.type ?? '')) add(n.id.name, n.init);
      else if ((n.type === 'ObjectMethod' || n.type === 'ClassMethod') && n.key?.type === 'Identifier') add(n.key.name, n);
      else if (n.type === 'ObjectProperty' && n.key?.type === 'Identifier' && /Function|ArrowFunction/.test(n.value?.type ?? '')) add(n.key.name, n.value);
      // test.extend({ order: async ({ request }, use) => {...} })
      if (n.type === 'CallExpression' && calleeName(n.callee) === 'extend' && n.arguments[0]?.type === 'ObjectExpression') {
        for (const p of n.arguments[0].properties) {
          const fn = p.type === 'ObjectMethod' ? p : p.value;
          if (p.key?.type === 'Identifier' && fn) add(p.key.name, fn, true);
        }
        return false;
      }
    });
  }

  /** Analyse one function body. `taint` maps variable name → the call its value came from. */
  private analyzeFunction(fn: Node, src: string, file: string, via: string | undefined, taint: Map<string, ApiCall>, edges: FlowEdge[], isFixture = false, cleanupCtx = false) {
    const calls: ApiCall[] = [];
    const asserted: { call: ApiCall; statuses: number[] }[] = [];
    let bodyAssertions = 0;
    let returns: ApiCall | undefined;
    const assignedOuter = new Set<string>();
    const readVars = new Set<string>();
    const locals = new Set<string>();
    for (const p of fn.params ?? []) for (const id of identifiersIn(p)) locals.add(id);

    const sourceOf = (node: Node): ApiCall | undefined => {
      let found: ApiCall | undefined;
      walk(node, (n) => {
        if (found) return false;
        if (n.type === 'CallExpression' && (n as any).__call) found = (n as any).__call;
        if (n.type === 'Identifier' && taint.has(n.name)) found = taint.get(n.name);
      });
      return found;
    };

    const visit = (n: Node, parents: Node[]): boolean | void => {
      const inFinally = parents.some((p, i) => p.type === 'TryStatement' && parents[i + 1] === p.finalizer);

      if (n.type === 'CallExpression') {
        const path = calleePath(n.callee);
        const name = path[path.length - 1];
        const obj = path[path.length - 2];

        // Direct HTTP call: request.get(url) / api.post(url) / ctx.fetch(url, { method })
        if (path.length >= 2 && (HTTP as readonly string[]).includes(name) || name === 'fetch') {
          const url = urlTemplate(n.arguments[0], src);
          const plausible = url && !NOT_REQUEST.has(obj) && (REQUESTISH.test(obj ?? '') || url.includes('/'));
          if (plausible) {
            let method = name === 'fetch' ? 'GET' : name.toUpperCase();
            if (name === 'fetch') {
              const opt = n.arguments[1];
              const m = opt?.properties?.find((p: Node) => p.key?.name === 'method');
              if (m?.value?.type === 'StringLiteral') method = m.value.value.toUpperCase();
            }
            const call: ApiCall = { id: this.nextId++, method, path: normalizeUrl(url!), line: n.loc?.start.line ?? 0, via, cleanup: cleanupCtx || inFinally };
            calls.push(call);
            (n as any).__call = call;
            for (const id of identifiersIn(n.arguments[0])) {
              readVars.add(id);
              const src2 = taint.get(id);
              if (src2 && src2 !== call) edges.push({ from: src2, to: call, variable: id });
            }
            return false;
          }
        }

        // Helper or fixture call: createOrder(request) / api.orders.create()
        const helper = name ? this.helpers.get(name) : undefined;
        if (helper && name !== via) {
          const cleanup = cleanupCtx || inFinally || /delete|remove|cleanup|teardown|destroy/i.test(name);
          const copies = helper.calls.map((c) => ({ ...c, id: this.nextId++, via: name, cleanup: cleanup || c.cleanup }));
          // Variables passed to the helper flow into its calls (e.g. deleteOrder(request, orderId)).
          for (const arg of n.arguments) {
            for (const id of identifiersIn(arg)) {
              const s = taint.get(id);
              if (s) for (const c of copies) if (/\{/.test(c.path)) edges.push({ from: s, to: c, variable: id });
            }
          }
          calls.push(...copies);
          const ret = helper.returns ? copies[helper.calls.indexOf(helper.returns)] : undefined;
          if (ret) (n as any).__call = ret;
        }

        // Fixture value: use(x)
        if (isFixture && name === 'use' && n.arguments[0]) {
          returns = sourceOf(n.arguments[0]) ?? returns;
        }

        // Assertions
        if (name && /^(toBe|toEqual|toStrictEqual|toContain|toBeOK|toBeTruthy|toHaveStatus)$/.test(name)) {
          const expectCall = findExpect(n.callee);
          if (expectCall) {
            const subject = expectCall.arguments[0];
            const subjText = subject ? src.slice(subject.start, subject.end) : '';
            const statusLike = /status|\.ok\(\)/.test(subjText) || name === 'toBeOK';
            const nums = statusNumbers(name === 'toContain' ? subject : n.arguments[0]);
            const target = sourceOf(name === 'toContain' ? n.arguments[0] : subject);
            if (statusLike || (name === 'toContain' && /status/.test(src.slice(n.arguments[0]?.start, n.arguments[0]?.end)))) {
              if (target) asserted.push({ call: target, statuses: nums.length ? nums : name === 'toBeOK' || /ok\(\)/.test(subjText) ? [200] : [] });
            } else bodyAssertions++;
          }
        }
        // Contract helpers from api-test-agent count as body assertions with a status.
        if (name === 'expectContract' || name === 'expectRejected') {
          bodyAssertions++;
          const target = sourceOf(n.arguments[0]);
          if (target && name === 'expectRejected') asserted.push({ call: target, statuses: [400] });
          else if (target && !asserted.some((a) => a.call === target)) asserted.push({ call: target, statuses: [200] });
        }
      }

      // Data flow: const x = await request.post(...) / const { id } = await res.json() / orderId = body.id
      if (n.type === 'VariableDeclarator' || n.type === 'AssignmentExpression') {
        const target = n.type === 'VariableDeclarator' ? n.id : n.left;
        const value = n.type === 'VariableDeclarator' ? n.init : n.right;
        if (n.type === 'VariableDeclarator') for (const id of identifiersIn(target)) locals.add(id);
        else if (target.type === 'Identifier' && !locals.has(target.name)) assignedOuter.add(target.name);
        if (value) {
          walk(value, (c, ps) => visit(c, [...parents, n, ...ps]));
          const s = sourceOf(value);
          // this.orderId = body.id / ctx.orderId = ... → taint the property name, which later URLs reference.
          const names = target.type === 'MemberExpression' ? [target.property?.name].filter(Boolean) : identifiersIn(target);
          if (s) for (const id of names) taint.set(id, s);
        }
        return false;
      }
      if (n.type === 'ReturnStatement' && n.argument) {
        walk(n.argument, (c, ps) => visit(c, [...parents, n, ...ps]));
        returns = sourceOf(n.argument) ?? returns;
        return false;
      }
    };
    walk(fn.body, visit);
    return { calls, asserted, bodyAssertions, returns, assignedOuter, readVars };
  }

  /** Pass 2: analyse test files. */
  analyzeTestFile(file: string, src: string): ParsedTests {
    const issues: FileIssue[] = [];
    let ast: Node;
    try {
      ast = parseSource(src);
    } catch (e: any) {
      return { tests: [], edges: [], issues: [{ file, code: 'parse-error', message: String(e?.message ?? e) }] };
    }
    const edges: FlowEdge[] = [];
    const taint = new Map<string, ApiCall>(); // file/describe scope (variables set in hooks)
    const hookCalls: ApiCall[] = [];
    const tests: TestCase[] = [];
    const writersByVar = new Map<string, string>(); // outer variable → test that assigned it

    const fnArg = (n: Node) => [...n.arguments].reverse().find((a: Node) => /Function|ArrowFunction/.test(a.type));
    const titleOf = (n: Node) => (n.arguments[0]?.type === 'StringLiteral' ? n.arguments[0].value : n.arguments[0]?.type === 'TemplateLiteral' ? src.slice(n.arguments[0].start + 1, n.arguments[0].end - 1) : '(untitled)');

    const visitScope = (body: Node, prefix: string[]) => {
      walk(body, (n) => {
        if (n.type !== 'CallExpression') return;
        const path = calleePath(n.callee);
        const head = path[0];
        if (!/^(test|it|describe)$/.test(head ?? '')) return;
        const last = path[path.length - 1];
        const fn = fnArg(n);
        if (!fn) return false;

        if (head === 'describe' || path.includes('describe')) {
          visitScope(fn.body, [...prefix, titleOf(n)]);
          return false;
        }
        if (/^(beforeAll|beforeEach|afterAll|afterEach)$/.test(last)) {
          const r = this.analyzeFunction(fn, src, file, undefined, taint, edges, false, last.startsWith('after'));
          hookCalls.push(...r.calls);
          return false;
        }
        if (['test', 'it', 'only', 'skip', 'fixme', 'fail', 'slow'].includes(last) || path.length === 1) {
          const local = new Map(taint);
          // Fixtures destructured from the test arguments: ({ request, order }) → precondition calls of `order`.
          const pre: ApiCall[] = [...hookCalls.filter((c) => !c.cleanup)];
          for (const p of fn.params?.[0]?.properties ?? []) {
            const name: string | undefined = p.key?.name ?? p.value?.name;
            const h: Helper | undefined = name ? this.helpers.get(name) : undefined;
            if (name && h) {
              const copies = h.calls.map((c: ApiCall) => ({ ...c, id: this.nextId++, via: name }));
              pre.push(...copies);
              const ret = h.returns ? copies[h.calls.indexOf(h.returns)] : undefined;
              if (ret) local.set(name, ret);
            }
          }
          const r = this.analyzeFunction(fn, src, file, undefined, local, edges);
          const title = [...prefix, titleOf(n)].join(' > ');
          for (const v of r.assignedOuter) writersByVar.set(v, title);
          let dependsOnTest: string | undefined;
          for (const v of r.readVars) {
            const w = writersByVar.get(v);
            if (w && w !== title) {
              dependsOnTest = w;
              issues.push({ file, line: n.loc?.start.line, code: 'order-dependent', message: `"${title}" uses "${v}" set by another test ("${w}"): it fails when run alone or in parallel.` });
            }
          }
          // Polarity follows the FIRST asserted call (the action under test). A later 404 check
          // ("gone after delete") verifies a positive action, it does not make the test negative.
          const first = r.asserted[0]?.statuses ?? [];
          const negative = first.some((s) => s >= 400 && s < 500);
          const positive = first.some((s) => s >= 200 && s < 300);
          const tc: TestCase = {
            file,
            title,
            line: n.loc?.start.line ?? 0,
            range: { start: n.loc?.start.line ?? 0, end: n.loc?.end.line ?? 0 },
            calls: r.calls,
            preconditions: pre,
            asserted: r.asserted,
            polarity: negative ? 'negative' : positive ? 'positive' : 'unknown',
            bodyAssertions: r.bodyAssertions,
            dependsOnTest,
          };
          if (r.calls.length && !r.asserted.length && !r.bodyAssertions) issues.push({ file, line: tc.line, code: 'no-assertion', message: `"${title}" calls the API but asserts nothing.` });
          else if (r.calls.length && r.asserted.length && !r.bodyAssertions && !negative) issues.push({ file, line: tc.line, code: 'status-only', message: `"${title}" checks only the status code, not the response body.` });
          tests.push(tc);
          return false;
        }
      });
    };
    visitScope(ast.program, []);

    // File-level issues.
    walk(ast, (n) => {
      if (n.type === 'CallExpression' && calleeName(n.callee) === 'waitForTimeout') issues.push({ file, line: n.loc?.start.line, code: 'wait-for-timeout', message: 'waitForTimeout: fixed sleep, use a condition (expect.poll) instead.' });
      if (n.type === 'StringLiteral' || n.type === 'TemplateElement') {
        const v = n.type === 'StringLiteral' ? n.value : n.value.raw;
        if (/Bearer\s+[A-Za-z0-9._~+/-]{12,}/.test(v) || /^(sk|pk|api|key|token)[-_][A-Za-z0-9]{16,}$/.test(v)) issues.push({ file, line: n.loc?.start.line, code: 'hardcoded-secret', message: 'Hard-coded token/key: read it from an environment variable.' });
        if (/^https?:\/\/(?!localhost|127\.0\.0\.1)[\w.-]+/.test(v)) issues.push({ file, line: n.loc?.start.line, code: 'hardcoded-url', message: `Hard-coded URL ${v.slice(0, 60)}: use baseURL / API_BASE_URL.` });
      }
    });
    const all = [...hookCalls, ...tests.flatMap((t) => t.calls)];
    // A create that the test expects to be REJECTED (4xx) creates nothing.
    const rejected = new Set(tests.flatMap((t) => t.asserted.filter((x) => x.statuses.length && x.statuses.every((s) => s >= 400)).map((x) => x.call)));
    const creates = all.filter((c) => c.method === 'POST' && !c.cleanup && !rejected.has(c));
    if (creates.length && !all.some((c) => c.method === 'DELETE')) {
      issues.push({ file, line: creates[0].line, code: 'no-cleanup', message: `Creates data (${creates[0].method} ${creates[0].path}) but never deletes it: leftovers accumulate and tests interfere.` });
    }
    return { tests, edges, issues: dedupeIssues(issues) };
  }
}

function findExpect(callee: Node): Node | undefined {
  let n = callee;
  while (n?.type === 'MemberExpression') n = n.object;
  if (n?.type === 'CallExpression') {
    const name = calleePath(n.callee)[0];
    if (name === 'expect') return n;
    return findExpect(n.callee);
  }
  return undefined;
}

function statusNumbers(node: Node): number[] {
  const out: number[] = [];
  walk(node, (n) => {
    if (n.type === 'NumericLiteral' && n.value >= 100 && n.value < 600) out.push(n.value);
  });
  return out;
}

function dedupeIssues(issues: FileIssue[]): FileIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}:${i.line}:${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
