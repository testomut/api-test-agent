import { SAFE_METHODS, type Finding, type Operation } from '../types.js';
import type { OpenApiDoc } from '../spec/loader.js';
import { ContractValidator } from '../contract/validator.js';
import { resolveAuth, redact } from './auth.js';
import { BudgetExceeded, SafeClient } from './http.js';

/**
 * Non-destructive probe: one request per safe operation, using only values the
 * spec itself provides. The observed response is compared to the spec, never the
 * other way round: a mismatch is reported, the spec is not "corrected".
 */
export async function probe(doc: OpenApiDoc, ops: Operation[], client: SafeClient, log: (m: string) => void): Promise<Finding[]> {
  const validator = new ContractValidator(doc);
  const findings: Finding[] = [];
  const add = (op: Operation, status: Finding['status'], reason: string, details?: unknown) =>
    findings.push({ operation: op.key, source: 'probe', status, reason, details });

  for (const op of ops) {
    if (!SAFE_METHODS.includes(op.method)) {
      add(op, 'NOT_RUN', 'Probe sends only GET/HEAD/OPTIONS; writes are covered by Schemathesis (with --allow-write) or generated scenarios.');
      continue;
    }
    const missing = op.params.filter((p) => p.required && p.in !== 'header' && p.knownValue === undefined);
    if (missing.length) {
      add(op, 'BLOCKED', `No value for required ${missing.map((p) => `${p.in} "${p.name}"`).join(', ')}. Provide an example in the spec or a dependency (see generate).`);
      continue;
    }
    const auth = resolveAuth(doc, op.security);
    if (!auth.ok) {
      add(op, 'BLOCKED', auth.reason);
      continue;
    }

    let path = op.path;
    const query = new URLSearchParams(auth.creds.query);
    const headers: Record<string, string> = { ...auth.creds.headers };
    for (const p of op.params) {
      if (p.knownValue === undefined || (!p.required && p.in !== 'path')) continue;
      const v = String(p.knownValue);
      if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(v));
      else if (p.in === 'query') query.set(p.name, v);
      else if (p.in === 'header') headers[p.name] = v;
    }
    const target = path + (query.size ? `?${query}` : '');

    try {
      const res = await client.request(op.method, target, { headers });
      log(`  ${op.key} -> ${res.status} (${res.elapsedMs} ms)`);
      const check = validator.validateResponse({ method: op.method, path: op.path, status: res.status, contentType: res.contentType, body: res.body });

      if (!check.ok) {
        add(op, 'CONTRACT_MISMATCH', `${check.kind}: response differs from the documented contract`, { httpStatus: res.status, errors: check.errors });
      } else if (res.status === 401 || res.status === 403) {
        add(op, 'BLOCKED', `Got documented ${res.status}: credentials lack access to this operation.`);
      } else if (res.status >= 500) {
        add(op, 'CONTRACT_MISMATCH', `Server error ${res.status} (documented, but a probe with spec-provided values should not fail).`);
      } else if (res.status >= 400) {
        add(op, 'BLOCKED', `Got documented ${res.status} with spec-provided values: real test data is needed for a positive check.`);
      } else {
        add(op, 'PASS', check.bodyChecked ? `${res.status} matches documented status, content type and schema.` : `${res.status} matches documented status; no body schema to validate.`);
      }
    } catch (err: any) {
      if (err instanceof BudgetExceeded) add(op, 'NOT_RUN', err.message);
      else add(op, 'TEST_FAILURE', `Request failed: ${redact(String(err?.cause?.code ?? err?.message ?? err))}`);
    }
  }
  return findings;
}
