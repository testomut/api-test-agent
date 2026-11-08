/**
 * Login-based auth: for APIs whose tokens are short-lived (e.g. a JWT valid for 5 minutes),
 * a static API_TOKEN goes stale. Instead the agent (and the generated suites) log in:
 *
 *   API_LOGIN=POST /users/login
 *   API_LOGIN_BODY={"email":"${API_USER}","password":"${API_PASSWORD}"}
 *   API_TOKEN_POINTER=/access_token
 *
 * ${VAR} placeholders are filled from the environment / .env, so credentials never live in
 * committed files, reports or generated code.
 */
export interface LoginConfig {
  method: string;
  path: string;
  bodyTemplate: string;
  pointer: string;
}

export function loginConfig(env: NodeJS.ProcessEnv = process.env): LoginConfig | undefined {
  const raw = env.API_LOGIN?.trim();
  if (!raw) return undefined;
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(raw);
  if (!m) throw new Error(`API_LOGIN must look like "POST /users/login", got "${raw}".`);
  return { method: m[1].toUpperCase(), path: m[2], bodyTemplate: env.API_LOGIN_BODY?.trim() || '{}', pointer: env.API_TOKEN_POINTER?.trim() || '/access_token' };
}

/** Fill ${VAR} from the environment, JSON-escaped (the template is a JSON document). */
export function expandTemplate(template: string, env: NodeJS.ProcessEnv = process.env): string {
  return template.replace(/\$\{(\w+)\}/g, (_, k: string) => {
    const v = env[k];
    if (v === undefined || v === '') throw new Error(`API_LOGIN_BODY uses \${${k}}, which is not set (.env or environment).`);
    return JSON.stringify(v).slice(1, -1);
  });
}

const readPointer = (body: unknown, pointer: string): unknown =>
  pointer.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')).reduce<any>((n, k) => (n == null ? undefined : n[k]), body);

export interface LoginResult {
  token: string;
  expiresInSec?: number;
}

export async function obtainToken(baseUrl: string, cfg: LoginConfig, env: NodeJS.ProcessEnv = process.env): Promise<LoginResult> {
  let body: unknown;
  try {
    body = JSON.parse(expandTemplate(cfg.bodyTemplate, env));
  } catch (e: any) {
    throw new Error(e instanceof SyntaxError ? 'API_LOGIN_BODY is not valid JSON.' : e.message);
  }
  const url = new URL(cfg.path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const res = await fetch(url, {
    method: cfg.method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  // Never echo the response or the request: they may contain credentials.
  if (!res.ok) throw new Error(`Login failed: ${cfg.method} ${cfg.path} answered HTTP ${res.status}. Check the credentials in .env and API_LOGIN_BODY.`);
  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Login answered ${res.status} but the body is not JSON.`);
  }
  const token = readPointer(json, cfg.pointer);
  if (typeof token !== 'string' || !token) throw new Error(`Login succeeded but no token at ${cfg.pointer} (set API_TOKEN_POINTER).`);
  const exp = Number(json?.expires_in);
  return { token, expiresInSec: Number.isFinite(exp) && exp > 0 ? exp : undefined };
}

/**
 * If API_LOGIN is configured: log in once and expose the token as API_TOKEN for this process
 * (probe, Schemathesis headers). Generated suites log in on their own at run time.
 */
export async function applyLogin(baseUrl: string | undefined, log: (m: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<LoginResult | undefined> {
  const cfg = loginConfig(env);
  if (!cfg) return undefined;
  if (!baseUrl) throw new Error('API_LOGIN is set but API_BASE_URL is not.');
  const r = await obtainToken(baseUrl, cfg, env);
  env.API_TOKEN = r.token;
  log(`  Logged in via ${cfg.method} ${cfg.path}${r.expiresInSec ? ` (token valid ${r.expiresInSec}s)` : ''}`);
  return r;
}
