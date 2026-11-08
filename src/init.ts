import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ENV_KEYS, readEnvFile, type EnvKey } from './config.js';

export interface InitAnswers {
  baseUrl?: string;
  specUrl?: string;
  postman?: string;
  testsDir?: string;
  needsToken?: boolean;
}

export interface InitResult {
  created: string[];
  updated: string[];
  kept: string[];
  todo: string[];
}

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url)); // src/ or dist/ → package root
const GITIGNORE_BLOCK = ['# api-test-agent', '.env', 'reports/', 'test-results/', 'playwright-report/'];

export async function askAnswers(defaults: InitAnswers): Promise<InitAnswers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string) => ((await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def || undefined);
  try {
    console.log('\napi-test-agent setup. Secrets are never asked here: you will paste them into .env yourself.\n');
    let baseUrl: string | undefined;
    while (!baseUrl) {
      baseUrl = await ask('1/5 Base URL of the TEST environment (e.g. https://api.test.example.com)', defaults.baseUrl);
      if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
        console.log('   Must start with http:// or https://');
        baseUrl = undefined;
      }
    }
    const specUrl = await ask('2/5 OpenAPI/Swagger URL or file (Enter = auto-detect)', defaults.specUrl);
    const postman = await ask('3/5 Postman collection: exported .json path or cloud collection id (Enter = none)', defaults.postman);
    const testsDir = await ask('4/5 Folder for API tests', defaults.testsDir ?? 'tests/api');
    const token = await ask('5/5 Does the API need a token? (y/N)', defaults.needsToken ? 'y' : 'n');
    return { baseUrl, specUrl, postman, testsDir, needsToken: /^y/i.test(token ?? '') };
  } finally {
    rl.close();
  }
}

function envBody(values: Partial<Record<EnvKey, string>>, withComments: boolean): string {
  const lines: string[] = [];
  for (const k of Object.keys(ENV_KEYS) as EnvKey[]) {
    if (withComments) lines.push(`# ${ENV_KEYS[k]}`);
    lines.push(`${k}=${values[k] ?? ''}`);
    if (withComments) lines.push('');
  }
  return lines.join('\n') + '\n';
}

const PLAYWRIGHT_CONFIG = (testsDir: string) => `import { defineConfig } from '@playwright/test';

// Settings come from .env (created by api-test-agent init) or from CI environment variables.
try {
  process.loadEnvFile();
} catch {
  /* no .env: rely on the real environment */
}

const extraHTTPHeaders: Record<string, string> = { accept: 'application/json' };
if (process.env.API_TOKEN) extraHTTPHeaders.authorization = \`Bearer \${process.env.API_TOKEN}\`;

export default defineConfig({
  testDir: '${testsDir}',
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: (process.env.API_BASE_URL ?? '').replace(/\\/?$/, '/'),
    extraHTTPHeaders,
  },
});
`;

export async function initProject(root: string, a: InitAnswers, opts: { force?: boolean } = {}): Promise<InitResult> {
  const r: InitResult = { created: [], updated: [], kept: [], todo: [] };
  const testsDir = (a.testsDir ?? 'tests/api').replace(/\\/g, '/').replace(/\/$/, '');
  const cloudPostman = !!a.postman && !/\.json$/i.test(a.postman);
  const values: Partial<Record<EnvKey, string>> = {
    API_BASE_URL: a.baseUrl,
    API_SPEC_URL: a.specUrl,
    POSTMAN_COLLECTION: a.postman,
    API_TESTS_DIR: testsDir,
  };

  // .env: create, or add only missing keys. Existing values are never overwritten.
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) {
    await writeFile(envPath, envBody(values, false));
    r.created.push('.env');
  } else {
    const current = readEnvFile(root);
    const missing = (Object.keys(ENV_KEYS) as EnvKey[]).filter((k) => !(k in current));
    if (missing.length) {
      const text = readFileSync(envPath, 'utf8');
      await writeFile(envPath, text + (text.endsWith('\n') ? '' : '\n') + missing.map((k) => `${k}=${values[k] ?? ''}`).join('\n') + '\n');
      r.updated.push(`.env (+${missing.join(', ')})`);
    } else r.kept.push('.env');
  }
  const env = readEnvFile(root);
  if (a.needsToken && !env.API_TOKEN) r.todo.push('Paste your TEST token into .env: API_TOKEN=...');
  if (cloudPostman && !env.POSTMAN_API_KEY) r.todo.push('Postman cloud collection: paste your Postman API key into .env: POSTMAN_API_KEY=... (postman.com → Settings → API keys)');

  // .env.example: safe to commit, documents every variable.
  const examplePath = join(root, '.env.example');
  if (!existsSync(examplePath) || opts.force) {
    await writeFile(examplePath, envBody({ API_TESTS_DIR: testsDir }, true));
    r.created.push('.env.example');
  } else r.kept.push('.env.example');

  // .gitignore: append missing lines, never remove anything.
  const giPath = join(root, '.gitignore');
  const gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const have = new Set(gi.split(/\r?\n/).map((l) => l.trim()));
  const add = GITIGNORE_BLOCK.filter((l) => !have.has(l) && !(l === '.env' && have.has('/.env')));
  if (add.length && !(add.length === 1 && add[0] === '# api-test-agent')) {
    await writeFile(giPath, gi + (gi && !gi.endsWith('\n') ? '\n' : '') + (gi ? '\n' : '') + add.join('\n') + '\n');
    (gi ? r.updated : r.created).push(`.gitignore (+${add.filter((l) => !l.startsWith('#')).join(', ')})`);
  } else r.kept.push('.gitignore');

  // playwright.config: create only when the project has none.
  const existing = ['ts', 'js', 'mjs', 'cjs'].map((e) => `playwright.config.${e}`).find((f) => existsSync(join(root, f)));
  if (!existing) {
    await writeFile(join(root, 'playwright.config.ts'), PLAYWRIGHT_CONFIG(testsDir));
    r.created.push('playwright.config.ts');
  } else {
    r.kept.push(existing);
    const cfg = readFileSync(join(root, existing), 'utf8');
    if (!/API_BASE_URL/.test(cfg)) r.todo.push(`${existing} exists and was not changed: set use.baseURL from process.env.API_BASE_URL and make sure testDir includes ${testsDir}.`);
  }

  // API tests folder
  if (!existsSync(join(root, testsDir))) {
    await mkdir(join(root, testsDir), { recursive: true });
    r.created.push(`${testsDir}/`);
  }

  // Claude Code skill
  const skillSrc = join(PKG_ROOT, 'skills', 'api-test-writer');
  const skillDst = join(root, '.claude', 'skills', 'api-test-writer');
  if (existsSync(skillSrc)) {
    const dstFile = join(skillDst, 'SKILL.md');
    const same = existsSync(dstFile) && readFileSync(dstFile, 'utf8') === readFileSync(join(skillSrc, 'SKILL.md'), 'utf8');
    if (same) r.kept.push('.claude/skills/api-test-writer');
    else if (existsSync(dstFile) && !opts.force) {
      r.kept.push('.claude/skills/api-test-writer (local changes kept; --force to replace)');
    } else {
      await mkdir(skillDst, { recursive: true });
      await cp(skillSrc, skillDst, { recursive: true });
      r.created.push('.claude/skills/api-test-writer');
    }
  }

  // package.json scripts + dependency check
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) r.todo.push('No package.json: run `npm init -y` and `npm i -D @playwright/test @testomut/api-test-agent ajv ajv-formats`.');
  else {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.scripts ??= {};
    const scripts: Record<string, string> = {
      'api-tests': 'api-test-agent run',
      'api-tests:generate': 'api-test-agent generate --allow-write --run',
      'test:api': 'playwright test',
    };
    const added = Object.entries(scripts).filter(([k]) => !pkg.scripts[k]);
    for (const [k, v] of added) pkg.scripts[k] = v;
    if (added.length) {
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      r.updated.push(`package.json scripts (+${added.map(([k]) => k).join(', ')})`);
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const missing = ['@playwright/test', 'ajv', 'ajv-formats'].filter((d) => !deps[d]);
    if (missing.length) r.todo.push(`Install: npm i -D ${missing.join(' ')}`);
  }
  return r;
}
