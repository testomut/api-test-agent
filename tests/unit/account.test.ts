import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountNotice, loginVars, missingLoginVars, newCredentials, parseAccountMode, registerAccount } from '../../src/audit/account.js';

const base = {
  API_LOGIN: 'POST /users/login',
  API_LOGIN_BODY: '{"email":"${SHOP_EMAIL}","password":"${SHOP_PASSWORD}"}',
};

afterEach(() => vi.unstubAllGlobals());

describe('test account', () => {
  it('finds the credential variables of the login body', () => {
    expect(loginVars({ ...base })).toEqual(['SHOP_EMAIL', 'SHOP_PASSWORD']);
    expect(missingLoginVars({ ...base, SHOP_EMAIL: 'a@b.c' })).toEqual(['SHOP_PASSWORD']);
    expect(loginVars({})).toEqual([]);
  });

  it('accepts only existing/new', () => {
    expect(parseAccountMode(' New ')).toBe('new');
    expect(parseAccountMode('auto')).toBe('auto');
    expect(parseAccountMode('')).toBeUndefined();
    expect(() => parseAccountMode('maybe')).toThrow(/"existing", "new" or "auto"/);
  });

  it('says plainly that "no" registers an account on every run', () => {
    const text = accountNotice({ ...base, API_REGISTER: 'POST /users/register' });
    expect(text).toMatch(/NEW accounts are registered \(POST \/users\/register\) on EVERY run/);
    expect(text).toMatch(/one per Playwright worker/);
    expect(text).toMatch(/nothing deletes them/);
  });

  it('generates a password for *PASS* variables and a unique email for the rest', () => {
    const c = newCredentials(['SHOP_EMAIL', 'SHOP_PASSWORD'], 'u1');
    expect(c.SHOP_EMAIL).toBe('api-test-u1@example.com');
    expect(c.SHOP_PASSWORD).toMatch(/[A-Z]/);
    expect(c.SHOP_PASSWORD).toMatch(/[0-9]/);
    expect(c.SHOP_PASSWORD).toMatch(/[!]/);
  });

  it('registers with the same variables and exposes them only through env', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const env: NodeJS.ProcessEnv = {
      ...base,
      API_REGISTER: 'POST /users/register',
      API_REGISTER_BODY: '{"first_name":"Api","email":"${SHOP_EMAIL}","password":"${SHOP_PASSWORD}","phone":"${UNIQUE}"}',
    };
    const acc = await registerAccount('https://api.test.example.com', env);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://api.test.example.com/users/register');
    const sent = JSON.parse(String(init.body));
    expect(sent.email).toBe(env.SHOP_EMAIL);
    expect(sent.password).toBe(env.SHOP_PASSWORD);
    expect(sent.phone).toMatch(/^[0-9a-z]+$/);
    expect(acc.label).toBe(env.SHOP_EMAIL);
    expect(acc.label).not.toContain(env.SHOP_PASSWORD!);
  });

  it('explains what to set when registration is not configured or fails', async () => {
    await expect(registerAccount('https://x.test', { ...base })).rejects.toThrow(/API_REGISTER and API_REGISTER_BODY/);
    await expect(
      registerAccount('https://x.test', { ...base, API_REGISTER: 'POST /r', API_REGISTER_BODY: '{"email":"${SHOP_EMAIL}"}' }),
    ).rejects.toThrow(/missing \$\{SHOP_PASSWORD\}/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"password":"leak"}', { status: 422 })));
    const env = { ...base, API_REGISTER: 'POST /r', API_REGISTER_BODY: '{"e":"${SHOP_EMAIL}","p":"${SHOP_PASSWORD}"}' };
    await expect(registerAccount('https://x.test', env)).rejects.toThrow(/answered HTTP 422/);
    expect(env).not.toHaveProperty('SHOP_EMAIL'); // nothing half-applied
  });
});
