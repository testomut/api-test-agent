/**
 * Coverage summary and quality gates for a generated suite (docs/SUPPORT_MATRIX.md, "Reporting and CI").
 *
 *   npx tsx scripts/coverage-summary.ts --spec demo-api/openapi.yaml --coverage reports/generate/coverage-gaps.json \
 *     --registry tests/api/_support/cases.json [--parity tests/api-python/_support/cases.json] \
 *     [--tests-dir tests/api] [--out reports/coverage-summary.md] \
 *     [--baseline ci/coverage-baseline.demo.json] [--write-baseline]
 *
 * Writes a Markdown table per operation (suites, active case IDs, checked / unchecked statuses, gaps with code and
 * location) and a JSON next to it. Gates (exit 1, each failure listed):
 *   - an active case ID of the baseline is no longer active (coverage decreased) unless the baseline is updated;
 *   - a gap (code + operation + location) that the baseline does not list (unexplained new gap);
 *   - with --parity: TypeScript and Python active case IDs differ;
 *   - with --tests-dir: a write test without cleanup in `finally` (TypeScript) / fixture teardown or finally (Python).
 * --write-baseline records the current state as the expected one (a reviewed change, committed with the PR).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadSpec } from '../src/spec/loader.js';
import { buildCatalog } from '../src/spec/catalog.js';
import { cleanupProblems, compareBaseline } from '../src/report/quality-gates.js';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const flag = (name: string) => args.includes(name);
const specFile = opt('--spec');
const coverageFile = opt('--coverage');
const registryFile = opt('--registry');
if (!specFile || !coverageFile || !registryFile) {
  console.error('usage: coverage-summary.ts --spec <spec> --coverage <coverage-gaps.json> --registry <cases.json> [--parity <cases.json>] [--tests-dir <dir>] [--out <file.md>] [--baseline <file>] [--write-baseline]');
  process.exit(2);
}

interface Gap {
  code: string;
  operation: string;
  location: string;
  rule?: string;
  reason: string;
}

const spec = await loadSpec(specFile);
const ops = buildCatalog(spec.doc);
const coverage = JSON.parse(readFileSync(coverageFile, 'utf8'));
const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
const active = (reg: any) => Object.entries<any>(reg.cases).filter(([, c]) => c.status !== 'retired').map(([id]) => id).sort();
const activeIds = active(registry);

// Case IDs per operation: its own cases (op_ subject) and scenarios whose primary operation it is.
const opKeyOfUid = new Map(Object.entries<any>(registry.operations).map(([uid, o]) => [uid, `${o.method} ${o.path}`]));
const primaryOfScenario = new Map(Object.entries<any>(registry.scenarios ?? {}).map(([uid, s]) => [uid, s.primaryOperationUid]));
const idsByOp = new Map<string, string[]>();
for (const id of activeIds) {
  const subject = id.split(':')[1];
  const key = opKeyOfUid.get(subject.startsWith('scn_') ? primaryOfScenario.get(subject) : subject) ?? '(unknown)';
  idsByOp.set(key, [...(idsByOp.get(key) ?? []), id]);
}

const gaps: Gap[] = [];
const rows: string[] = [];
const totals = { functional: 0, contract: 0, scenario: 0, cases: 0, documented: 0, checked: 0 };
for (const c of coverage.operations) {
  const op = ops.find((o) => o.key === c.operation);
  const documented = (op?.responses ?? []).map((r) => r.status);
  const unchecked = c.uncheckedStatuses as { status: string; code: string }[];
  const checked = documented.filter((s) => !unchecked.some((u) => u.status === s));
  for (const g of c.gaps) gaps.push({ code: g.code, operation: c.operation, location: g.location, ...(g.rule ? { rule: g.rule } : {}), reason: g.reason });
  for (const u of unchecked) gaps.push({ code: u.code, operation: c.operation, location: `response.status#/${u.status}`, reason: `documented ${u.status} is not exercised` });
  for (const [suite, s] of Object.entries<any>(c.suites)) if (!s.generated && s.missingCode && !(suite === 'scenario' && s.missingCode === 'UNCONFIRMED_BUSINESS_RULE' && !c.lifecycle)) gaps.push({ code: s.missingCode, operation: c.operation, location: `suite#/${suite}`, reason: `${suite} suite: no cases` });
  const n = idsByOp.get(c.operation)?.length ?? 0;
  totals.functional += c.counts.functional;
  totals.contract += c.counts.contract;
  totals.scenario += c.counts.scenario;
  totals.cases += n;
  totals.documented += documented.length;
  totals.checked += checked.length;
  const cell = (k: string) => (c.counts[k] ? String(c.counts[k]) : `— ${c.suites[k]?.missingCode ?? ''}`.trim());
  const gapCell = [...unchecked.map((u: any) => `${u.status}: ${u.code}`), ...c.gaps.map((g: any) => `${g.code} @ ${g.location}`)];
  rows.push(`| ${c.operation} | ${cell('functional')} | ${cell('contract')} | ${cell('scenario')} | ${n} | ${checked.join(', ') || '—'} | ${gapCell.length ? gapCell.join('<br>') : '—'} |`);
}

const gapKey = (g: Gap) => `${g.code} ${g.operation} ${g.location}${g.rule ? ` ${g.rule}` : ''}`;
const byCode: Record<string, number> = {};
for (const g of gaps) byCode[g.code] = (byCode[g.code] ?? 0) + 1;

// ---------------------------------------------------------------- gates
const failures: string[] = [];
let parity: { ok: boolean; onlyHere: string[]; onlyThere: string[] } | undefined;
const parityFile = opt('--parity');
if (parityFile) {
  const other = new Set(active(JSON.parse(readFileSync(parityFile, 'utf8'))));
  const here = new Set(activeIds);
  parity = { ok: true, onlyHere: activeIds.filter((id) => !other.has(id)), onlyThere: [...other].filter((id) => !here.has(id)) };
  parity.ok = !parity.onlyHere.length && !parity.onlyThere.length;
  if (!parity.ok) failures.push(`TS/Python parity: ${parity.onlyHere.length} case(s) only in ${registryFile}, ${parity.onlyThere.length} only in ${parityFile}`);
}

// Cleanup: every test that creates data must remove it in finally (TS) or through a fixture / finally (Python).
const cleanup: { file: string; problem: string }[] = [];
const testsDir = opt('--tests-dir');
if (testsDir) {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const file of walk(testsDir).filter((f) => /\.spec\.ts$|[\\/]test_\w+\.py$/.test(f))) {
    for (const p of cleanupProblems(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), file.endsWith('.ts') ? 'typescript' : 'python')) cleanup.push({ file, problem: `${p.problem}: ${p.test}` });
  }
  for (const c of cleanup) failures.push(`cleanup: ${c.file}: ${c.problem}`);
}

const baselineFile = opt('--baseline');
const current = { schemaVersion: 1, activeCaseIds: activeIds, gaps: [...new Set(gaps.map(gapKey))].sort() };
let baselineDiff: { lostCases: string[]; newCases: string[]; newGaps: string[]; closedGaps: string[] } | undefined;
if (baselineFile && flag('--write-baseline')) {
  mkdirSync(dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n');
  console.log(`baseline written: ${baselineFile} (${activeIds.length} active cases, ${current.gaps.length} gaps)`);
} else if (baselineFile) {
  if (!existsSync(baselineFile)) failures.push(`baseline ${baselineFile} is missing: create it with --write-baseline`);
  else {
    baselineDiff = compareBaseline(JSON.parse(readFileSync(baselineFile, 'utf8')), current);
    for (const id of baselineDiff.lostCases) failures.push(`case no longer active (update the baseline if intended): ${id}`);
    for (const g of baselineDiff.newGaps) failures.push(`unexplained new gap (update the baseline if intended): ${g}`);
  }
}

// ---------------------------------------------------------------- report
const md = [
  `## Coverage summary: ${spec.doc.info?.title ?? specFile}`,
  '',
  `Operations ${coverage.operations.length} · tests: functional ${totals.functional}, contract ${totals.contract}, scenarios ${totals.scenario} · active case IDs ${activeIds.length} · documented statuses checked ${totals.checked}/${totals.documented}`,
  '',
  '| Operation | functional | contract | scenarios | case IDs | statuses checked | not covered (code @ location) |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  '',
  `**Gaps by code:** ${Object.entries(byCode).sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
  ...(parity ? ['', `**TS/Python parity:** ${parity.ok ? 'same active case IDs' : `DIFFERENT (${parity.onlyHere.length} / ${parity.onlyThere.length})`}`] : []),
  ...(testsDir ? ['', `**Cleanup:** ${cleanup.length ? `${cleanup.length} write test(s) without cleanup in finally` : 'every write test cleans up in finally / a fixture'}`] : []),
  ...(baselineDiff
    ? ['', `**Against the baseline:** cases +${baselineDiff.newCases.length} / lost ${baselineDiff.lostCases.length} · gaps new ${baselineDiff.newGaps.length} / closed ${baselineDiff.closedGaps.length}`, ...baselineDiff.closedGaps.map((g) => `- closed: ${g}`), ...baselineDiff.newGaps.map((g) => `- NEW: ${g}`)]
    : []),
  ...(failures.length ? ['', '**Quality gates failed:**', ...failures.map((f) => `- ${f}`)] : ['', '**Quality gates:** passed']),
].join('\n');
const out = opt('--out');
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md + '\n');
  writeFileSync(out.replace(/\.md$/, '') + '.json', JSON.stringify({ totals, activeCaseIds: activeIds.length, gapsByCode: byCode, gaps, parity, cleanup, baseline: baselineDiff, failures }, null, 2) + '\n');
}
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n', { flag: 'a' });
console.log(md);
process.exit(failures.length ? 1 : 0);
