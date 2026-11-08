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
import { askAnswers, askYesNo, initProject, skillNotice } from './init.js';
import { findSpec, run } from './run.js';
import { applyPlan, buildPlan, gitState } from './adapt.js';
import { applyLogin } from './audit/login.js';
import { analyzeProject } from './discover/analyze.js';

const VERSION = '0.1.2';
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
  log(`  OpenAPI ${spec.doc.openapi}, ${ops.length} operations, hash ${spec.hash}`);
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
  if (network) await applyLogin(o.baseUrl, log); // short-lived tokens: log in first (API_LOGIN)
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
    spec: { location, title: r.spec.doc.info?.title, version: String(r.spec.doc.openapi), hash: r.spec.hash, validationErrors: r.spec.validationErrors },
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
  .addOption(new Option('--lang <lang>', 'language of generated tests (default: API_TESTS_LANG or typescript)').choices(['typescript', 'python']))
  .option('--run', 'run the generated tests once against --base-url (needs --allow-write)', false)
  .option('--draft-pr', 'commit to a new branch and open a GitHub Draft PR for review', false)
  .action(async (specArg: string | undefined, o: CommonOpts & { testsDir?: string; deps?: string; run: boolean; draftPr: boolean; lang?: 'typescript' | 'python' }) => {
    const location = await resolveInputs(specArg, o);
    o.testsDir ??= cfg.testsDir;
    o.lang ??= cfg.testsLang;
    log(`Test language: ${o.lang}`);
    if (o.run && (!o.baseUrl || !o.allowWrite)) throw new Error('--run creates and deletes data: it needs --base-url and --allow-write.');
    const r = await runAudit(location, o);
    const deps = o.deps ? JSON.parse(await readFile(o.deps, 'utf8')) : undefined;
    log('Generating functional scenarios…');
    const gen = await generate(r.spec, r.ops, { outDir: o.testsDir!, deps, version: VERSION, lang: o.lang });
    for (const s of gen.scenarios) log(`  ${s.status.padEnd(9)} ${s.name}`);
    if (o.run) {
      log('Running generated tests once (assertions are never changed to pass)…');
      await runGenerated(gen, { baseUrl: o.baseUrl! }, o.out, o.lang);
      for (const s of gen.scenarios.filter((x) => x.file)) log(`  ${s.status.padEnd(9)} ${s.name}`);
    }
    const report = buildReport({
      mode: 'generate',
      spec: { location, title: r.spec.doc.info?.title, version: String(r.spec.doc.openapi), hash: r.spec.hash, validationErrors: r.spec.validationErrors },
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
  .description('set up this project: shows a plan of every file it will create or change and asks before applying')
  .option('--yes', 'non-interactive: apply without asking (the skill still needs --with-skill)', false)
  .option('--dry-run', 'only show what would change', false)
  .option('--with-skill', 'also install the Claude Code skill into .claude/skills/', false)
  .option('--base-url <url>', 'API_BASE_URL')
  .option('--spec <urlOrFile>', 'API_SPEC_URL')
  .option('--postman <fileOrId>', 'POSTMAN_COLLECTION')
  .option('--tests-dir <dir>', 'API_TESTS_DIR', 'tests/api')
  .addOption(new Option('--lang <lang>', 'API_TESTS_LANG: language of generated tests').choices(['typescript', 'python']))
  .option('--token', 'the API needs a static token (you paste it into .env)', false)
  .option('--login <request>', 'short-lived tokens: login request, e.g. "POST /users/login"')
  .option('--login-body <json>', 'login body; ${VAR} is read from .env')
  .option('--token-pointer <pointer>', 'where the token is in the login response (default /access_token)')
  .option('--force', 'replace .env.example and the skill even if they were changed', false)
  .action(async (o) => {
    const defaults = { baseUrl: o.baseUrl ?? cfg.baseUrl, specUrl: o.spec ?? cfg.specUrl, postman: o.postman ?? cfg.postmanCollection, testsDir: o.testsDir, needsToken: o.token, login: o.login, loginBody: o.loginBody, tokenPointer: o.tokenPointer, lang: o.lang ?? cfg.testsLang };
    const canAsk = !o.yes && !!process.stdin.isTTY;
    if (!canAsk && !o.yes && !o.dryRun) throw new Error('No interactive terminal: use --yes (or --dry-run) with --base-url and optional --spec, --postman, --tests-dir, --token, --with-skill.');
    const answers = canAsk ? await askAnswers(defaults) : defaults;
    if (!answers.baseUrl) throw new Error('--base-url is required with --yes.');
    const interactive = canAsk;

    // The skill steers the AI agent in this project: explain it and ask separately (default: no).
    let installSkill = !!o.withSkill;
    if (interactive && !installSkill) {
      process.stdout.write(skillNotice());
      installSkill = await askYesNo('Install the skill?', false);
    }

    const list = (title: string, items: string[]) => {
      if (items.length) process.stdout.write(`${title}\n${items.map((i) => `  - ${i}`).join('\n')}\n`);
    };
    const plan = await initProject(process.cwd(), answers, { force: o.force, installSkill, dryRun: true });
    process.stdout.write(`\ninit will change ${process.cwd()}:\n\n`);
    list('Create:', plan.created);
    list('Update:', plan.updated);
    list('Leave as is:', plan.kept);
    process.stdout.write('\nNothing else is touched: no installs, no network calls, existing tests and configs are not modified.\n\n');
    if (!plan.created.length && !plan.updated.length) {
      log('Nothing to do: the project is already set up.');
      return;
    }
    if (o.dryRun) {
      log('Dry run: nothing was changed.');
      return;
    }
    if (interactive && !(await askYesNo('Apply these changes?', false))) {
      log('Cancelled: nothing was changed.');
      return;
    }
    const r = await initProject(process.cwd(), answers, { force: o.force, installSkill });
    log(`Done: ${r.created.length} created, ${r.updated.length} updated.`);
    log('\nNext steps:');
    [...r.todo, 'Run the first analysis: npx @testomut/api-test-agent run   (or: npm run api-tests)', 'Read reports/api-agent/report.md'].forEach((t, i) => log(`  ${i + 1}. ${t}`));
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

program
  .command('adapt')
  .description('move existing API tests into the layout and convert uncovered Postman requests; shows the plan and asks first')
  .option('--dry-run', 'only show the plan', false)
  .option('--yes', 'apply without asking', false)
  .addOption(new Option('--only <what>', 'limit to one kind of change').choices(['moves', 'postman']))
  .option('--allow-dirty', 'run even with uncommitted git changes (harder to review and revert)', false)
  .action(async (o) => {
    const root = process.cwd();
    const git = gitState(root);
    if (!o.dryRun && !o.allowDirty) {
      if (!git.repo) throw new Error('adapt moves and deletes files: run it inside a git repository so every change can be reviewed and reverted (or pass --allow-dirty).');
      if (!git.clean) throw new Error(`Uncommitted changes (${git.dirty.length}): commit or stash them first, so adapt's changes can be reviewed and reverted on their own (or pass --allow-dirty).`);
    }
    const specRef = await findSpec(cfg, () => undefined);
    const spec = specRef ? await loadSpec(/^https?:/i.test(specRef) ? specRef : resolve(root, specRef)) : undefined;
    const ops = spec ? buildCatalog(spec.doc) : [];
    log(`adapt: ${spec ? `spec ${specRef}, ${ops.length} operations` : 'no spec (operations matched by path)'} · tests dir ${cfg.testsDir} · language ${cfg.testsLang}\n`);
    const analysis = await analyzeProject({ root, testsDir: cfg.testsDir, doc: spec?.doc, ops, postmanRef: cfg.postmanCollection, postmanApiKey: cfg.postmanApiKey });
    const plan = buildPlan({ root, analysis, ops, testsDir: cfg.testsDir, lang: cfg.testsLang, only: o.only });

    const show = (action: string, title: string) => {
      const list = plan.changes.filter((c) => c.action === action && !c.path.endsWith('__init__.py'));
      if (list.length) process.stdout.write(`${title}\n${list.map((c) => `  - ${c.path}: ${c.reason}`).join('\n')}\n`);
    };
    process.stdout.write(`adapt will change ${root}:\n\n`);
    show('create', 'Create:');
    show('rewrite', 'Rewrite (moved tests removed, the rest unchanged):');
    show('delete', 'Delete (every test in it was moved):');
    const inits = plan.changes.filter((c) => c.path.endsWith('__init__.py')).length;
    if (inits) process.stdout.write(`Create: ${inits} empty __init__.py (Python package markers)\n`);
    if (plan.skipped.length) process.stdout.write(`\nNot changed, with the reason:\n${plan.skipped.map((s) => `  - ${s.what}: ${s.reason}`).join('\n')}\n`);
    process.stdout.write('\nTest code is not rewritten. After applying, the result must collect, or everything is rolled back.\n\n');
    if (!plan.changes.length) {
      log('Nothing to change.');
      return;
    }
    if (o.dryRun) {
      log('Dry run: nothing was changed.');
      return;
    }
    if (!o.yes) {
      if (!process.stdin.isTTY) throw new Error('No interactive terminal: use --yes or --dry-run.');
      if (!(await askYesNo('Apply these changes?', false))) {
        log('Cancelled: nothing was changed.');
        return;
      }
    }
    const r = await applyPlan(root, plan);
    if (r.rolledBack) {
      log(`Rolled back: the result did not collect, nothing was changed.\n${r.output.trim().split('\n').slice(-15).join('\n')}`);
      process.exitCode = 1;
      return;
    }
    log(r.verified === true ? 'Applied and verified: every changed file collects.' : 'Applied. Not verified: install @playwright/test (TS) or pytest (Python) to check that the tests collect.');
    const created = plan.changes.filter((c) => c.action === 'create').map((c) => c.path);
    log(`\nReview: git status && git diff\nRevert: git restore . && git clean -f -- ${created.join(' ')}`);
  });

program.parseAsync().catch((err) => {
  log(err instanceof UnsupportedSpecError ? `Unsupported spec: ${err.message}` : `Error: ${err?.message ?? err}`);
  process.exitCode = 2;
});
