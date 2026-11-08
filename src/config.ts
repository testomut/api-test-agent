import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Configuration comes from environment variables, with a `.env` file in the project root as
 * the default source. Real environment variables (e.g. CI secrets) win over `.env`.
 */
export const ENV_KEYS = {
  API_BASE_URL: 'Base URL of the TEST environment (required for any network check).',
  API_TOKEN: 'Bearer token, if the API needs authentication. Secret: keep it in .env or CI secrets only.',
  API_SPEC_URL: 'Optional. OpenAPI/Swagger spec: URL or file path.',
  POSTMAN_COLLECTION: 'Optional. Postman collection: path to an exported .json file, or a collection id/uid in the Postman cloud.',
  POSTMAN_API_KEY: 'Only for a cloud collection id. Secret.',
  API_TESTS_DIR: 'Optional. Folder with API tests (default tests/api). Other test folders (UI, unit) are never modified.',
} as const;

export type EnvKey = keyof typeof ENV_KEYS;

export interface AgentConfig {
  root: string;
  baseUrl?: string;
  token?: string;
  specUrl?: string;
  postmanCollection?: string;
  postmanApiKey?: string;
  testsDir: string;
  envFileFound: boolean;
}

export function readEnvFile(root: string): Record<string, string> {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

export function loadConfig(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const file = readEnvFile(root);
  const get = (k: EnvKey) => {
    const v = env[k] ?? file[k];
    return v && v.trim() ? v.trim() : undefined;
  };
  // Make .env values visible to code that reads process.env (auth, redaction, child processes).
  for (const [k, v] of Object.entries(file)) if (env[k] === undefined) env[k] = v;
  return {
    root,
    baseUrl: get('API_BASE_URL'),
    token: get('API_TOKEN'),
    specUrl: get('API_SPEC_URL'),
    postmanCollection: get('POSTMAN_COLLECTION'),
    postmanApiKey: get('POSTMAN_API_KEY'),
    testsDir: get('API_TESTS_DIR') ?? 'tests/api',
    envFileFound: existsSync(resolve(root, '.env')),
  };
}

export type EnvKind = 'local' | 'test' | 'production' | 'unknown';

/**
 * Classifies the target by hostname. Writes go only to `local` / `test`; `production` and
 * `unknown` need an explicit --confirm-test-env, because a wrong guess deletes real data.
 */
export function classifyTarget(url: string): EnvKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (host === 'localhost' || host.startsWith('127.') || host === '[::1]' || host.endsWith('.local')) return 'local';
  if (/(^|[.-])(prod|production|live)([.-]|$)/.test(host)) return 'production';
  if (/(^|[.-])(test|testing|qa|stage|staging|stg|dev|sandbox|uat|preprod|demo)\d*([.-]|$)/.test(host)) return 'test';
  return 'unknown';
}
