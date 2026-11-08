import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { classifyTarget, loadConfig, type AgentConfig, type EnvKind } from './config.js';
import { loadSpec, type LoadedSpec } from './spec/loader.js';
import { lintSpec } from './spec/lint.js';
import { buildCatalog } from './spec/catalog.js';
import { SafeClient } from './audit/http.js';
import { probe } from './audit/probe.js';
import { findSchemathesis, runSchemathesis } from './audit/schemathesis.js';
import { resolveAuth } from './audit/auth.js';
import { analyzeProject, type Analysis } from './discover/analyze.js';
import { applyLogin } from './audit/login.js';
import { renderRunReport } from './report/run-report.js';
import type { Finding, LintProblem, Operation } from './types.js';
import { spawnSync } from 'node:child_process';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
}

export interface RunResult {
  config: Omit<AgentConfig, 'token' | 'postmanApiKey'> & { tokenSet: boolean; postmanApiKeySet: boolean };
  target?: EnvKind;
  checks: Check[];
  spec?: { location: string; title?: string; version: string; hash: string; operations: number; lint: LintProblem[]; validationErrors: string[] };
  contract: Finding[];
  analysis: Analysis;
  generatedAt: string;
}

const SPEC_FILES = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json', 'api/openapi.yaml', 'docs/openapi.yaml', 'spec/openapi.yaml'];
const SPEC_URLS = ['openapi.json', 'openapi.yaml', 'swagger.json', 'v3/api-docs', 'api-docs', 'swagger/v1/swagger.json', 'docs/openapi.json'];

export async function findSpec(cfg: AgentConfig, log: (m: string) => void): Promise<string | undefined> {
  if (cfg.specUrl) return cfg.specUrl;
  for (const f of SPEC_FILES) if (existsSync(join(cfg.root, f))) return f;
  if (!cfg.baseUrl) return undefined;
  for (const p of SPEC_URLS) {
    const url = new URL(p, cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/').toString();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const text = res.ok ? await res.text() : '';
      if (/"?openapi"?\s*:\s*"?3\.|"?swagger"?\s*:/.test(text.slice(0, 2000))) {
        log(`  Found spec at ${url}`);
        return url;
      }
    } catch {
      /* not there */
    }
  }
  return undefined;
}

export async function run(o: { root: string; out: string; probe: boolean; schemathesis: boolean; maxTime: number; log: (m: string) => void }): Promise<RunResult> {
  const { log } = o;
  const cfg = loadConfig(o.root);
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string) => {
    checks.push({ name, status, detail });
    log(`  ${{ ok: '✔', warn: '!', fail: '✖', skip: '-' }[status]} ${name}: ${detail}`);
  };

  log('Environment');
  add('.env', cfg.envFileFound ? 'ok' : 'warn', cfg.envFileFound ? 'found' : 'not found: run `npx @testomut/api-test-agent init`, or set variables in the environment');
  const gi = existsSync(join(o.root, '.gitignore')) ? readFileSync(join(o.root, '.gitignore'), 'utf8') : '';
  if (cfg.envFileFound) add('.env ignored by git', /^\/?\.env\s*$/m.test(gi) ? 'ok' : 'fail', /^\/?\.env\s*$/m.test(gi) ? 'yes' : '.env is NOT in .gitignore: secrets could be committed (init adds it)');

  let target: EnvKind | undefined;
  if (!cfg.baseUrl) add('API_BASE_URL', 'fail', 'not set: network checks are skipped');
  else {
    target = classifyTarget(cfg.baseUrl);
    try {
      const res = await fetch(cfg.baseUrl, { signal: AbortSignal.timeout(5000) });
      add('API_BASE_URL', 'ok', `${cfg.baseUrl} answers (HTTP ${res.status})`);
    } catch (e: any) {
      add('API_BASE_URL', 'fail', `${cfg.baseUrl} does not answer (${e?.cause?.code ?? e?.name ?? 'error'})`);
    }
    add('Target type', target === 'production' ? 'warn' : target === 'unknown' ? 'warn' : 'ok', {
      local: 'local: writes allowed with --allow-write',
      test: 'test environment: writes allowed with --allow-write',
      production: 'looks like PRODUCTION: write requests are refused',
      unknown: 'cannot tell test from production by hostname: writes need --confirm-test-env',
    }[target]);
  }

  // Spec
  log('Specification');
  let spec: LoadedSpec | undefined;
  let ops: Operation[] = [];
  let lint: LintProblem[] = [];
  const specRef = await findSpec(cfg, log);
  if (!specRef) add('OpenAPI spec', 'warn', 'none (set API_SPEC_URL): contract checks and test generation are skipped');
  else {
    try {
      spec = await loadSpec(/^https?:/i.test(specRef) ? specRef : resolve(o.root, specRef));
      ops = buildCatalog(spec.doc);
      lint = await lintSpec(spec.location);
      add('OpenAPI spec', spec.validationErrors.length ? 'warn' : 'ok', `${specRef}: OpenAPI ${spec.doc.openapi}, ${ops.length} operations, lint ${lint.filter((p) => p.severity === 'error').length} errors / ${lint.filter((p) => p.severity === 'warn').length} warnings`);
    } catch (e: any) {
      add('OpenAPI spec', 'fail', `${specRef}: ${e?.message ?? e}`);
    }
  }

  // Login (short-lived tokens): obtain a fresh token before any check that needs one.
  if (process.env.API_LOGIN) {
    try {
      const r = await applyLogin(cfg.baseUrl, () => undefined);
      if (r) {
        cfg.token = r.token;
        add('API_LOGIN', 'ok', `logged in${r.expiresInSec ? `, token valid ${r.expiresInSec}s (the generated tests log in on their own)` : ''}`);
      }
    } catch (e: any) {
      add('API_LOGIN', 'fail', String(e?.message ?? e));
    }
  }

  // Token
  if (cfg.token && spec && cfg.baseUrl) {
    const secured = ops.find((op) => op.method === 'get' && op.security.some((a) => a.length) && !op.params.some((p) => p.required && p.knownValue === undefined));
    if (!secured) add('API_TOKEN', 'skip', 'set; no secured GET operation without parameters to verify it');
    else {
      const auth = resolveAuth(spec.doc, secured.security);
      try {
        const res = await fetch(new URL(secured.path.replace(/^\//, ''), cfg.baseUrl.replace(/\/?$/, '/')), { headers: auth.ok ? auth.creds.headers : {}, signal: AbortSignal.timeout(5000) });
        add('API_TOKEN', res.status === 401 || res.status === 403 ? 'fail' : 'ok', res.status === 401 || res.status === 403 ? `rejected by ${secured.key} (HTTP ${res.status})` : `accepted by ${secured.key}`);
      } catch {
        add('API_TOKEN', 'skip', 'could not verify (request failed)');
      }
    }
  } else add('API_TOKEN', cfg.token ? 'skip' : 'skip', cfg.token ? 'set (not verified: needs spec and base URL)' : 'not set (fine if the API is public)');

  // Contract checks (read-only)
  const contract: Finding[] = [];
  if (spec && cfg.baseUrl && o.probe) {
    log('Contract checks (read-only)');
    const client = new SafeClient({ baseUrl: cfg.baseUrl, maxRequests: 100, timeoutMs: 10_000, requestsPerSecond: 5, allowWrite: false });
    contract.push(...(await probe(spec.doc, ops, client, () => undefined)));
    log(`  probe: ${client.requestsSent} GET requests`);
    if (o.schemathesis) {
      const bin = findSchemathesis();
      const available = bin && spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0;
      if (!available) add('Schemathesis', 'skip', 'not installed (`pip install schemathesis` enables generative contract checks)');
      else {
        const headers = Object.assign({}, ...Object.keys(spec.doc.components?.securitySchemes ?? {}).map((s) => {
          const a = resolveAuth(spec!.doc, [[s]]);
          return a.ok ? a.creds.headers : {};
        }));
        const st = await runSchemathesis(spec.doc, ops, { specLocation: spec.location, baseUrl: cfg.baseUrl, outDir: o.out, allowWrite: false, maxExamples: 25, maxTimeSec: o.maxTime, requestsPerSecond: 5, timeoutSec: 10, seed: 42, headers });
        contract.push(...st.findings);
        add('Schemathesis', 'ok', `ran (GET only, ${o.maxTime}s budget)`);
      }
    }
  }

  // Existing tests + Postman
  log('Existing tests and Postman');
  const analysis = await analyzeProject({ root: o.root, testsDir: cfg.testsDir, doc: spec?.doc, ops, postmanRef: cfg.postmanCollection, postmanApiKey: cfg.postmanApiKey });
  const kinds = analysis.inventory.reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  log(`  ${Object.entries(kinds).map(([k, n]) => `${k}: ${n}`).join(', ') || 'no test files found'}`);
  for (const e of analysis.postmanErrors) add('Postman', 'fail', e);
  if (cfg.postmanCollection && !analysis.postmanErrors.length) add('Postman', 'ok', `${analysis.postman.map((c) => `${c.name} (${c.requests.length} requests, ${c.source})`).join('; ')}`);
  if (analysis.apiTestsOutsideDir.length) add('API_TESTS_DIR', 'warn', `${analysis.apiTestsOutsideDir.length} API test file(s) outside ${cfg.testsDir}`);

  const { token, postmanApiKey, ...safeCfg } = cfg;
  const result: RunResult = {
    config: { ...safeCfg, tokenSet: !!token, postmanApiKeySet: !!postmanApiKey },
    target,
    checks,
    spec: spec && { location: specRef!, title: spec.doc.info?.title, version: spec.version, hash: spec.hash, operations: ops.length, lint, validationErrors: spec.validationErrors },
    contract,
    analysis,
    generatedAt: new Date().toISOString(),
  };
  await mkdir(o.out, { recursive: true });
  await writeFile(join(o.out, 'report.json'), JSON.stringify(result, (k, v) => (k === 'from' || k === 'to') && v && typeof v === 'object' && 'index' in v ? v.name : v, 2) + '\n');
  await writeFile(join(o.out, 'report.md'), renderRunReport(result));
  return result;
}
