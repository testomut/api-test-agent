/**
 * Playwright fixtures for generated API tests: authentication.
 *
 * Copied verbatim by api-test-agent into tests/api/_support/ (self-contained).
 *  - API_LOGIN set (e.g. "POST /users/login"): log in with API_LOGIN_BODY, read the token at
 *    API_TOKEN_POINTER (default /access_token), refresh it shortly before it expires.
 *  - Otherwise: the static API_TOKEN set in playwright.config (or none) is used unchanged.
 * Credentials come from .env / the environment only.
 */
import { test as base, expect, request as playwrightRequest } from '@playwright/test';

try {
  process.loadEnvFile();
} catch {
  /* no .env: rely on the real environment */
}

const readPointer = (body: unknown, pointer: string): unknown =>
  pointer
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<any>((n, k) => (n == null ? undefined : n[k]), body);

class TokenSource {
  private token?: string;
  private expiresAt = 0;

  async get(baseURL: string | undefined): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 30_000) return this.token;
    const [method, path] = (process.env.API_LOGIN ?? '').trim().split(/\s+/);
    const body = (process.env.API_LOGIN_BODY ?? '{}').replace(/\$\{(\w+)\}/g, (_, k: string) => {
      const v = process.env[k];
      if (!v) throw new Error(`API_LOGIN_BODY uses \${${k}}, which is not set (.env or environment)`);
      return JSON.stringify(v).slice(1, -1);
    });
    const ctx = await playwrightRequest.newContext({ baseURL });
    try {
      const res = await ctx.fetch(path.replace(/^\//, ''), { method, data: JSON.parse(body) });
      if (!res.ok()) throw new Error(`Login failed: ${method} ${path} answered ${res.status()} (check credentials in .env)`);
      const json = await res.json();
      const token = readPointer(json, process.env.API_TOKEN_POINTER || '/access_token');
      if (typeof token !== 'string' || !token) throw new Error(`Login answered ${res.status()} but there is no token at ${process.env.API_TOKEN_POINTER || '/access_token'}`);
      const ttl = Number(json?.expires_in);
      this.token = token;
      this.expiresAt = Date.now() + (ttl > 0 ? ttl * 1000 : 10 * 60_000);
      return token;
    } finally {
      await ctx.dispose();
    }
  }
}

export const test = base.extend<{}, { tokenSource: TokenSource }>({
  tokenSource: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(new TokenSource());
    },
    { scope: 'worker' },
  ],
  extraHTTPHeaders: async ({ extraHTTPHeaders, tokenSource, baseURL }, use) => {
    if (!process.env.API_LOGIN) {
      await use(extraHTTPHeaders);
      return;
    }
    await use({ ...extraHTTPHeaders, authorization: `Bearer ${await tokenSource.get(baseURL)}` });
  },
});

export { expect };
