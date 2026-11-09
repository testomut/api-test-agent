/**
 * CI quality gates of a generated suite (scripts/coverage-summary.ts): cleanup of write tests, the active case IDs
 * and the gaps against a reviewed baseline, TypeScript / Python parity.
 */

export interface CleanupProblem {
  test: string;
  problem: string;
}

/**
 * Tests that create data must remove it whatever happens: in `finally`, through a fixture teardown (pytest
 * created_<resource>), or with removeIfCreated / remove_if_created right after the write request and before any
 * assertion (they never throw, so nothing can skip them).
 */
export function cleanupProblems(text: string, lang: 'typescript' | 'python'): CleanupProblem[] {
  const out: CleanupProblem[] = [];
  const blocks = lang === 'typescript' ? text.split(/\n  test\(/).slice(1) : text.split(/\n(?=@pytest\.mark\.(?:positive|negative))/).slice(1);
  for (const b of blocks) {
    const title = b.split('\n')[lang === 'typescript' ? 0 : 1 + (b.includes('api_case_id') ? 1 : 0)]?.slice(0, 100) ?? '';
    const creates = lang === 'typescript' ? /resource\.create\(|\.create\(api, |removeIfCreated/.test(b) : /\w+\.create\(|remove_if_created|\.new_create_payload\(\)/.test(b);
    if (!creates) continue;
    const cleaned =
      lang === 'typescript'
        ? /finally\s*\{[\s\S]*(resource\.remove|removeIfCreated|reportCleanupFailure)/.test(b) || /=\s*await [^\n]+;\n\s*await resource\.removeIfCreated\(api, res\);/.test(b)
        : /finally:[\s\S]*(\.remove\(|report_cleanup_failure|remove_if_created)/.test(b) || /def \w+\([^)]*created_\w+[^)]*\)/.test(b) || /res = api\.\w+\((?:(?!assert|contract\.)[\s\S])*?\)\n\s+\w+\.remove_if_created\(res\)/.test(b);
    if (!cleaned) out.push({ test: title.trim(), problem: 'creates data without guaranteed cleanup' });
  }
  return out;
}

export interface BaselineDiff {
  lostCases: string[];
  newCases: string[];
  newGaps: string[];
  closedGaps: string[];
}

/** Lost active cases and new gaps fail the gate until the reviewed baseline is updated with the PR. */
export function compareBaseline(base: { activeCaseIds: string[]; gaps: string[] }, now: { activeCaseIds: string[]; gaps: string[] }): BaselineDiff {
  const was = new Set(base.activeCaseIds);
  const is = new Set(now.activeCaseIds);
  const gapsWas = new Set(base.gaps);
  const gapsIs = new Set(now.gaps);
  return {
    lostCases: base.activeCaseIds.filter((id) => !is.has(id)),
    newCases: now.activeCaseIds.filter((id) => !was.has(id)),
    newGaps: now.gaps.filter((g) => !gapsWas.has(g)),
    closedGaps: base.gaps.filter((g) => !gapsIs.has(g)),
  };
}
