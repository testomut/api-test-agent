import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding, LintProblem, Operation, Status } from '../types.js';

export interface OperationReport {
  key: string;
  operationId?: string;
  testabilityIssues: string[];
  probe?: Finding;
  schemathesis?: Finding;
  functional?: Finding;
}

export interface AuditReport {
  tool: { name: 'api-test-agent'; version: string };
  generatedAt: string;
  mode: 'audit' | 'generate';
  spec: { location: string; title?: string; version: string; hash: string; validationErrors: string[] };
  target: { baseUrl?: string; network: boolean; allowWrite: boolean };
  lint: { errors: number; warnings: number; problems: LintProblem[] };
  operations: OperationReport[];
  coverage: {
    operations: number;
    contractExercised: number;
    contractPassed: number;
    contractMismatch: number;
    functionalScenarios: number;
    operationsInFunctionalScenarios: number;
    notChecked: number;
  };
  schemathesis?: { command: string; exitCode: number | null };
  generated?: {
    files: string[];
    scenarios: { name: string; status: Status; reason: string; operations: string[] }[];
    /** Test data cleanup could not remove during the run: it stays on the target. */
    cleanupFailures?: { operation: string; id: string; status: number | string }[];
  };
}

const CONTRACT_VERDICT: Status[] = ['PASS', 'CONTRACT_MISMATCH'];

export function buildReport(input: Omit<AuditReport, 'coverage' | 'operations' | 'tool' | 'generatedAt'> & { ops: Operation[]; findings: Finding[] }): AuditReport {
  const { ops, findings, ...rest } = input;
  const operations: OperationReport[] = ops.map((op) => {
    const of = findings.filter((f) => f.operation === op.key);
    return {
      key: op.key,
      operationId: op.operationId,
      testabilityIssues: op.testabilityIssues,
      probe: of.find((f) => f.source === 'probe'),
      schemathesis: of.find((f) => f.source === 'schemathesis'),
      functional: of.find((f) => f.source === 'generate'),
    };
  });
  const contract = (o: OperationReport) => [o.probe, o.schemathesis].filter((f): f is Finding => !!f && CONTRACT_VERDICT.includes(f.status));
  const exercised = operations.filter((o) => contract(o).length);
  const mismatch = exercised.filter((o) => contract(o).some((f) => f.status === 'CONTRACT_MISMATCH'));
  const functionalOps = operations.filter((o) => o.functional && o.functional.status !== 'BLOCKED');
  return {
    tool: { name: 'api-test-agent', version: '0.1.3' },
    generatedAt: new Date().toISOString(),
    ...rest,
    operations,
    coverage: {
      operations: ops.length,
      contractExercised: exercised.length,
      contractPassed: exercised.length - mismatch.length,
      contractMismatch: mismatch.length,
      functionalScenarios: rest.generated?.scenarios.filter((s) => s.status !== 'BLOCKED').length ?? 0,
      operationsInFunctionalScenarios: functionalOps.length,
      notChecked: operations.filter((o) => !contract(o).length && !functionalOps.includes(o)).length,
    },
  };
}

const ICON: Record<Status, string> = { PASS: '✅ PASS', CONTRACT_MISMATCH: '❌ CONTRACT_MISMATCH', TEST_FAILURE: '⚠️ TEST_FAILURE', BLOCKED: '⛔ BLOCKED', NOT_RUN: '⏸ NOT_RUN' };
const cell = (f?: Finding) => (f ? ICON[f.status] : '-');
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(r: AuditReport): string {
  const c = r.coverage;
  const L: string[] = [];
  L.push(`# API Test Agent report: ${r.spec.title ?? r.spec.location}`, '');
  L.push(`- Mode: \`${r.mode}\` · generated ${r.generatedAt}`);
  L.push(`- Spec: \`${r.spec.location}\` (OpenAPI ${r.spec.version}, hash \`${r.spec.hash}\`)`);
  L.push(`- Target: ${r.target.network ? `\`${r.target.baseUrl}\`` : 'no network calls (static analysis only)'}${r.target.allowWrite ? ' · **write methods allowed**' : ' · read-only'}`, '');

  L.push('## Coverage (counted separately, never merged into one %)', '');
  L.push('| Metric | Value |', '|---|---|');
  L.push(`| Operations in spec | ${c.operations} |`);
  L.push(`| Contract checked (got a verdict) | ${c.contractExercised} |`);
  L.push(`| ↳ matched contract | ${c.contractPassed} |`);
  L.push(`| ↳ contract mismatch | ${c.contractMismatch} |`);
  L.push(`| Functional scenarios generated | ${c.functionalScenarios} (covering ${c.operationsInFunctionalScenarios} operations) |`);
  L.push(`| Not checked at all | ${c.notChecked} |`, '');
  L.push('> PASS means the executed checks passed. It does not mean the endpoint\'s business logic is covered.', '');

  L.push('## Operations', '');
  L.push('| Operation | Probe | Schemathesis | Functional | Testability issues |', '|---|---|---|---|---|');
  for (const o of r.operations) {
    L.push(`| \`${o.key}\` | ${cell(o.probe)} | ${cell(o.schemathesis)} | ${cell(o.functional)} | ${o.testabilityIssues.length || ''} |`);
  }
  L.push('');

  const problems = r.operations.flatMap((o) => [o.probe, o.schemathesis, o.functional].filter((f): f is Finding => !!f && f.status !== 'PASS'));
  const mism = problems.filter((f) => f.status === 'CONTRACT_MISMATCH' || f.status === 'TEST_FAILURE');
  if (mism.length) {
    L.push('## Contract mismatches and failures', '', 'The spec is treated as the requirement. Each item needs a human decision: fix the API, or fix the spec.', '');
    for (const f of mism) {
      L.push(`### \`${f.operation}\` · ${ICON[f.status]} (${f.source})`, '', f.reason, '');
      if (f.details) L.push('```', typeof f.details === 'string' ? f.details : JSON.stringify(f.details, null, 2), '```', '');
    }
  }
  const blocked = problems.filter((f) => f.status === 'BLOCKED' || f.status === 'NOT_RUN');
  if (blocked.length) {
    L.push('## Blocked / not run (with the exact reason)', '', '| Operation | Source | Status | Reason |', '|---|---|---|---|');
    for (const f of blocked) L.push(`| \`${f.operation}\` | ${f.source} | ${ICON[f.status]} | ${esc(f.reason)} |`);
    L.push('');
  }
  const issues = r.operations.filter((o) => o.testabilityIssues.length);
  if (issues.length) {
    L.push('## Testability issues in the spec', '');
    for (const o of issues) for (const i of o.testabilityIssues) L.push(`- \`${o.key}\`: ${i}`);
    L.push('');
  }
  const left = r.generated?.cleanupFailures ?? [];
  if (left.length) {
    L.push('## ⚠️ Test data left on the target', '', `Cleanup could not remove ${left.length} record(s) created by the run. Remove them by hand, or fix the cleanup (e.g. an account allowed to delete) before running again.`, '');
    L.push('| Cleanup operation | Status | Id |', '|---|---|---|', ...left.map((f) => `| \`${f.operation}\` | ${f.status} | \`${f.id}\` |`), '');
  }
  if (r.generated) {
    L.push('## Generated functional scenarios', '');
    for (const s of r.generated.scenarios) L.push(`- **${s.name}** · ${ICON[s.status]}: ${s.reason}`);
    if (r.generated.files.length) L.push('', 'Files:', ...r.generated.files.map((f) => `- \`${f}\``));
    L.push('');
  }
  L.push(`## Spec quality (Redocly lint): ${r.lint.errors} errors, ${r.lint.warnings} warnings`, '');
  if (r.spec.validationErrors.length) L.push('Structural validation errors:', ...r.spec.validationErrors.map((e) => `- ${e}`), '');
  for (const p of r.lint.problems.slice(0, 30)) L.push(`- ${p.severity === 'error' ? '❌' : '⚠️'} \`${p.ruleId}\` ${esc(p.message)}${p.pointer ? ` (\`${p.pointer}\`)` : ''}`);
  if (r.lint.problems.length > 30) L.push(`- …and ${r.lint.problems.length - 30} more in report.json`);
  if (r.schemathesis) L.push('', '## Reproduce the Schemathesis run', '', '```sh', r.schemathesis.command, '```');
  return L.join('\n') + '\n';
}

export async function writeReport(r: AuditReport, outDir: string): Promise<{ json: string; md: string }> {
  await mkdir(outDir, { recursive: true });
  const json = join(outDir, 'report.json');
  const md = join(outDir, 'report.md');
  await writeFile(json, JSON.stringify(r, null, 2) + '\n');
  await writeFile(md, toMarkdown(r));
  return { json, md };
}
