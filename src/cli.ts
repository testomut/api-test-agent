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

const VERSION = '0.1.0';
const log = (m: string) => process.stderr.write(m + '\n');

interface CommonOpts {
  baseUrl?: string;
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
    .argument('<spec>', 'OpenAPI 3.x file or URL')
    .option('-u, --base-url <url>', 'base URL of a TEST environment (required for network checks)')
    .option('--probe', 'send one non-destructive request per safe operation', false)
    .option('--schemathesis', 'run a bounded Schemathesis contract run', false)
    .option('--allow-write', 'allow POST/PUT/PATCH/DELETE (test environments only)', false)
    .option('--max-requests <n>', 'probe request budget', '100')
    .option('--rps <n>', 'requests per second limit', '5')
    .option('--timeout <sec>', 'per-request timeout in seconds', '10')
    .option('--max-examples <n>', 'Schemathesis cases per operation', '25')
    .option('--max-time <sec>', 'Schemathesis time budget in seconds', '120')
    .option('--seed <n>', 'Schemathesis seed (reproducible runs)', '42')
    .option('-o, --out <dir>', 'output directory for reports', 'reports')
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

common(program.command('audit').description('analyse a spec (and, if allowed, a test environment) without generating tests')).action(async (location: string, o: CommonOpts) => {
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
  .option('--tests-dir <dir>', 'where generated tests are written', 'tests/generated')
  .option('--deps <file>', 'JSON file with human-confirmed dependencies')
  .option('--run', 'run the generated tests once against --base-url (needs --allow-write)', false)
  .option('--draft-pr', 'commit to a new branch and open a GitHub Draft PR for review', false)
  .action(async (location: string, o: CommonOpts & { testsDir: string; deps?: string; run: boolean; draftPr: boolean }) => {
    if (o.run && (!o.baseUrl || !o.allowWrite)) throw new Error('--run creates and deletes data: it needs --base-url and --allow-write.');
    const r = await runAudit(location, o);
    const deps = o.deps ? JSON.parse(await readFile(o.deps, 'utf8')) : undefined;
    log('Generating functional scenarios…');
    const gen = await generate(r.spec, r.ops, { outDir: o.testsDir, deps, version: VERSION });
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

program.parseAsync().catch((err) => {
  log(err instanceof UnsupportedSpecError ? `Unsupported spec: ${err.message}` : `Error: ${err?.message ?? err}`);
  process.exitCode = 2;
});
