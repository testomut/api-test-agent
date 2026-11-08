import type { RunResult } from '../run.js';
import type { Finding } from '../types.js';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const ICON = { ok: '✅', warn: '⚠️', fail: '❌', skip: '➖' } as const;
const n = (list: unknown[]) => (list.length ? String(list.length) : '-');

function mermaid(r: RunResult): string[] {
  const edges = r.analysis.edges.filter((e) => e.source !== 'candidate');
  if (!edges.length) return [];
  const ids = new Map<string, string>();
  const id = (k: string) => {
    if (!ids.has(k)) ids.set(k, `op${ids.size}`);
    return ids.get(k)!;
  };
  const style: Record<string, string> = { 'openapi-links': '-->', 'existing-tests': '==>', postman: '-.->' };
  const L = ['```mermaid', 'flowchart LR'];
  for (const e of edges) L.push(`  ${id(e.from)}["${e.from}"] ${style[e.source]}|${e.variable ?? ''}${e.cleanup ? ' cleanup' : ''}| ${id(e.to)}["${e.to}"]`);
  L.push('```', '', 'Solid arrow: OpenAPI links · thick arrow: existing tests · dotted arrow: Postman. Label: the value passed along.', '');
  return L;
}

export function renderRunReport(r: RunResult): string {
  const a = r.analysis;
  const L: string[] = [];
  L.push(`# API test analysis${r.spec?.title ? `: ${r.spec.title}` : ''}`, '', `Generated ${r.generatedAt} by \`api-test-agent run\`. Read-only: nothing in the project was changed.`, '');

  // Summary
  const apiTests = a.inventory.filter((f) => f.kind === 'playwright-api').length;
  const gaps = a.coverage.filter((c) => c.inSpec && !c.positiveTests.length && !c.generatedPositive).length;
  const mismatches = new Set(r.contract.filter((f) => f.status === 'CONTRACT_MISMATCH').map((f) => f.operation));
  L.push('## Summary', '', '| | |', '|---|---|');
  L.push(`| Spec | ${r.spec ? `\`${r.spec.location}\` · ${r.spec.operations} operations` : 'not found'} |`);
  L.push(`| Existing API test files | ${apiTests} (${a.tests.length} tests) |`);
  L.push(`| Postman | ${a.postman.length ? a.postman.map((c) => `${c.name}: ${c.requests.length} requests`).join('; ') : 'none'} |`);
  L.push(`| Dependencies found | ${a.edges.filter((e) => e.source !== 'candidate').length} confirmed, ${a.edges.filter((e) => e.source === 'candidate').length} to confirm |`);
  L.push(`| Operations without a positive test | ${gaps} |`);
  L.push(`| Contract mismatches on the live API | ${mismatches.size} |`);
  L.push(`| Issues in existing tests | ${a.testIssues.length + a.postmanIssues.length} |`);
  L.push(`| Proposals | ${a.proposals.length} |`, '');

  // Environment
  L.push('## 1. Environment checks', '', '| Check | Result | Detail |', '|---|---|---|');
  for (const c of r.checks) L.push(`| ${c.name} | ${ICON[c.status]} | ${esc(c.detail)} |`);
  L.push('');

  // Inventory
  L.push('## 2. Test inventory', '');
  const byKind = new Map<string, string[]>();
  for (const f of a.inventory) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.path]);
  if (!byKind.size) L.push('No test files found. Start with `npx api-test-agent generate`.', '');
  else {
    L.push('| Kind | Files | Handling |', '|---|---|---|');
    const handling: Record<string, string> = {
      'playwright-api': 'analysed: calls, preconditions, dependencies, issues',
      'postman-collection': 'analysed: requests, assertions, variable chains',
      'playwright-ui': 'listed only, never modified',
      cypress: 'listed only (analysis planned)',
      'pytest-api': 'listed only (analysis planned)',
      'jest-or-vitest-api': 'listed only (analysis planned)',
      'other-test': 'listed only, never modified',
    };
    for (const [k, files] of byKind) L.push(`| ${k} | ${files.length} | ${handling[k] ?? ''} |`);
    L.push('');
    if (a.apiTestsOutsideDir.length) L.push(`API tests outside \`${r.config.testsDir}\`: ${a.apiTestsOutsideDir.map((p) => `\`${p}\``).join(', ')}. Set \`API_TESTS_DIR\` or move them (see proposals).`, '');
  }

  // Coverage map
  L.push('## 3. Coverage map', '', 'Counted separately: existing tests, Postman and generated files are never merged into one percentage.', '');
  L.push('| Operation | In spec | Positive tests | Negative tests | Used as precondition | Postman | Generated (+/−) | Live contract |', '|---|---|---|---|---|---|---|---|');
  const contractOf = (op: string) => {
    const fs = r.contract.filter((f: Finding) => f.operation === op);
    if (fs.some((f) => f.status === 'CONTRACT_MISMATCH')) return '❌ mismatch';
    if (fs.some((f) => f.status === 'PASS')) return '✅';
    if (fs.some((f) => f.status === 'BLOCKED')) return '⛔ blocked';
    return '-';
  };
  for (const c of [...a.coverage].sort((x, y) => x.operation.split(' ')[1].localeCompare(y.operation.split(' ')[1]) || x.operation.localeCompare(y.operation))) {
    L.push(`| \`${c.operation}\` | ${c.inSpec ? 'yes' : '**no**'} | ${n(c.positiveTests)} | ${n(c.negativeTests)} | ${c.usedAsPrecondition || '-'} | ${n(c.postman)} | ${c.generatedPositive ? '+' : ''}${c.generatedNegative ? '−' : ''}${!c.generatedPositive && !c.generatedNegative ? '-' : ''} | ${contractOf(c.operation)} |`);
  }
  L.push('');
  if (a.notInSpec.length) L.push(`**Not in the spec** (called by tests or Postman, undocumented): ${a.notInSpec.map((k) => `\`${k}\``).join(', ')}`, '');

  // Dependencies
  L.push('## 4. Dependency map', '');
  if (!a.edges.length) L.push('No dependencies found.', '');
  else {
    L.push(...mermaid(r));
    L.push('| From | To | Value | Source | Evidence |', '|---|---|---|---|---|');
    const label = { 'openapi-links': 'OpenAPI links (confirmed)', 'existing-tests': 'existing tests (confirmed in practice)', postman: 'Postman (confirmed in practice)', candidate: '**candidate: confirm**' };
    for (const e of a.edges) L.push(`| \`${e.from}\` | \`${e.to}\`${e.cleanup ? ' (cleanup)' : ''} | ${e.variable ?? ''} | ${label[e.source]} | ${esc(e.evidence.slice(0, 3).join('; '))}${e.evidence.length > 3 ? ` (+${e.evidence.length - 3})` : ''} |`);
    L.push('');
  }

  // Preconditions
  const withPre = a.tests.filter((t) => t.preconditions.some((c) => !c.cleanup) || t.calls.some((c) => c.via && !c.cleanup));
  if (withPre.length) {
    L.push('## 5. Preconditions in existing tests', '', '| Test | Preconditions (hooks, fixtures, helpers) | Asserted operation |', '|---|---|---|');
    for (const t of withPre) {
      const pre = [...t.preconditions, ...t.calls.filter((c) => c.via && !t.asserted.some((x) => x.call === c))].filter((c) => !c.cleanup);
      L.push(`| \`${t.file}:${t.line}\` ${esc(t.title)} | ${[...new Set(pre.map((c) => `${c.method} ${c.path}${c.via ? ` (${c.via})` : ''}`))].join('<br>') || '-'} | ${t.asserted.map((x) => `${x.call.method} ${x.call.path} → ${x.statuses.join('/') || '?'}`).join('<br>') || '-'} |`);
    }
    L.push('');
  }

  // Issues
  L.push('## 6. Issues in existing tests', '');
  if (!a.testIssues.length && !a.postmanIssues.length) L.push('None found.', '');
  else {
    const titles: Record<string, string> = {
      'hardcoded-secret': 'Hard-coded secrets',
      'hardcoded-url': 'Hard-coded URLs',
      'wait-for-timeout': 'Fixed waits',
      'no-cleanup': 'Created data is never cleaned up',
      'status-only': 'Only the status code is checked',
      'order-dependent': 'Tests depend on each other',
      'no-assertion': 'No assertions',
      'parse-error': 'Could not parse',
    };
    for (const code of Object.keys(titles)) {
      const list = a.testIssues.filter((i) => i.code === code);
      if (!list.length) continue;
      L.push(`**${titles[code]}** (${list.length})`, '');
      for (const i of list.slice(0, 15)) L.push(`- \`${i.file}${i.line ? `:${i.line}` : ''}\`: ${i.message}`);
      if (list.length > 15) L.push(`- …and ${list.length - 15} more in report.json`);
      L.push('');
    }
    if (a.postmanIssues.length) L.push('**Postman**', '', ...a.postmanIssues.slice(0, 20).map((i) => `- ${i}`), '');
  }

  // Contract
  const bad = r.contract.filter((f) => f.status === 'CONTRACT_MISMATCH');
  if (bad.length) {
    L.push('## 7. Live API vs spec', '', 'The spec is the requirement: each item needs a decision (fix the API or fix the spec).', '');
    for (const f of bad) L.push(`- \`${f.operation}\` (${f.source}): ${esc(f.reason)}${f.details && typeof f.details === 'object' ? ` · ${esc(JSON.stringify((f.details as any).errors ?? f.details))}` : ''}`);
    L.push('');
  }

  // Proposals
  L.push('## 8. Proposals', '');
  const moves = a.proposals.filter((p) => p.kind === 'move-test');
  const conv = a.proposals.filter((p) => p.kind === 'convert-postman');
  const gen = a.proposals.filter((p) => p.kind === 'generate');
  if (!a.proposals.length) L.push('Nothing to propose: layout and coverage match.', '');
  if (moves.length) {
    L.push(`### A. Move existing tests into the layout (${moves.length})`, '', '`<resource>/<method>[-by-id]/positive|negative`. Moved tests keep their code; `.manual` keeps them apart from generated files.', '');
    L.push('| Test | Proposed location |', '|---|---|', ...moves.map((p) => `| \`${p.from}\` ${esc(p.detail)} | \`${p.to}\` |`), '');
  }
  if (conv.length) L.push(`### B. Convert Postman requests not covered by tests (${conv.length})`, '', '| Request | Proposed file | Assertions |', '|---|---|---|', ...conv.map((p) => `| ${esc(p.from!)} | \`${p.to}\` | ${p.detail} |`), '');
  const ready = gen.filter((p) => !p.detail.includes('BLOCKED'));
  const blocked = gen.filter((p) => p.detail.includes('BLOCKED'));
  if (ready.length) {
    L.push(`### C. Generate missing tests (${ready.length})`, '', ...ready.map((p) => `- \`${p.to}\`: ${p.detail}`), '', 'Run: `npx api-test-agent generate --allow-write --run` (writes only to the API tests folder; existing files are not touched).', '');
  }
  if (blocked.length) {
    L.push(`### D. Cannot be generated yet (${blocked.length})`, '', 'Each needs one fix in the spec or a confirmed dependency first:', '', ...blocked.map((p) => `- \`${p.to}\`: ${p.detail.replace(/^(positive|negative) cases: BLOCKED, /, '$1: ')}`), '');
  }
  if (moves.length || conv.length) L.push('A and B are applied by `npx api-test-agent adapt` (next release), or file by file with Claude Code and the `api-test-writer` skill.', '');

  // Spec quality
  if (r.spec) {
    const errors = r.spec.lint.filter((p) => p.severity === 'error');
    L.push(`## 9. Spec quality: ${errors.length} errors, ${r.spec.lint.length - errors.length} warnings`, '');
    for (const p of r.spec.lint.slice(0, 20)) L.push(`- ${p.severity === 'error' ? '❌' : '⚠️'} \`${p.ruleId}\` ${esc(p.message)}${p.pointer ? ` (\`${p.pointer}\`)` : ''}`);
    L.push('');
  }
  return L.join('\n') + '\n';
}
