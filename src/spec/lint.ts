import { lint, loadConfig } from '@redocly/openapi-core';
import type { LintProblem } from '../types.js';

/** Redocly "recommended" ruleset unless the repo has its own redocly.yaml. Deterministic, no AI. */
export async function lintSpec(location: string): Promise<LintProblem[]> {
  const config = await loadConfig();
  const problems = await lint({ ref: location, config });
  return problems
    .filter((p) => p.severity === 'error' || p.severity === 'warn')
    .map((p) => ({
      ruleId: p.ruleId,
      severity: p.severity as 'error' | 'warn',
      message: p.message,
      pointer: p.location?.[0]?.pointer,
    }));
}
