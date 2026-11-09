/**
 * Test account for login-based auth (API_LOGIN): before a run the user says whether a test
 * account exists.
 *
 *   existing: credentials come from .env (the ${VAR}s of API_LOGIN_BODY), as before.
 *   new:      fresh accounts are registered through API_REGISTER on EVERY run: the generated
 *             suite registers one per Playwright worker (fixtures.ts), and the agent one more for
 *             its own --probe/--schemathesis checks. Emails and passwords are generated and kept in
 *             memory only (never written to .env, reports or generated files).
 *
 *   API_TEST_ACCOUNT=existing|new        (or --test-account; asked when it is not set)
 *   API_REGISTER=POST /users/register
 *   API_REGISTER_BODY={"email":"${API_USER}","password":"${API_PASSWORD}", ...}
 *
 * API_REGISTER_BODY uses the same ${VAR} names as API_LOGIN_BODY, so the generated credentials
 * fill both. ${UNIQUE} is a per-run suffix for other fields that must be unique.
 */
import { randomBytes } from 'node:crypto';
import { expandTemplate, loginConfig } from './login.js';

export type AccountMode = 'existing' | 'new' | 'auto';
export const ACCOUNT_MODES: AccountMode[] = ['existing', 'new', 'auto'];

/** ${VAR} names used by the login body (credentials of the test account). */
export function loginVars(env: NodeJS.ProcessEnv = process.env): string[] {
  const cfg = loginConfig(env);
  if (!cfg) return [];
  return [...new Set([...cfg.bodyTemplate.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]))];
}

export function missingLoginVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return loginVars(env).filter((v) => !env[v]);
}

export function parseAccountMode(raw: string | undefined): AccountMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'existing' || v === 'new' || v === 'auto') return v;
  throw new Error(`API_TEST_ACCOUNT / --test-account must be "existing", "new" or "auto", got "${raw}".`);
}

/** Text shown before the question: what each answer means, in particular that "new" registers an account every run. */
export function accountNotice(env: NodeJS.ProcessEnv = process.env): string {
  const cfg = loginConfig(env)!;
  const vars = loginVars(env);
  const reg = env.API_REGISTER?.trim();
  return [
    '',
    'Test account',
    `  The API is called with a login (${cfg.method} ${cfg.path}), so the tests need an account on the test environment.`,
    `  y = I have a test account: its credentials are read from .env${vars.length ? ` (${vars.join(', ')})` : ''}.`,
    `  n = no account: NEW accounts are registered${reg ? ` (${reg})` : ' (API_REGISTER, not set yet)'} on EVERY run:`,
    '      one per Playwright worker (parallel test process), plus one for --probe/--schemathesis.',
    '      They stay on the server; nothing deletes them.',
    '      Emails and passwords are generated and kept in memory for the run only (not saved to .env).',
    '  auto (API_TEST_ACCOUNT=auto) = the account from .env, and a new one only when it is missing or refused',
    '      (e.g. the test environment was reset): no registration while the account works.',
    '  Skip this question next time: API_TEST_ACCOUNT=existing|new|auto in .env (npm run test:api reads it too), or --test-account.',
    '',
  ].join('\n');
}

/** Values for every login-body variable: a password for *PASS* names, a unique email for the rest. */
export function newCredentials(vars: string[], unique: string): Record<string, string> {
  // Upper, lower, digit and symbol: satisfies common password rules.
  const password = `Qa-${randomBytes(12).toString('base64url')}-7x!`;
  const out: Record<string, string> = {};
  for (const v of vars) out[v] = /pass/i.test(v) ? password : `api-test-${unique}@example.com`;
  return out;
}

export interface RegisteredAccount {
  /** Non-secret identifier for the log (the email-like value). */
  label: string;
}

/**
 * Registers a fresh account and puts its credentials into env, so the login (agent and the
 * generated suite started with --run) uses it. Never logs the request or the response.
 */
/** Validates API_REGISTER / API_REGISTER_BODY without sending anything. */
export function checkRegisterConfig(env: NodeJS.ProcessEnv = process.env): { method: string; path: string; template: string; vars: string[] } {
  const raw = env.API_REGISTER?.trim();
  const template = env.API_REGISTER_BODY?.trim();
  if (!raw || !template) {
    throw new Error(
      'No test account: registering a new one needs API_REGISTER and API_REGISTER_BODY in .env, e.g.\n' +
        '  API_REGISTER=POST /users/register\n' +
        '  API_REGISTER_BODY={"email":"${API_USER}","password":"${API_PASSWORD}"}   (use the same ${VAR}s as API_LOGIN_BODY; ${UNIQUE} = per-run suffix)\n' +
        'Or answer "existing" and put the account into .env.',
    );
  }
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(raw);
  if (!m) throw new Error(`API_REGISTER must look like "POST /users/register", got "${raw}".`);
  const vars = loginVars(env);
  if (!vars.length) throw new Error('API_LOGIN_BODY has no ${VAR}: there is nothing to fill with the new account.');
  const unused = vars.filter((v) => !template.includes(`\${${v}}`));
  if (unused.length) throw new Error(`API_REGISTER_BODY must use the same variables as API_LOGIN_BODY; missing ${unused.map((v) => `\${${v}}`).join(', ')}.`);
  return { method: m[1].toUpperCase(), path: m[2], template, vars };
}

export async function registerAccount(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<RegisteredAccount> {
  const { method, path, template, vars } = checkRegisterConfig(env);

  const unique = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const creds = newCredentials(vars, unique);
  let body: unknown;
  try {
    body = JSON.parse(expandTemplate(template, { ...env, ...creds, UNIQUE: unique }));
  } catch (e: any) {
    throw new Error(e instanceof SyntaxError ? 'API_REGISTER_BODY is not valid JSON.' : e.message.replace('API_LOGIN_BODY', 'API_REGISTER_BODY'));
  }
  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Registering a test account failed: ${method} ${path} answered HTTP ${res.status}. Check API_REGISTER_BODY against the API's required fields.`);
  Object.assign(env, creds);
  const label = Object.entries(creds).find(([k]) => !/pass/i.test(k))?.[1] ?? '(no email variable)';
  return { label };
}
