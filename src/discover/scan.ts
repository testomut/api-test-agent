import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export type TestKind =
  | 'playwright-api'
  | 'playwright-ui'
  | 'cypress'
  | 'jest-or-vitest-api'
  | 'pytest-api'
  | 'postman-collection'
  | 'other-test';

export interface FoundFile {
  path: string; // relative to the project root, posix separators
  kind: TestKind;
  /** Analysed in depth (request extraction + dependency map). Other kinds are only listed. */
  analysable: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'playwright-report', 'test-results', 'reports', '.next', '.claude']);
const TEST_FILE = /(\.(spec|test)\.[cm]?[jt]sx?$)|(\.cy\.[jt]sx?$)|(^test_.*\.py$)|(_test\.py$)/;
const SUPPORT_FILE = /\.[cm]?[jt]s$/;
const POSTMAN_FILE = /\.postman_collection\.json$|collection.*\.json$/i;

async function walk(root: string, dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 12) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(root, join(dir, entry.name), out, depth + 1);
    } else out.push(relative(root, join(dir, entry.name)).replace(/\\/g, '/'));
  }
}

export function classify(path: string, src: string): TestKind | undefined {
  const name = path.split('/').pop()!;
  if (name.endsWith('.json')) {
    return /"_postman_id"|"schema"\s*:\s*"https:\/\/schema\.getpostman\.com/.test(src) ? 'postman-collection' : undefined;
  }
  if (!TEST_FILE.test(name)) return undefined;
  if (name.endsWith('.py')) return /\b(requests|httpx)\.|\b(client|api|session|anonymous_api)\.(get|post|put|patch|delete)\(/.test(src) ? 'pytest-api' : 'other-test';
  if (/\.cy\.[jt]sx?$/.test(name) || /\bcy\.(request|visit|get)\(/.test(src)) return 'cypress';
  if (/from\s+['"]@playwright\/test['"]|require\(['"]@playwright\/test['"]\)/.test(src)) {
    const api = /\brequest\s*[,}]|APIRequestContext|request\.newContext|\brequest\.(get|post|put|patch|delete|head|fetch)\(/.test(src);
    const ui = /\bpage\.(goto|click|locator|getBy\w+|fill)\(|\{\s*page\b|\bpage\s*[,}]/.test(src);
    return api && !ui ? 'playwright-api' : ui ? 'playwright-ui' : 'other-test';
  }
  if (/\b(supertest|axios|fetch)\b/.test(src) && /\b(describe|it|test)\(/.test(src)) return 'jest-or-vitest-api';
  return 'other-test';
}

export interface ScanResult {
  tests: FoundFile[];
  /** Non-test TS/JS files that test files may import (helpers, fixtures). */
  supportFiles: string[];
  /** Non-test Python files (conftest.py, helpers, API clients). */
  pythonSupport: string[];
}

export async function scanProject(root: string): Promise<ScanResult> {
  const all: string[] = [];
  await walk(root, root, all);
  const tests: FoundFile[] = [];
  const supportFiles: string[] = [];
  const pythonSupport: string[] = [];
  for (const path of all) {
    const name = path.split('/').pop()!;
    const isTest = TEST_FILE.test(name);
    const maybePostman = POSTMAN_FILE.test(name);
    if (!isTest && !maybePostman) {
      if (SUPPORT_FILE.test(name) && !name.endsWith('.d.ts') && !/config\.[cm]?[jt]s$/.test(name)) supportFiles.push(path);
      if (name.endsWith('.py') && name !== '__init__.py' && name !== 'setup.py' && !path.includes('site-packages/')) pythonSupport.push(path);
      continue;
    }
    const full = join(root, path);
    if ((await stat(full)).size > 5_000_000) continue;
    const kind = classify(path, await readFile(full, 'utf8'));
    if (kind) tests.push({ path, kind, analysable: kind === 'playwright-api' || kind === 'pytest-api' || kind === 'postman-collection' });
  }
  return { tests, supportFiles, pythonSupport };
}
