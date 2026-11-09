/**
 * Playwright fixtures for generated API tests: test account, authentication and API objects.
 *
 * Copied verbatim by api-test-agent into tests/api/_support/ (self-contained).
 *
 * Fixtures for tests:
 *  - api        API objects (_support/api) with the test account's credentials.
 *  - publicApi  the same API objects without any credentials (public operations, 401 checks).
 *  - request    an authenticated APIRequestContext, for anything the API objects do not cover.
 *
 * Test account (only when API_LOGIN is set, e.g. "POST /users/login"):
 *  - API_TEST_ACCOUNT=existing (default): credentials from .env, the ${VAR}s of API_LOGIN_BODY.
 *  - API_TEST_ACCOUNT=new: every Playwright WORKER registers its own NEW account through
 *    API_REGISTER / API_REGISTER_BODY at the start of every run. Accounts are never deleted.
 *    Generated email/password live in the worker's memory only.
 *  - API_TEST_ACCOUNT=auto: the account from .env; only when it is missing or its login is refused
 *    (401 / 403 / 422, e.g. the test environment was reset) does a worker register a new one, once,
 *    and log in with it. A working account never causes a registration.
 * The login happens lazily: a test that only uses publicApi never logs in.
 * Without API_LOGIN the static API_TOKEN from playwright.config (or none) is used unchanged.
 */
import { test as base, expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createApis, type Apis } from './api/generated/apis.js';

try {
  process.loadEnvFile();
} catch {
  /* no .env: rely on the real environment */
}

type Credentials = Record<string, string>;
export interface TestAccount {
  mode: 'none' | 'existing' | 'new' | 'auto';
  /** Values for the ${VAR}s of API_LOGIN_BODY. */
  credentials: Credentials;
  /** Email-like identifier, for logs (never the password). */
  label?: string;
}

const readPointer = (body: unknown, pointer: string): unknown =>
  pointer
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<any>((n, k) => (n == null ? undefined : n[k]), body);

const loginVars = (): string[] => [...new Set([...(process.env.API_LOGIN_BODY ?? '').matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]))];

function fill(template: string, values: Record<string, string | undefined>, name: string): unknown {
  const text = template.replace(/\$\{(\w+)\}/g, (_, k: string) => {
    const v = values[k];
    if (!v) throw new Error(`${name} uses \${${k}}, which is not set (.env or environment)`);
    return JSON.stringify(v).slice(1, -1);
  });
  return JSON.parse(text);
}

function splitRequest(raw: string | undefined, name: string): { method: string; path: string } {
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec((raw ?? '').trim());
  if (!m) throw new Error(`${name} must look like "POST /users/login", got "${raw ?? ''}"`);
  return { method: m[1].toUpperCase(), path: m[2].replace(/^\//, '') };
}

async function resolveAccount(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string | undefined, worker: number): Promise<TestAccount> {
  if (!process.env.API_LOGIN) return { mode: 'none', credentials: {} };
  const vars = loginVars();
  const mode = (process.env.API_TEST_ACCOUNT ?? 'existing').trim().toLowerCase();
  // auto: whatever .env has; TokenSource registers a new account only if this one is missing or refused.
  if (mode === 'auto') return { mode: 'auto', credentials: Object.fromEntries(vars.filter((v) => process.env[v]).map((v) => [v, process.env[v]!])) };
  if (mode !== 'new') {
    if (mode !== 'existing') throw new Error(`API_TEST_ACCOUNT must be "existing" or "new", got "${mode}"`);
    const missing = vars.filter((v) => !process.env[v]);
    if (missing.length) throw new Error(`Test account: set ${missing.join(', ')} in .env, or API_TEST_ACCOUNT=new to register one per worker`);
    return { mode: 'existing', credentials: Object.fromEntries(vars.map((v) => [v, process.env[v]!])) };
  }

  return registerNew(playwright, baseURL, worker);
}

/** A new account for this worker: generated email/password fill the same ${VAR}s as the login body. */
async function registerNew(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string | undefined, worker: number): Promise<TestAccount> {
  const vars = loginVars();
  const reg = splitRequest(process.env.API_REGISTER, 'API_REGISTER');
  const template = process.env.API_REGISTER_BODY;
  if (!template) throw new Error('API_TEST_ACCOUNT=new needs API_REGISTER_BODY (use the same ${VAR}s as API_LOGIN_BODY)');
  const unique = `${Date.now().toString(36)}w${worker}${randomBytes(3).toString('hex')}`;
  const password = `Qa-${randomBytes(12).toString('base64url')}-7x!`;
  const credentials: Credentials = Object.fromEntries(vars.map((v) => [v, /pass/i.test(v) ? password : `api-test-${unique}@example.com`]));
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { accept: 'application/json' } });
  try {
    const res = await ctx.fetch(reg.path, { method: reg.method, data: fill(template, { ...process.env, ...credentials, UNIQUE: unique }, 'API_REGISTER_BODY') });
    // Never print the request or the response: they contain the password.
    if (!res.ok()) throw new Error(`Registering a test account failed: ${reg.method} /${reg.path} answered ${res.status()} (check API_REGISTER_BODY)`);
  } finally {
    await ctx.dispose();
  }
  const label = Object.entries(credentials).find(([k]) => !/pass/i.test(k))?.[1];
  console.log(`[test-account] worker ${worker}: registered new account ${label ?? ''} (stays on the server)`);
  return { mode: 'new', credentials, label };
}

class TokenSource {
  private token?: string;
  private expiresAt = 0;

  private registered = false;

  constructor(
    private account: TestAccount,
    private readonly worker = 0,
  ) {}

  async get(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string | undefined): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 30_000) return this.token;
    if (this.account.mode === 'auto' && !this.registered) {
      const missing = loginVars().filter((v) => !this.account.credentials[v]);
      if (missing.length) await this.registerInstead(playwright, baseURL, `${missing.join(', ')} not set`);
      else {
        try {
          return await this.login(playwright, baseURL);
        } catch (e) {
          const status = /answered (\d+)/.exec((e as Error).message)?.[1];
          if (!status || !['401', '403', '422'].includes(status)) throw e;
          await this.registerInstead(playwright, baseURL, `the account from .env is refused (${status})`);
        }
      }
    }
    return this.login(playwright, baseURL);
  }

  /** auto: one new account for this worker, used for the rest of the run. */
  private async registerInstead(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string | undefined, why: string): Promise<void> {
    console.log(`[test-account] worker ${this.worker}: ${why}; registering a new account`);
    this.account = await registerNew(playwright, baseURL, this.worker);
    this.registered = true;
  }

  private async login(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string | undefined): Promise<string> {
    const { method, path } = splitRequest(process.env.API_LOGIN, 'API_LOGIN');
    const body = fill(process.env.API_LOGIN_BODY ?? '{}', { ...process.env, ...this.account.credentials }, 'API_LOGIN_BODY');
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { accept: 'application/json' } });
    try {
      const res = await ctx.fetch(path, { method, data: body });
      if (!res.ok()) throw new Error(`Login failed: ${method} /${path} answered ${res.status()} (${this.account.mode === 'new' ? 'freshly registered account' : this.account.mode === 'auto' ? 'account from .env' : 'check the test account in .env'})`);
      const json = await res.json();
      const pointer = process.env.API_TOKEN_POINTER || '/access_token';
      const token = readPointer(json, pointer);
      if (typeof token !== 'string' || !token) throw new Error(`Login answered ${res.status()} but there is no token at ${pointer}`);
      const ttl = Number(json?.expires_in);
      this.token = token;
      this.expiresAt = Date.now() + (ttl > 0 ? ttl * 1000 : 10 * 60_000);
      return token;
    } finally {
      await ctx.dispose();
    }
  }
}

export const test = base.extend<{ api: Apis; publicApi: Apis }, { testAccount: TestAccount; tokenSource: TokenSource }>({
  testAccount: [
    async ({ playwright }, use, workerInfo) => {
      const baseURL = (workerInfo.project.use as { baseURL?: string }).baseURL ?? process.env.API_BASE_URL;
      await use(await resolveAccount(playwright, baseURL, workerInfo.workerIndex));
    },
    { scope: 'worker' },
  ],
  tokenSource: [
    async ({ testAccount }, use, workerInfo) => {
      await use(new TokenSource(testAccount, workerInfo.workerIndex));
    },
    { scope: 'worker' },
  ],
  // Authenticated context. Built only when a test asks for it (api / request), so public tests never log in.
  request: async ({ playwright, baseURL, extraHTTPHeaders, tokenSource }, use) => {
    const headers = { ...extraHTTPHeaders };
    if (process.env.API_LOGIN) headers.authorization = `Bearer ${await tokenSource.get(playwright, baseURL)}`;
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers });
    await use(ctx);
    await ctx.dispose();
  },
  api: async ({ request }, use) => {
    await use(createApis(request));
  },
  // Explicit headers: newContext() inside a test would otherwise inherit the project's auth header.
  publicApi: async ({ playwright, baseURL }, use) => {
    const ctx: APIRequestContext = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { accept: 'application/json' }, httpCredentials: undefined });
    await use(createApis(ctx));
    await ctx.dispose();
  },
});

export { expect };
