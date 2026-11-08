#!/usr/bin/env node
import { Command, Option } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSpec, UnsupportedSpecError, type LoadedSpec } from './spec/loader.js';
import { lintSpec } from './spec/lint.js';
import { buildCatalog } from './spec/catalog.js';
import { SafeClient } from './audit/http.js';
import { probe } from './audit/probe.js';
import { runSchemathesis } from './audit/schemathesis.js';
import { resolveAuth } from './audit/auth.js';
import { buildReport, writeReport, type AuditReport } from './report/report.js';
import { generate, runGenerated, scenarioFindings } from './generate/generate.js';
import { openDraftPr } from './pr.js';
import type { Finding, Operation } from './types.js';
import { classifyTarget, loadConfig } from './config.js';
import { askAnswers, initProject } from './init.js';
import { findSpec, run } from './run.js';

const VERSION = '0.1.0';
const log = (m: string) => process.stderr.write(m + '\n');
// .env in the current folder is loaded first; real environment variables win.
const cfg = loadConfig(process.cwd());

interface CommonOpts {
  baseUrl?: string;
  confirmTestEnv: boolean;
  probe: boolean;
  schemathesis: boolean;
  allowWrite: boolean;
  maxRequests: string;
  rps: string;
  timeout: string;
  maxExamples: string;
  maxTime: string;
  seed: string;
  out: string;
  failOn: string;
  schemathesisBin?: string;
}

function common(cmd: Command) {
  return cmd
    .argument('[spec]', 'OpenAPI 3.x file or URL (default: API_SPEC_URL)')
    .option('-u, --base-url <url>', 'base URL of a TEST environment (default: API_BASE_URL)')
    .option('--confirm-test-env', 'allow writes to a host that does not look like a test environment', false)
    .option('--probe', 'send one non-destructive request per safe operation', false)
    .option('--schemathesis', 'run a bounded Schemathesis contract run', false)
    .option('--allow-write', 'allow POST/PUT/PATCH/DELETE (test environments only)', false)
    .option('--max-requests <n>', 'probe request budget', '100')
    .option('--rps <n>', 'requests per second limit', '5')
    .option('--timeout <sec>', 'per-request timeout in seconds', '10')
    .option('--max-examples <n>', 'Schemathesis cases per operation', '25')
    .option('--max-time <sec>', 'Schemathesis time budget in seconds', '120')
    .option('--seed <n>', 'Schemathesis seed (reproducible runs)', '42')
    .option('-o, --out <dir>', 'output directory for reports', `reports/api-agent/${cmd.name()}`)
    .addOption(new Option('--fail-on <level>', 'exit non-zero on').choices(['mismatch', 'blocked', 'never']).default('mismatch'))
    .option('--schemathesis-bin <path>', 'path to the schemathesis executable');
}

async function load(location: string): Promise<{ spec: LoadedSpec; ops: Operation[] }> {
  log(`Loading ${location}`);
  const spec = await loadSpec(location);
  const ops = buildCatalog(spec.doc);
  log(`  OpenAPI ${spec.version}, ${ops.length} operations, hash ${spec.hash}`);
  return { spec, ops };
}

/** Fills spec / base URL from .env and refuses writes to production-looking hosts. */
async function resolveInputs(specArg: string | undefined, o: CommonOpts): Promise<string> {
  o.baseUrl ??= cfg.baseUrl;
  const location = specArg ?? (await findSpec({ ...cfg, baseUrl: o.baseUrl }, log));
  if (!location) throw new Error('No spec found: pass it as an argument, set API_SPEC_URL in .env, or put openapi.yaml in the project.');
  if (o.allowWrite && o.baseUrl) {
    const kind = classifyTarget(o.baseUrl);
    if (kind === 'production') throw new Error(`${o.baseUrl} looks like production: write requests are refused.`);
    if (kind === 'unknown' && !o.confirmTestEnv) throw new Error(`Cannot tell whether ${o.baseUrl} is a test environment. If it is, add --confirm-test-env.`);
  }
  return location;
}

async function runAudit(location: string, o: CommonOpts) {
  const { spec, ops } = await load(location);
  const lint = await lintSpec(location);
  log(`  Lint: ${lint.filter((p) => p.severity === 'error').length} errors, ${lint.filter((p) => p.severity === 'warn').length} warnings`);

  const network = o.probe || o.schemathesis;
  if (network && !o.baseUrl) throw new Error('--probe/--schemathesis need --base-url pointing at a test environment.');
  if (o.allowWrite && !network) log('  --allow-write has no effect without --probe or --schemathesis');
  if (o.allowWrite) log('  ⚠ write methods enabled: make sure this is a disposable test environment');

  const findings: Finding[] = [];
  if (o.probe) {
    log('Probe (safe methods only):');
    const client = new SafeClient({
      baseUrl: o.baseUrl!,
      maxRequests: Number(o.maxRequests),
      timeoutMs: Number(o.timeout) * 1000,
      requestsPerSecond: Number(o.rps),
      allowWrite: false,
    });
    findings.push(...(await probe(spec.doc, ops, client, log)));
    log(`  ${client.requestsSent} requests sent`);
  }
  let schemathesis: AuditReport['schemathesis'];
  if (o.schemathesis) {
    log(`Schemathesis (max ${o.maxExamples} cases/op, ${o.maxTime}s, ${o.allowWrite ? 'all methods' : 'GET only'})…`);
    // Pass every credential the spec's schemes can be satisfied with.
    const schemes = Object.keys(spec.doc.components?.securitySchemes ?? {});
    const headers = Object.assign({}, ...schemes.map((s) => {
      const a = resolveAuth(spec.doc, [[s]]);
      return a.ok ? a.creds.headers : {};
    }));
    const run = await runSchemathesis(spec.doc, ops, {
      specLocation: location,
      baseUrl: o.baseUrl!,
      outDir: o.out,
      allowWrite: o.allowWrite,
      maxExamples: Number(o.maxExamples),
      maxTimeSec: Number(o.maxTime),
      requestsPerSecond: Number(o.rps),
      timeoutSec: Number(o.timeout),
      seed: Number(o.seed),
      headers,
      binary: o.schemathesisBin,
    });
    findings.push(...run.findings);
    schemathesis = { command: run.command, exitCode: run.exitCode };
  }
  return { spec, ops, lint, findings, schemathesis, network };
}

function finish(report: AuditReport, failOn: string) {
  const c = report.coverage;
  log(`\nOperations ${c.operations} · contract checked ${c.contractExercised} (mismatch ${c.contractMismatch}) · functional scenarios ${c.functionalScenarios} · not checked ${c.notChecked}`);
  const all = report.operations.flatMap((o) => [o.probe, o.schemathesis, o.functional]).filter(Boolean) as Finding[];
  const bad = all.some((f) => f.status === 'CONTRACT_MISMATCH' || f.status === 'TEST_FAILURE');
  const blocked = all.some((f) => f.status === 'BLOCKED');
  if (failOn === 'mismatch' && bad) process.exitCode = 1;
  if (failOn === 'blocked' && (bad || blocked)) process.exitCode = 1;
}

const program = new Command('api-test-agent').version(VERSION).description('OpenAPI audit, contract checks and reviewable Playwright API test generation. No AI in this version.');

common(program.command('audit').description('analyse a spec (and, if allowed, a test environment) without generating tests')).action(async (specArg: string | undefined, o: CommonOpts) => {
  const location = await resolveInputs(specArg, o);
  const r = await runAudit(location, o);
  const report = buildReport({
    mode: 'audit',
    spec: { location, title: r.spec.doc.info?.title, version: r.spec.version, hash: r.spec.hash, validationErrors: r.spec.validationErrors },
    target: { baseUrl: o.baseUrl, network: r.network, allowWrite: o.allowWrite },
    lint: { errors: r.lint.filter((p) => p.severity === 'error').length, warnings: r.lint.filter((p) => p.severity === 'warn').length, problems: r.lint },
    ops: r.ops,
    findings: r.findings,
    schemathesis: r.schemathesis,
  });
  const files = await writeReport(report, o.out);
  log(`Report: ${files.md}\n        ${files.json}`);
  finish(report, o.failOn);
});

common(program.command('generate').description('audit, then generate Playwright API tests for confirmed CRUD dependencies'))
  .option('--tests-dir <dir>', 'where generated tests are written (default: API_TESTS_DIR or tests/api)')
  .option('--deps <file>', 'JSON file with human-confirmed dependencies')
  .option('--run', 'run the generated tests once against --base-url (needs --allow-write)', false)
  .option('--draft-pr', 'commit to a new branch and open a GitHub Draft PR for review', false)
  .action(async (specArg: string | undefined, o: CommonOpts & { testsDir?: string; deps?: string; run: boolean; draftPr: boolean }) => {
    const location = await resolveInputs(specArg, o);
    o.testsDir ??= cfg.testsDir;
    if (o.run && (!o.baseUrl || !o.allowWrite)) throw new Error('--run creates and deletes data: it needs --base-url and --allow-write.');
    const r = await runAudit(location, o);
    const deps = o.deps ? JSON.parse(await readFile(o.deps, 'utf8')) : undefined;
    log('Generating functional scenarios…');
    const gen = await generate(r.spec, r.ops, { outDir: o.testsDir!, deps, version: VERSION });
    for (const s of gen.scenarios) log(`  ${s.status.padEnd(9)} ${s.name}`);
    if (o.run) {
      log('Running generated tests once (assertions are never changed to pass)…');
      await runGenerated(gen, { baseUrl: o.baseUrl! }, o.out);
      for (const s of gen.scenarios.filter((x) => x.file)) log(`  ${s.status.padEnd(9)} ${s.name}`);
    }
    const report = buildReport({
      mode: 'generate',
      spec: { location, title: r.spec.doc.info?.title, version: r.spec.version, hash: r.spec.hash, validationErrors: r.spec.validationErrors },
      target: { baseUrl: o.baseUrl, network: r.network || o.run, allowWrite: o.allowWrite },
      lint: { errors: r.lint.filter((p) => p.severity === 'error').length, warnings: r.lint.filter((p) => p.severity === 'warn').length, problems: r.lint },
      ops: r.ops,
      findings: [...r.findings, ...scenarioFindings(gen)],
      schemathesis: r.schemathesis,
      generated: {
        files: gen.files.map((f) => resolve(f).replace(process.cwd() + (process.platform === 'win32' ? '\\' : '/'), '').replace(/\\/g, '/')),
        scenarios: gen.scenarios.map(({ name, status, reason, operations }) => ({ name, status, reason, operations })),
      },
    });
    const files = await writeReport(report, o.out);
    log(`Report: ${files.md}`);
    if (o.draftPr) {
      if (!gen.files.length) log('No tests generated: Draft PR skipped.');
      else log(`Draft PR: ${await openDraftPr({ files: [...gen.files, files.md], title: `test(api): generated contract and CRUD tests for ${report.spec.title ?? location}`, bodyFile: files.md, hash: r.spec.hash })}`);
    }
    finish(report, o.failOn);
  });

program
  .command('init')
  .description('set up this project: .env, .env.example, .gitignore, playwright.config, Claude skill, npm scripts')
  .option('--yes', 'non-interactive: use flags and defaults', false)
  .option('--base-url <url>', 'API_BASE_URL')
  .option('--spec <urlOrFile>', 'API_SPEC_URL')
  .option('--postman <fileOrId>', 'POSTMAN_COLLECTION')
  .option('--tests-dir <dir>', 'API_TESTS_DIR', 'tests/api')
  .option('--token', 'the API needs a token (you paste it into .env)', false)
  .option('--force', 'replace .env.example and the skill even if they were changed', false)
  .action(async (o) => {
    const defaults = { baseUrl: o.baseUrl ?? cfg.baseUrl, specUrl: o.spec ?? cfg.specUrl, postman: o.postman ?? cfg.postmanCollection, testsDir: o.testsDir, needsToken: o.token };
    if (!o.yes && !process.stdin.isTTY) throw new Error('No interactive terminal: use --yes with --base-url (and optional --spec, --postman, --tests-dir, --token).');
    const answers = o.yes ? defaults : await askAnswers(defaults);
    if (!answers.baseUrl) throw new Error('--base-url is required with --yes.');
    const r = await initProject(process.cwd(), answers, { force: o.force });
    const list = (title: string, items: string[]) => {
      if (items.length) log(`${title}\n${items.map((i) => `  ${i}`).join('\n')}`);
    };
    log('');
    list('Created:', r.created);
    list('Updated:', r.updated);
    list('Kept as is:', r.kept);
    log('\nNext steps:');
    [...r.todo, 'Run the first analysis: npm run api-tests   (or: npx api-test-agent run)', 'Read reports/api-agent/report.md'].forEach((t, i) => log(`  ${i + 1}. ${t}`));
  });

program
  .command('run')
  .description('first run / health check: environment, spec, existing tests, Postman, dependency and coverage map, proposals (read-only)')
  .option('-o, --out <dir>', 'report directory', 'reports/api-agent')
  .option('--no-probe', 'do not send read-only requests to the API')
  .option('--no-schemathesis', 'skip Schemathesis even if installed')
  .option('--max-time <sec>', 'Schemathesis time budget', '60')
  .action(async (o) => {
    log('api-test-agent run (read-only)\n');
    const r = await run({ root: process.cwd(), out: o.out, probe: o.probe, schemathesis: o.schemathesis, maxTime: Number(o.maxTime), log });
    const a = r.analysis;
    const gaps = a.coverage.filter((c) => c.inSpec && !c.positiveTests.length && !c.generatedPositive).length;
    const postmanRequests = a.postman.reduce((s, c) => s + c.requests.length, 0);
    log(`\nSummary: ${a.tests.length} existing API tests · ${postmanRequests} Postman requests · ${a.edges.filter((e) => e.source !== 'candidate').length} dependencies · ${a.testIssues.length + a.postmanIssues.length} issues · ${gaps} operations without a positive test · ${a.proposals.length} proposals`);
    log(`Report: ${resolve(o.out, 'report.md')}`);
    if (r.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

program.parseAsync().catch((err) => {
  log(err instanceof UnsupportedSpecError ? `Unsupported spec: ${err.message}` : `Error: ${err?.message ?? err}`);
  process.exitCode = 2;
});
