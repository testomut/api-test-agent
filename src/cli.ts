#!/usr/bin/env node
import { Command, Option } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { loadSpec, UnsupportedSpecError, type LoadedSpec } from './spec/loader.js';
import { lintSpec } from './spec/lint.js';
import { buildCatalog } from './spec/catalog.js';
import { SafeClient } from './audit/http.js';
import { probe } from './audit/probe.js';
import { runSchemathesis } from './audit/schemathesis.js';
import { resolveAuth } from './audit/auth.js';
import { buildReport, writeReport, type AuditReport } from './report/report.js';
import { cleanupSummary, generate, runGenerated, scenarioFindings } from './generate/generate.js';
import { summarize } from './generate/coverage.js';
import { openDraftPr } from './pr.js';
import type { Finding, Operation } from './types.js';
import { classifyTarget, loadConfig } from './config.js';
import { askAnswers, askYesNo, initProject, skillNotice } from './init.js';
import { findSpec, run } from './run.js';
import { applyPlan, buildPlan, gitState } from './adapt.js';
import { applyLogin, loginConfig } from './audit/login.js';
import { parseFailOn, runDiff } from './change/diff.js';
import { SUPPORTED_OASDIFF_VERSION } from './change/oasdiff.js';
import { normalizeSpec } from './change/normalize.js';
import { readSource } from './change/network.js';
import { validateManifest, validateRegistry } from './cases/validate.js';
import { validateScenarios, type ResolvedScenario } from './scenarios/dsl.js';
import { isUrl } from './change/network.js';
import { accountNotice, ACCOUNT_MODES, checkRegisterConfig, missingLoginVars, parseAccountMode, registerAccount, type AccountMode } from './audit/account.js';
import { AiRunner, describeAiError, RUNNERS, type RunnerKind } from './ai/runner.js';
import { proposeDependencies } from './ai/dependencies.js';
import { analyzeProject } from './discover/analyze.js';
import { loadApproved, type LoadedFixture } from './fixtures/fixtures.js';
import { candidateSummary, captureFixture } from './fixtures/capture.js';
import { maintain } from './maintain.js';
import { upsertDraftPr } from './pr.js';

const VERSION = '0.1.3';
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
  testAccount?: AccountMode;
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
    .option('--schemathesis-bin <path>', 'path to the schemathesis executable')
    .addOption(new Option('--test-account <mode>', 'with API_LOGIN: the account from .env (existing), a new one on every run (new), or the .env account and a new one only when it is refused (auto). Default: API_TEST_ACCOUNT, else asked').choices(ACCOUNT_MODES));
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

/**
 * API_LOGIN only: before anything logs in, settle which test account is used (asked when not
 * preset), register a new one if needed, and log in once so a bad account fails here, not in every test.
 */
async function prepareAccount(o: CommonOpts, agentLogin: boolean, suiteRun = false): Promise<void> {
  if (!loginConfig() || !(agentLogin || suiteRun)) return;
  if (!o.baseUrl) throw new Error('API_LOGIN is set but there is no --base-url / API_BASE_URL.');
  let mode = o.testAccount ?? parseAccountMode(process.env.API_TEST_ACCOUNT);
  if (!mode) {
    if (process.stdin.isTTY) {
      process.stderr.write(accountNotice());
      mode = (await askYesNo('Do you have a test account?', missingLoginVars().length === 0)) ? 'existing' : 'new';
    } else if (!missingLoginVars().length) {
      mode = 'existing';
      log('Test account: existing (credentials from the environment; no terminal to ask, set API_TEST_ACCOUNT to choose).');
    } else {
      throw new Error(`No terminal to ask about the test account and ${missingLoginVars().join(', ')} not set: put the account into .env, or set API_TEST_ACCOUNT=new (or --test-account new) to register one on every run.`);
    }
  }
  process.env.API_TEST_ACCOUNT = mode; // the generated suite started by --run reads it too
  if (mode === 'auto') {
    // The account from .env while it works; a new one only when it is missing or refused (e.g. after a reset).
    const missing = missingLoginVars();
    let why = missing.length ? `${missing.join(', ')} not set` : '';
    if (!why) {
      try {
        await applyLogin(o.baseUrl, log);
        log('Test account: auto, the account from .env works (nothing registered).');
        return;
      } catch (e) {
        const status = /HTTP (\d+)/.exec((e as Error).message)?.[1];
        if (!status || !['401', '403', '422'].includes(status)) throw e;
        why = `the account from .env is refused (HTTP ${status})`;
      }
    }
    if (!o.allowWrite) throw new Error(`Test account: ${why}. Registering a new one writes to the API: add --allow-write (test environments only), or fix the account in .env.`);
    checkRegisterConfig();
    const acc = await registerAccount(o.baseUrl);
    log(`Test account: auto, ${why}: registered ${acc.label} (stays on the server). This run, and the generated tests it starts, use it; .env is not changed.`);
    await applyLogin(o.baseUrl, log);
    return;
  }
  if (mode === 'existing') {
    const missing = missingLoginVars();
    if (missing.length) throw new Error(`Test account: put its credentials into .env: ${missing.map((v) => `${v}=...`).join(', ')}. Or use --test-account new to register one on every run.`);
    log('Test account: existing (from .env).');
  } else {
    if (!o.allowWrite) throw new Error('Registering new test accounts writes to the API: add --allow-write (test environments only), or use an existing account.');
    checkRegisterConfig(); // fail before anything is sent
    log('Test account: NEW on every run. Accounts stay on the server; nothing deletes them.');
    if (suiteRun) log('  The generated tests register one account per Playwright worker.');
    if (agentLogin) {
      const acc = await registerAccount(o.baseUrl);
      log(`  Registered ${acc.label} for the agent's own checks. Its password exists only in this run's memory.`);
    }
  }
  // Existing account: log in once now, so wrong credentials fail here instead of in every test.
  if (agentLogin || mode === 'existing') await applyLogin(o.baseUrl, log);
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
  await prepareAccount(o, o.probe || o.schemathesis);
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
  .option('--scenarios <file>', 'reviewed business scenarios (schemas/scenarios.schema.json); validated against the spec')
  .option('--fixtures <dir>', 'approved fixtures (strategy B): <dir>/<operationId>.json, compared field by field by policy')
  .option('--max-cases <n>', 'request-body negative cases per operation; the rest is reported as CASE_LIMIT_REACHED', '60')
  .addOption(new Option('--lang <lang>', 'language of generated tests (default: API_TESTS_LANG or typescript)').choices(['typescript', 'python']))
  .option('--run', 'run the generated tests once against --base-url (needs --allow-write)', false)
  .option('--draft-pr', 'commit to a new branch and open a GitHub Draft PR for review', false)
  .option('--ai', 'ask an AI console tool (your subscription, no API key) about unconfirmed dependencies; writes a PROPOSAL file, never applies it', false)
  .addOption(new Option('--ai-runner <runner>', 'console tool: claude, codex, or command (API_AI_COMMAND). Default: API_AI or claude').choices(RUNNERS))
  .option('--ai-max-calls <n>', 'AI call budget per run', '10')
  .option('--ai-model <id>', 'model name passed to the console tool (default: its own default)')
  .action(async (specArg: string | undefined, o: CommonOpts & { testsDir?: string; deps?: string; run: boolean; draftPr: boolean; lang?: 'typescript' | 'python'; ai: boolean; aiMaxCalls: string; maxCases: string; scenarios?: string; aiModel?: string; aiRunner?: RunnerKind; fixtures?: string }) => {
    const location = await resolveInputs(specArg, o);
    o.testsDir ??= cfg.testsDir;
    o.lang ??= cfg.testsLang;
    log(`Test language: ${o.lang}`);
    if (o.run && (!o.baseUrl || !o.allowWrite)) throw new Error('--run creates and deletes data: it needs --base-url and --allow-write.');
    await prepareAccount(o, o.probe || o.schemathesis, o.run);
    if (o.run && o.lang === 'python' && process.env.API_LOGIN && process.env.API_TEST_ACCOUNT === 'new') {
      throw new Error('A new account per run is supported for TypeScript suites only (for now): use an existing account for Python.');
    }
    const r = await runAudit(location, o);
    const deps = o.deps ? JSON.parse(await readFile(o.deps, 'utf8')) : undefined;
    if (o.ai) await aiProposals(r.spec.doc, r.ops, o.out, { maxCalls: Number(o.aiMaxCalls), model: o.aiModel, runner: o.aiRunner }, deps);
    log('Generating test suites (functional / contract / scenarios)…');
    const maxCases = Number(o.maxCases);
    if (!Number.isInteger(maxCases) || maxCases < 1) throw new Error(`--max-cases must be a positive integer, got "${o.maxCases}".`);
    let scenarios: ResolvedScenario[] | undefined;
    if (o.scenarios) {
      const checked = validateScenarios(JSON.parse(await readFile(o.scenarios, 'utf8')), r.ops);
      if (checked.errors.length) throw new Error(`${o.scenarios} is invalid:\n${checked.errors.map((e) => `  ${e.pointer || '(root)'}: ${e.reason}`).join('\n')}`);
      scenarios = checked.scenarios;
      log(`Scenarios: ${scenarios.length} reviewed business scenario(s) from ${o.scenarios}`);
    }
    const fx = o.fixtures ? await approvedFixtures(o.fixtures, r.spec, r.ops) : undefined;
    const gen = await generate(r.spec, r.ops, { outDir: o.testsDir!, deps, version: VERSION, lang: o.lang, maxCases, scenarios, ...(fx ?? {}) });
    for (const s of gen.scenarios) log(`  ${s.status.padEnd(9)} ${s.name}`);
    for (const f of gen.removed) log(`  REMOVED   ${relative(process.cwd(), f).replace(/\\/g, '/')} (generated earlier, no longer produced)`);
    if (o.run) {
      log('Running generated tests once (assertions are never changed to pass)…');
      await runGenerated(gen, { baseUrl: o.baseUrl! }, o.out, o.lang);
      for (const s of gen.scenarios.filter((x) => x.file)) log(`  ${s.status.padEnd(9)} ${s.name}`);
      const ids = gen.caseIdCheck;
      if (ids) {
        const bad = ids.missing.length + ids.duplicates.length + ids.unregistered.length;
        log(`Case IDs: ${ids.tests} test(s)${bad ? ` · WARNING: ${ids.missing.length} without an ID, ${ids.duplicates.length} duplicated, ${ids.unregistered.length} not in cases.json` : ', each with its own registered ID'}`);
        for (const t of ids.missing.slice(0, 10)) log(`  NO ID     ${t}`);
        for (const d of ids.duplicates.slice(0, 10)) log(`  DUPLICATE ${d}`);
        for (const u of ids.unregistered.slice(0, 10)) log(`  UNREGISTERED ${u}`);
      }
      if (gen.cleanupFailures.length) {
        log(`WARNING: cleanup could not remove ${gen.cleanupFailures.length} record(s); they stay on ${o.baseUrl}:`);
        for (const line of cleanupSummary(gen.cleanupFailures)) log(`  LEFT      ${line}`);
      }
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
        cleanupFailures: gen.cleanupFailures,
        ...(gen.caseIdCheck ? { caseIdCheck: gen.caseIdCheck } : {}),
      },
    });
    const files = await writeReport(report, o.out);
    const coverageFile = join(o.out, 'coverage-gaps.json');
    const byCode = summarize(gen.coverage);
    const generated = Object.fromEntries((['functional', 'contract', 'scenario'] as const).map((k) => [k, gen.coverage.reduce((n, c) => n + c.counts[k], 0)]));
    await writeFile(coverageFile, JSON.stringify({ spec: location, hash: r.spec.hash, summary: { operations: gen.coverage.length, generated, gapsByCode: byCode }, operations: gen.coverage }, null, 2) + '\n');
    if (Object.keys(byCode).length) log(`Coverage gaps: ${Object.entries(byCode).map(([k, n]) => `${k} ${n}`).join(', ')} (${coverageFile})`);
    log(`Report: ${files.md}`);
    log(`Coverage and gaps per operation: ${coverageFile}`);
    if (o.draftPr) {
      if (!gen.files.length) log('No tests generated: Draft PR skipped.');
      else log(`Draft PR: ${await openDraftPr({ files: [...gen.files, ...gen.removed, files.md], title: `test(api): generated contract and CRUD tests for ${report.spec.title ?? location}`, bodyFile: files.md, hash: r.spec.hash })}`);
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
  .option('--ai', 'ask an AI console tool about unconfirmed dependencies (proposal file for review)', false)
  .addOption(new Option('--ai-runner <runner>', 'console tool: claude, codex, or command (API_AI_COMMAND)').choices(RUNNERS))
  .option('--ai-max-calls <n>', 'AI call budget per run', '10')
  .option('--ai-model <id>', 'model name passed to the console tool')
  .action(async (o) => {
    log('api-test-agent run (read-only)\n');
    const r = await run({ root: process.cwd(), out: o.out, probe: o.probe, schemathesis: o.schemathesis, maxTime: Number(o.maxTime), log });
    if (o.ai) {
      const specRef = await findSpec(cfg, () => undefined);
      if (!specRef) log('AI: skipped, no spec.');
      else {
        const spec = await loadSpec(/^https?:/i.test(specRef) ? specRef : resolve(process.cwd(), specRef));
        await aiProposals(spec.doc, buildCatalog(spec.doc), o.out, { maxCalls: Number(o.aiMaxCalls), model: o.aiModel, runner: o.aiRunner });
      }
    }
    const a = r.analysis;
    const gaps = a.coverage.filter((c) => c.inSpec && !c.positiveTests.length && !c.generatedPositive).length;
    const postmanRequests = a.postman.reduce((s, c) => s + c.requests.length, 0);
    log(`\nSummary: ${a.tests.length} existing API tests · ${postmanRequests} Postman requests · ${a.edges.filter((e) => e.source !== 'candidate').length} dependencies · ${a.testIssues.length + a.postmanIssues.length} issues · ${gaps} operations without a positive test · ${a.proposals.length} proposals`);
    log(`Report: ${resolve(o.out, 'report.md')}`);
    if (r.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

const collect = (v: string, prev: string[] = []) => [...prev, v];
program
  .command('diff')
  .description('semantic diff of two OpenAPI specs: changes.json with a compatibility verdict per change (static, no API calls; needs oasdiff)')
  .requiredOption('--head <fileOrUrl>', 'the new spec (e.g. the PR head)')
  .option('--base <fileOrUrl>', 'the old spec; default: the head file at the Git merge base')
  .option('-o, --out <dir>', 'report directory', 'reports/api-agent/diff')
  .addOption(new Option('--format <format>', 'also write changes.md with markdown').choices(['json', 'markdown']).default('json'))
  .option('--fail-on <policy>', 'breaking | blocked | unknown | never (repeatable; default blocked)', collect, [])
  .option('--allow-network', 'allow downloading URL specs', false)
  .option('--allow-host <hostname>', 'only these hosts (repeatable); also lifts the default deny for a host', collect, [])
  .option('--allow-engine-version-mismatch', `continue with an oasdiff other than ${SUPPORTED_OASDIFF_VERSION}`, false)
  .option('--tests-dir <dir>', 'generated suite (snapshot baseline)', cfg.testsDir)
  .action(async (o: { head: string; base?: string; out: string; format: 'json' | 'markdown'; failOn: string[]; allowNetwork: boolean; allowHost: string[]; allowEngineVersionMismatch: boolean; testsDir: string }) => {
    const failOn = parseFailOn(o.failOn);
    const r = await runDiff({ ...o, failOn, allowHosts: o.allowHost, log });
    const s = r.set;
    log(`Base: ${s.baseRevision || '—'}${s.baseSource ? ` (${s.baseSource})` : ''} · head: ${s.headRevision} · oasdiff ${s.engine.version}`);
    const count = (k: string) => s.changes.filter((c) => c.breaking === k).length;
    log(`Changes: ${s.changes.length} (breaking ${count('yes')}, unknown ${count('unknown')}, test-relevant ${s.changes.filter((c) => c.testRelevant).length})`);
    if (!s.changes.some((c) => c.testRelevant) && !s.blocked.length) log('No test-relevant changes found.');
    for (const b of s.blocked) log(`  BLOCKED   ${b.code}: ${b.reason}`);
    for (const f of r.files) log(`Report: ${f}`);
    process.exitCode = r.exitCode;
  });

program
  .command('scenarios')
  .description('reviewed business scenarios')
  .command('validate')
  .description('check a scenarios file against the spec: operations, parameters, documented statuses, saved values, cleanup (exit 1 on an error)')
  .argument('<file>', 'scenarios JSON (schemas/scenarios.schema.json)')
  .requiredOption('--spec <fileOrUrl>', 'the spec the scenarios run against')
  .option('--allow-network', 'allow a URL --spec', false)
  .action(async (file: string, o: { spec: string; allowNetwork: boolean }) => {
    const spec = await loadSpec(isUrl(o.spec) ? (o.allowNetwork ? o.spec : (() => { throw new Error(`${o.spec} is a URL: pass --allow-network`); })()) : o.spec);
    const r = validateScenarios(JSON.parse(await readFile(file, 'utf8')), buildCatalog(spec.doc));
    log(`${r.scenarios.length} valid scenario(s), ${r.errors.length} error(s)`);
    for (const e of r.errors) log(`  ${e.pointer || '(root)'}: ${e.reason}`);
    if (r.errors.length) process.exitCode = 1;
  });

const registryCmd = program.command('registry').description('the case registry (_support/cases.json): stable operation, case and scenario IDs');
registryCmd
  .command('validate')
  .description('check cases.json: syntax always; with --spec also every active entry against that spec (exit 1 on an invalid entry)')
  .argument('[path]', 'cases.json', join(cfg.testsDir, '_support', 'cases.json'))
  .option('--spec <fileOrUrl>', 'also check active entries against this spec (normally the head spec)')
  .option('--require-spec', 'a missing --spec is a configuration error (exit 2)', false)
  .option('--allow-network', 'allow a URL --spec', false)
  .action(async (path: string, o: { spec?: string; requireSpec: boolean; allowNetwork: boolean }) => {
    if (o.requireSpec && !o.spec) throw new Error('--require-spec: pass --spec <head spec>.');
    const text = await readFile(path, 'utf8').catch(() => {
      throw new Error(`Cannot read ${path}.`);
    });
    const spec = o.spec ? normalizeSpec(await readSource(o.spec, { allowNetwork: o.allowNetwork, allowHosts: [] }), o.spec) : undefined;
    const r = validateRegistry(text, spec);
    log(`Syntax validation: ${r.syntaxValidation} · schema validation: ${r.schemaValidation}`);
    for (const e of r.errors) log(`  ${e.code}  ${e.pointer}  ${e.reason}`);
    for (const b of r.blocked) log(`  BLOCKED ${b.code}  ${b.pointer}  ${b.reason}`);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    if (r.errors.length || r.blocked.length) process.exitCode = 1;
  });

program
  .command('manifest')
  .description('generation manifest (_support/generation-manifest.json)')
  .command('validate')
  .description('compare generated files with their trusted hashes (exit 1 on a modified or missing generated file)')
  .option('--tests-dir <dir>', 'API_TESTS_DIR', cfg.testsDir)
  .action(async (o: { testsDir: string }) => {
    const r = await validateManifest(o.testsDir);
    log(`Manifest: ${r.files} file(s) · ${r.findings.length} finding(s)`);
    for (const f of r.findings) log(`  ${f.code}  ${f.reason}`);
    if (r.findings.some((f) => f.code !== 'CASE_REGISTRY_CHANGED')) process.exitCode = 1;
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

/** --ai: proposals for unconfirmed dependencies, written for review; never applied automatically. */
async function aiProposals(doc: any, ops: Operation[], outDir: string, opts: { maxCalls: number; model?: string; runner?: RunnerKind }, deps?: any) {
  let advisor: AiRunner;
  try {
    advisor = new AiRunner(opts);
    log(`\nAI proposals (opt-in --ai, via ${advisor.kind}): only operation names, field names and types of each candidate are sent.`);
  } catch (e) {
    log(`  ${describeAiError(e)}`);
    return;
  }
  const { proposals, depsFile } = await proposeDependencies(doc, ops, advisor, log, deps);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'ai-proposals.json'), JSON.stringify({ runner: advisor.kind, model: advisor.model ?? null, usage: advisor.usage, proposals }, null, 2) + '\n');
  if (!proposals.length) log('  No unconfirmed dependencies: nothing to ask.');
  for (const p of proposals.filter((x) => x.status !== 'proposed')) log(`  ${p.status.toUpperCase()} ${p.create} → ${p.itemOperations.join(', ')}: ${p.reason}`);
  if (depsFile.scenarios.length) {
    const file = join(outDir, 'ai-deps.proposed.json');
    await writeFile(file, JSON.stringify(depsFile, null, 2) + '\n');
    log(`  ${depsFile.scenarios.length} proposal(s) passed the spec check: ${file}`);
    log(`  Review it, then use it: generate --deps ${file.replace(/\\/g, '/')}`);
  }
  log(`  ${advisor.summary()}`);
}

/** Approved fixtures of a directory; invalid ones are logged and become INVALID_REVIEWED_CONFIG gaps. */
async function approvedFixtures(dir: string, spec: LoadedSpec, ops: Operation[]): Promise<{ fixtures: LoadedFixture[]; fixtureErrors: { file: string; operationId?: string; errors: string[] }[] }> {
  const r = await loadApproved(dir, spec.doc, ops);
  log(`Fixtures: ${r.fixtures.length} approved fixture(s) from ${dir}${r.errors.length ? `, ${r.errors.length} invalid (not used)` : ''}`);
  for (const e of r.errors) log(`  INVALID   ${e.file}: ${e.errors.join('; ')}`);
  return { fixtures: r.fixtures, fixtureErrors: r.errors };
}

async function reviewedInputs(o: { deps?: string; scenarios?: string; fixtures?: string }, spec: LoadedSpec, ops: Operation[]) {
  const deps = o.deps ? JSON.parse(await readFile(o.deps, 'utf8')) : undefined;
  let scenarios: ResolvedScenario[] | undefined;
  if (o.scenarios) {
    const checked = validateScenarios(JSON.parse(await readFile(o.scenarios, 'utf8')), ops);
    if (checked.errors.length) throw new Error(`${o.scenarios} is invalid:\n${checked.errors.map((e) => `  ${e.pointer || '(root)'}: ${e.reason}`).join('\n')}`);
    scenarios = checked.scenarios;
  }
  const fx = o.fixtures ? await approvedFixtures(o.fixtures, spec, ops) : {};
  return { deps, scenarios, ...fx };
}

program
  .command('maintain')
  .description('after a spec change: diff, regenerate (deterministic), validate, then one Draft PR per suite with a summary; never merges')
  .argument('[spec]', 'the new OpenAPI spec (default: API_SPEC_URL)')
  .option('--base <fileOrUrl>', 'the old spec; default: the spec at the Git merge base')
  .option('--tests-dir <dir>', 'generated suite', cfg.testsDir)
  .addOption(new Option('--lang <lang>', 'language of the suite').choices(['typescript', 'python']))
  .option('--deps <file>', 'reviewed dependencies')
  .option('--scenarios <file>', 'reviewed business scenarios')
  .option('--fixtures <dir>', 'approved fixtures')
  .option('--max-cases <n>', 'request-body negative cases per operation', '60')
  .option('-o, --out <dir>', 'report directory', 'reports/api-agent/maintain')
  .option('--draft-pr', 'commit to the bot branch and open or update its Draft PR (gh)', false)
  .option('--allow-network', 'allow URL specs', false)
  .action(async (specArg: string | undefined, o: { base?: string; testsDir: string; lang?: 'typescript' | 'python'; deps?: string; scenarios?: string; fixtures?: string; maxCases: string; out: string; draftPr: boolean; allowNetwork: boolean }) => {
    const location = specArg ?? (await findSpec(cfg, log));
    if (!location) throw new Error('No spec found: pass it as an argument or set API_SPEC_URL.');
    const { spec, ops } = await load(location);
    const inputs = await reviewedInputs(o, spec, ops);
    const r = await maintain({
      location, spec, ops, testsDir: o.testsDir, base: o.base, out: o.out, draftPr: o.draftPr, allowNetwork: o.allowNetwork, log,
      generate: { version: VERSION, lang: o.lang ?? cfg.testsLang, maxCases: Number(o.maxCases), ...inputs },
    });
    log(`Summary: ${r.summaryFile}`);
    if (!r.valid) process.exitCode = 1;
  });

const fixturesCmd = program.command('fixtures').description('approved fixtures (strategy B): capture candidates, propose refreshes for review');
const captureOptions = (c: Command) =>
  c
    .argument('[spec]', 'OpenAPI spec (default: API_SPEC_URL)')
    .requiredOption('--operation <operationId>', 'the GET list operation to capture')
    .option('-u, --base-url <url>', 'TEST environment to read from (default: API_BASE_URL)')
    .option('--query <k=v>', 'query parameter of the read (repeatable)', collect, [])
    .option('--items <pointer>', 'JSON pointer to the array in the response')
    .option('--id <pointer>', 'field that identifies an element, e.g. /id')
    .option('--deps <file>', 'reviewed deps file: its "collection" mapping supplies items / id / policies / paging')
    .option('--approved <dir>', 'approved fixtures (read only)', 'fixtures/approved')
    .option('--candidates <dir>', 'where candidates are written', 'fixtures/candidates');
type CaptureCli = { operation: string; baseUrl?: string; query: string[]; items?: string; id?: string; deps?: string; approved: string; candidates: string };
async function capture(specArg: string | undefined, o: CaptureCli) {
  const location = specArg ?? (await findSpec(cfg, log));
  if (!location) throw new Error('No spec found: pass it as an argument or set API_SPEC_URL.');
  const baseUrl = o.baseUrl ?? cfg.baseUrl;
  if (!baseUrl) throw new Error('Pass --base-url (a TEST environment) or set API_BASE_URL.');
  const { spec, ops } = await load(location);
  const deps = o.deps ? JSON.parse(await readFile(o.deps, 'utf8')) : undefined;
  const r = await captureFixture({
    doc: spec.doc, ops, baseUrl, operationId: o.operation, approvedDir: o.approved, candidatesDir: o.candidates,
    query: Object.fromEntries(o.query.map((q) => [q.split('=')[0], q.split('=').slice(1).join('=')])),
    ...(o.items !== undefined ? { items: o.items } : {}),
    ...(o.id ? { id: o.id } : {}),
    collections: (deps?.scenarios ?? []).map((s: any) => s.collection).filter(Boolean),
    headers: process.env.API_TOKEN ? { authorization: `Bearer ${process.env.API_TOKEN}` } : {},
  });
  log(`Candidate: ${r.candidateFile} (${r.candidate.expected.length} element(s)); approved fixtures are never written.`);
  if (r.diff) log(`Against ${r.approvedFile}: added ${r.diff.added.length}, removed ${r.diff.removed.length}, fields changed ${r.diff.changed.length}`);
  return r;
}
captureOptions(fixturesCmd.command('capture').description('read a collection from a test environment and write a CANDIDATE fixture (never an approved one)')).action(async (specArg: string | undefined, o: CaptureCli) => {
  await capture(specArg, o);
});
captureOptions(fixturesCmd.command('refresh').description('capture a candidate and, when it differs from the approved fixture, propose it in a Draft PR (one per operation)'))
  .option('--draft-pr', 'commit the candidate to the bot branch and open or update its Draft PR (gh)', false)
  .option('-o, --out <dir>', 'report directory', 'reports/api-agent/fixtures')
  .action(async (specArg: string | undefined, o: CaptureCli & { draftPr: boolean; out: string }) => {
    const r = await capture(specArg, o);
    if (r.diff && !r.diff.added.length && !r.diff.removed.length && !r.diff.changed.length) {
      log('The candidate matches the approved fixture under its policies: nothing to refresh.');
      return;
    }
    await mkdir(o.out, { recursive: true });
    const body = join(o.out, `${o.operation}.md`);
    await writeFile(body, candidateSummary(r));
    log(`Review summary: ${body}`);
    if (o.draftPr) {
      const pr = upsertDraftPr({ branch: `api-agent/fixtures-${o.operation}`, files: [r.candidateFile], title: `test(api): fixture candidate for ${o.operation} (review before approving)`, bodyFile: body, commitMessage: [`test(api): fixture candidate for ${o.operation}`, 'Captured by api-test-agent. The approved fixture is unchanged until a person approves this candidate.'] });
      log(pr ? `Draft PR ${pr.updated ? 'updated' : 'opened'}: ${pr.url}` : 'Nothing new to commit: Draft PR unchanged.');
    }
  });

program.parseAsync().catch((err) => {
  log(err instanceof UnsupportedSpecError ? `Unsupported spec: ${err.message}` : `Error: ${err?.message ?? err}`);
  process.exitCode = 2;
});
