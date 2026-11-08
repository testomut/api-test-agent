import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPython } from '../generate/generate.js';
import { normalizeUrl, type ApiCall, type FileIssue, type ParsedTests, type TestCase } from './playwright-tests.js';

const SCRIPT = fileURLToPath(new URL('../../src/discover/pytest_analyzer.py', import.meta.url));

interface RawCall {
  id: number;
  method: string;
  path: string;
  line: number;
  via?: string | null;
  cleanup: boolean;
}

/**
 * Runs the stdlib-only Python analyser (ast) over pytest files and maps its output onto the
 * same structures the Playwright analyser produces, so maps and reports are language-agnostic.
 */
export async function analyzePytest(root: string, tests: string[], support: string[]): Promise<ParsedTests & { error?: string }> {
  if (!tests.length) return { tests: [], edges: [], issues: [] };
  const python = findPython();
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((done) => {
    const child = spawn(python, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done({ stdout: '', stderr: String(e), code: null }));
    child.on('close', (c) => done({ stdout: out, stderr: err, code: c }));
    child.stdin.end(JSON.stringify({ root, tests, support }));
  });
  if (code !== 0 || !stdout.trim()) {
    const error = `pytest tests were listed but not analysed: Python is not available or failed (${python}: ${stderr.trim().split('\n').pop() ?? 'no output'}). Set API_TESTS_PYTHON to a Python 3.9+ interpreter.`;
    return { tests: [], edges: [], issues: tests.map((file) => ({ file, code: 'parse-error', message: error })), error };
  }

  const raw = JSON.parse(stdout) as { tests: any[]; edges: { from: number; to: number; variable: string }[]; issues: FileIssue[] };
  const byId = new Map<number, ApiCall>();
  const toCall = (c: RawCall): ApiCall => {
    const call: ApiCall = { id: c.id, method: c.method, path: normalizeUrl(c.path), line: c.line, via: c.via ?? undefined, cleanup: c.cleanup };
    byId.set(c.id, call);
    return call;
  };
  const parsed: TestCase[] = raw.tests.map((t) => {
    const calls = (t.calls as RawCall[]).map(toCall);
    const preconditions = (t.preconditions as RawCall[]).map(toCall);
    return {
      file: t.file,
      title: t.title,
      line: t.line,
      calls,
      preconditions,
      asserted: (t.asserted as { call: number; statuses: number[] }[]).filter((a) => byId.has(a.call)).map((a) => ({ call: byId.get(a.call)!, statuses: a.statuses })),
      polarity: t.polarity,
      bodyAssertions: t.bodyAssertions,
      range: t.range,
      dependsOnTest: t.dependsOnTest ?? undefined,
    };
  });
  // Edges reference calls by id; calls inside helpers/fixtures used only for indexing are not in any test.
  const edges = raw.edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map((e) => ({ from: byId.get(e.from)!, to: byId.get(e.to)!, variable: e.variable }));
  return { tests: parsed, edges, issues: raw.issues };
}
