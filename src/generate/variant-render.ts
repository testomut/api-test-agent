import { apiCall } from './api-objects.js';
import type { BodyVariant } from './variants.js';
import { expectSuccess, hasFill, optionsWith, pathArgs, roleOf, testOptions, type SuiteInput } from './templates.js';
import { assertSuccess, pathExpr, pyLit, pyName, pyRequired, resourceModule, withId } from './python.js';

/**
 * Positive request-body variants (src/generate/variants.ts) in functional.spec.ts / test_functional.py of the
 * create or update operation of a confirmed chain. The status must be the documented success and the response must
 * match the contract; whatever the test creates is removed in finally. Same tests and case IDs in both languages.
 */

const js = (v: unknown) => JSON.stringify(v);

/** The fresh payload of the role with the variant applied (TypeScript expression). */
function tsPayload(s: SuiteInput, v: BodyVariant): string {
  const role = roleOf(s.op, s.plan);
  const fresh = role === 'create' ? (hasFill(s.plan) ? 'await resource.newCreatePayload(api)' : 'resource.newCreatePayload()') : 'resource.newUpdatePayload()';
  return v.remove ? `withoutFields(${fresh}, ${js(v.remove)})` : `withValue(${fresh}, ${js(v.set!.pointer)}, ${js(v.set!.value)})`;
}

export const tsVariantImports = (s: SuiteInput) => (s.bodyVariants?.length ? ['expectContract', ...(s.bodyVariants.some((v) => v.remove) ? ['withoutFields'] : []), ...(s.bodyVariants.some((v) => v.set) ? ['withValue'] : [])] : []);

export function tsVariantTests(s: SuiteInput): string[] {
  const { op, refs, plan } = s;
  const chain = plan!.chain;
  const ref = refs.get(op)!;
  const role = roleOf(op, plan);
  const call = (idVar?: string) => apiCall(ref, 'api', pathArgs(op, ref, chain.param, idVar), optionsWith(op, '{ data: payload }'));
  const check = (i: string) => [`${i}${expectSuccess(op)}`, `${i}await expectContract(res, '${op.method}', ${js(op.path)});`];
  return (s.bodyVariants ?? []).flatMap((v, n) => {
    const opts = testOptions('positive', s.ids?.functional.bodyVariants?.[n]);
    if (role === 'create') {
      return [
        `  test(${js(v.title)}, ${opts}, async ({ api }) => {`,
        `    const payload = ${tsPayload(s, v)};`,
        `    const res = await ${call()};`,
        `    try {`,
        ...check('      '),
        `    } finally {`,
        `      await resource.removeIfCreated(api, res);`,
        `    }`,
        `  });`,
        '',
      ];
    }
    return [
      `  test(${js(v.title)}, ${opts}, async ({ api }) => {`,
      `    const { id } = await resource.create(api);`,
      `    try {`,
      `      const payload = ${tsPayload(s, v)};`,
      `      const res = await ${call('id')};`,
      ...check('      '),
      `    } finally {`,
      `      await resource.remove(api, id);`,
      `    }`,
      `  });`,
      '',
    ];
  });
}

export function pyVariantTests(s: SuiteInput): string[] {
  const { op, plan } = s;
  if (!s.bodyVariants?.length) return [];
  const chain = plan!.chain;
  const role = roleOf(op, plan);
  const fx = resourceModule(plan!).replace(/_resource$/, '');
  const names = new Set<string>();
  const L = ['from contract import with_value, without_fields  # noqa: E402,F401', '', ''];
  s.bodyVariants.forEach((v, n) => {
    let name = v.kind === 'optional-omitted' ? 'test_accepts_only_required_fields' : pyName(`test_accepts_${v.location.replace(/^request\.body#/, '').replace(/@/g, 'branch_')}`).replace(/_+/g, '_');
    while (names.has(name)) name += '_2';
    names.add(name);
    const fresh = role === 'create' ? `${fx}.new_create_payload()` : `${fx}.new_update_payload()`;
    const payload = v.remove ? `without_fields(${fresh}, ${pyLit(v.remove)})` : `with_value(${fresh}, ${pyLit(v.set!.pointer)}, ${pyLit(v.set!.value, 4)})`;
    const check = [`        ${assertSuccess(op)}`, `        contract.expect(res, ${js(op.method)}, ${js(op.path)})`];
    L.push(withId('@pytest.mark.positive', s.ids?.functional.bodyVariants?.[n]));
    if (role === 'create') {
      L.push(
        `def ${name}(api, contract, ${fx}):`,
        `    """${v.title.replace(/"/g, "'")}"""`,
        `    payload = ${payload}`,
        `    res = api.${op.method}(${pathExpr(op)}, json=payload${pyRequired(op)})`,
        '    try:',
        ...check,
        '    finally:',
        `        ${fx}.remove_if_created(res)`,
        '',
        '',
      );
    } else {
      // created_<resource> removes the precondition record after the test (fixture teardown).
      L.push(
        `def ${name}(api, contract, ${fx}, created_${fx}):`,
        `    """${v.title.replace(/"/g, "'")}"""`,
        `    payload = ${payload}`,
        `    res = api.${op.method}(${pathExpr(op, chain.param, `created_${fx}`)}, json=payload${pyRequired(op)})`,
        ...check.map((l) => l.slice(4)),
        '',
        '',
      );
    }
  });
  return L;
}
