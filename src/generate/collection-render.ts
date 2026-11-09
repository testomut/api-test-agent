import type { Operation } from '../types.js';
import { apiCall } from './api-objects.js';
import { requiredRequest } from './param-cases.js';
import type { CollectionPlan, CollectionTest } from './collection-tests.js';
import { expectSuccess, hasFill, optionsWith, pathArgs, testOptions, type ChainPlan, type SuiteInput } from './templates.js';
import type { LoadedFixture } from '../fixtures/fixtures.js';
import { assertSuccess, pathExpr, pyLit, pyName, pyRequired, resourceModule, withId } from './python.js';

/**
 * Renders the collection tests of a list operation (src/generate/collection-tests.ts) for Playwright and pytest.
 * Same plan, same checks, same order in both languages; one physical test per case ID.
 */

export interface CollectionInput {
  plan: CollectionPlan;
  /** The confirmed chain whose create / update / delete the controlled datasets use. */
  chain: ChainPlan;
}

const js = (v: unknown) => JSON.stringify(v);
const py = (v: unknown) => pyLit(v);
const leaf = (ptr: string) => ptr.slice(1).replace(/~1/g, '/').replace(/~0/g, '~');

/** Query parameters of page `i` (an expression) of size `size` (an expression), as object-literal entries. */
function pageEntries(plan: CollectionPlan, i: string, size: string, q: (s: string) => string): string | undefined {
  const p = plan.c.page;
  if (p?.style === 'offset') return `${q(p.offsetParam)}: ${i} * ${size}, ${q(p.limitParam)}: ${size}`;
  if (p?.style === 'page') return `${q(p.pageParam)}: ${i} + ${p.firstPage ?? 1}, ${q(p.sizeParam)}: ${size}`;
  return undefined;
}

const sortValue = (v: string | number, lang: 'ts' | 'py') => (typeof v === 'string' ? (lang === 'ts' ? `${js(v)} + marker` : `${py(v)} + marker`) : String(v));
const filterValue = (t: CollectionTest, which: 'a' | 'b', lang: 'ts' | 'py') => {
  const fv = t.filterValues!;
  if (fv.kind === 'enum') return lang === 'ts' ? js(fv[which]) : py(fv[which]);
  return `marker + ${lang === 'ts' ? js('-' + which) : py('-' + which)}`;
};

/* ------------------------------------------------------------------ TypeScript */

export const tsCollectionImports = (suite: 'functional' | 'scenario') => [
  'itemsOf', 'expectContains', 'expectFields', 'poll', 'readPointer', 'withValue',
  ...(suite === 'functional' ? ['expectNotContains', 'expectAllMatch', 'expectUniqueBy', 'expectSortedBy', 'expectPageSize', 'expectNoDuplicateAcrossPages'] : ['expectNotContains']),
];

/** Module-level helpers of a list operation's suite: list one page, walk the pages, poll, isolate. */
export function tsCollectionPrelude(s: SuiteInput, ci: CollectionInput): string[] {
  const { plan, chain } = ci;
  const op = s.op;
  const ref = s.refs.get(op)!;
  const req = requiredRequest(op).params;
  const c = plan.c;
  const page = pageEntries(plan, 'i', 'size', js);
  const L = [
    `import type { Apis } from '../../_support/api/generated/apis.js';`,
    '',
    `/* Collection checks: the reviewed "collection" mapping of ${op.operationId ?? op.key} in the deps file. */`,
    `const ITEMS = ${js(c.items)};`,
    `const ID = ${js(c.id)};`,
    `/** Fields the API keeps as sent, with their comparison policy (exact, tolerance:<n>, schema, ignore). */`,
    `const FIELDS: Record<string, string> = ${js(c.fields ?? {})};`,
    `/** Bounded polling (documented eventual consistency); 0 = one read. */`,
    `const POLL = ${js({ timeoutMs: c.consistency?.pollTimeoutMs ?? 0, intervalMs: c.consistency?.pollIntervalMs ?? 100 })};`,
    `const MAX_PAGES = ${c.maxPages};`,
    `const WALK = ${plan.walkSize};`,
    '',
    `/** A value no other data has: the records a test creates carry it, so the test reads only its own records. */`,
    `const newMarker = () => 'ata-' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');`,
    `const fresh = async (${hasFill(chain) ? 'api: Apis' : '_api: Apis'}) => (await resource.newCreatePayload(${hasFill(chain) ? 'api' : ''})) as Record<string, unknown>;`,
  ];
  if (plan.iso) {
    const f = plan.iso;
    L.push(
      `/** ${f.param} ${f.match} ${f.field}: the isolating filter. */`,
      `const isolate = <T>(payload: T, marker: string): T => withValue(payload, ${js(f.field)}, ${f.match === 'contains' ? '[marker]' : 'marker'});`,
      `const ISO = (marker: string): Record<string, unknown> => ({ ${js(f.param)}: marker });`,
    );
  }
  L.push(
    '',
    `async function listPage(api: Apis, params: Record<string, unknown>): Promise<unknown[]> {`,
    `  const res = await ${apiCall(ref, 'api', pathArgs(op, ref), `{ params: { ...${js(req)}, ...params } as Record<string, string | number | boolean> }`)};`,
    `  ${expectSuccess(op)}`,
    `  return itemsOf(await res.json(), ITEMS);`,
    `}`,
    '',
    `/** Every page (at most MAX_PAGES) with these parameters${page ? '' : ': the API has no reviewed paging, so the one response'}. */`,
    `async function listPages(api: Apis, params: Record<string, unknown>, size = WALK): Promise<unknown[][]> {`,
    ...(page
      ? [
          `  const pages: unknown[][] = [];`,
          `  for (let i = 0; i < MAX_PAGES; i++) {`,
          `    const page = await listPage(api, { ...params, ${page} });`,
          `    pages.push(page);`,
          `    if (page.length < size) break;`,
          `  }`,
          `  return pages;`,
        ]
      : [`  void size;`, `  return [await listPage(api, params)];`]),
    `}`,
    '',
    `const listAll = async (api: Apis, params: Record<string, unknown>) => (await listPages(api, params)).flat();`,
    `const has = (...ids: string[]) => (items: unknown[]) => ids.every((id) => items.some((i) => String(readPointer(i, ID)) === id));`,
    `const listUntil = (api: Apis, params: Record<string, unknown>, done: (items: unknown[]) => boolean) => poll(() => listAll(api, params), done, POLL.timeoutMs, POLL.intervalMs);`,
    '',
  );
  return L;
}

/** Records of a controlled test: created in order, all removed in finally (also when a create in between fails). */
function tsSeeded(title: string, opts: string, payloads: string[], body: string[]): string[] {
  return [
    `  test(${js(title)}, ${opts}, async ({ api }) => {`,
    `    const marker = newMarker();`,
    `    const payloads = [`,
    ...payloads.map((p) => `      ${p},`),
    `    ];`,
    `    const ids: string[] = [];`,
    `    try {`,
    `      for (const p of payloads) ids.push((await resource.create(api, p)).id);`,
    ...body.map((l) => `      ${l}`),
    `    } finally {`,
    `      for (const id of ids) await resource.remove(api, id);`,
    `    }`,
    `  });`,
    '',
  ];
}

export function tsCollectionTests(s: SuiteInput, ci: CollectionInput): string[] {
  const { plan } = ci;
  const L: string[] = [];
  const iso = (p: string) => (plan.iso ? `isolate(${p}, marker)` : p);
  const isoParams = plan.iso ? 'ISO(marker)' : '{}';
  plan.tests.forEach((t, n) => {
    const opts = testOptions('positive', s.ids?.functional.collection?.[n]);
    if (t.kind === 'listed') {
      L.push(...tsSeeded(t.title, opts, [iso('await fresh(api)')], [
        `const items = await listUntil(api, ${isoParams}, has(ids[0]));`,
        `expectFields(expectContains(items, ID, ids[0], 'created resource'), payloads[0], FIELDS);`,
      ]));
    } else if (t.kind === 'filter' && t.mode === 'controlled') {
      const f = t.filter!;
      const set = (which: 'a' | 'b') => {
        const v = filterValue(t, which, 'ts');
        const p = `withValue(await fresh(api), ${js(f.field)}, ${f.match === 'contains' ? `[${v}]` : v})`;
        return t.filterValues!.kind === 'enum' ? iso(p) : p;
      };
      const params = t.filterValues!.kind === 'enum' ? `{ ...ISO(marker), ${js(f.param)}: ${filterValue(t, 'a', 'ts')} }` : `{ ${js(f.param)}: ${filterValue(t, 'a', 'ts')} }`;
      L.push(...tsSeeded(t.title, opts, [set('a'), set('b')], [
        `const items = await listUntil(api, ${params}, has(ids[0]));`,
        `expectContains(items, ID, ids[0], 'resource matching ${f.param}');`,
        `expectNotContains(items, ID, ids[1], 'resource not matching ${f.param}');`,
        `expectAllMatch(items, ${js(f.field)}, ${js(f.match)}, ${filterValue(t, 'a', 'ts')});`,
      ]));
    } else if (t.kind === 'filter') {
      const f = t.filter!;
      L.push(
        `  test(${js(t.title)}, ${opts}, async ({ api }) => {`,
        `    const all = await listAll(api, {});`,
        `    const value = all.flatMap((i) => { const v = readPointer(i, ${js(f.field)}); return ${f.match === 'contains' ? 'Array.isArray(v) ? v : []' : 'v === undefined || v === null ? [] : [v]'}; })[0];`,
        `    test.skip(value === undefined, ${js(`no existing resource has a value in ${f.field} to filter by (read-only check)`)});`,
        `    const items = await listAll(api, { ${js(f.param)}: value });`,
        `    expect(items.length, 'the filter finds the resource the value came from').toBeGreaterThan(0);`,
        `    expectAllMatch(items, ${js(f.field)}, ${js(f.match)}, value);`,
        `  });`,
        '',
      );
    } else if (t.kind === 'sort' && t.mode === 'controlled') {
      const so = t.sort!;
      L.push(...tsSeeded(t.title, opts, t.sortValues!.map((v) => `withValue(isolate(await fresh(api), marker), ${js(so.field)}, ${sortValue(v, 'ts')})`), [
        `const items = await listUntil(api, { ...ISO(marker), ${js(so.param)}: ${js(so.value)} }, has(...ids));`,
        `for (const id of ids) expectContains(items, ID, id);`,
        `expectSortedBy(items, ${js(so.field)}, ${js(so.order)});`,
      ]));
    } else if (t.kind === 'sort') {
      const so = t.sort!;
      L.push(
        `  test(${js(t.title)}, ${opts}, async ({ api }) => {`,
        `    const items = await listAll(api, { ${js(so.param)}: ${js(so.value)} });`,
        `    test.skip(items.length < 2, 'fewer than 2 resources: the order cannot be checked (read-only check)');`,
        `    expectSortedBy(items, ${js(so.field)}, ${js(so.order)});`,
        `  });`,
        '',
      );
    } else if (t.kind === 'pagination' && t.mode === 'controlled') {
      const ps = plan.pageSize;
      L.push(...tsSeeded(t.title, opts, Array.from({ length: ps + 1 }, () => iso('await fresh(api)')), [
        `const pages = await poll(() => listPages(api, ISO(marker), ${ps}), (p) => has(...ids)(p.flat()), POLL.timeoutMs, POLL.intervalMs);`,
        `for (const page of pages) expectPageSize(page, ${ps});`,
        `expect(pages[0].length, 'the first page is full').toBe(${ps});`,
        `expectNoDuplicateAcrossPages(pages, ID);`,
        `for (const id of ids) expectContains(pages.flat(), ID, id);`,
      ]));
    } else if (t.kind === 'pagination') {
      const ps = plan.pageSize;
      L.push(
        `  test(${js(t.title)}, ${opts}, async ({ api }) => {`,
        `    const pages = await listPages(api, {}, ${ps});`,
        `    test.skip(pages.flat().length <= ${ps}, 'not more than one page of resources (read-only check)');`,
        `    for (const page of pages) expectPageSize(page, ${ps});`,
        `    expect(pages[0].length, 'the first page is full').toBe(${ps});`,
        `    expectNoDuplicateAcrossPages(pages, ID);`,
        `  });`,
        '',
      );
    } else if (t.kind === 'unique' && t.mode === 'controlled') {
      L.push(...tsSeeded(t.title, opts, [iso('await fresh(api)'), iso('await fresh(api)')], [
        `const items = await listUntil(api, ISO(marker), has(...ids));`,
        `expectUniqueBy(items, ${js(t.unique)});`,
      ]));
    } else {
      L.push(`  test(${js(t.title)}, ${opts}, async ({ api }) => {`, `    expectUniqueBy(await listAll(api, {}), ${js(t.unique)});`, `  });`, '');
    }
  });
  return L;
}

/** create → listed with its fields → update → listed with the new values → delete → no longer listed. */
export function tsLifecycle(s: SuiteInput, ci: CollectionInput): string[] {
  const { plan, chain } = ci;
  const ch = chain.chain;
  const upd = ch.update!;
  const del = ch.delete!;
  const call = (o: Operation, options?: string) => {
    const ref = s.refs.get(o)!;
    return apiCall(ref, 'api', pathArgs(o, ref, ch.param, 'id'), optionsWith(o, options));
  };
  const iso = plan.iso ? 'isolate(await fresh(api), marker)' : 'await fresh(api)';
  const first = plan.iso ? 'ISO(marker)' : '{}';
  const after = plan.lifecycleIso ? first : '{}';
  return [
    `  test('create → list → update → list → delete → list', ${testOptions('positive', s.ids?.scenario.lifecycle)}, async ({ api }) => {`,
    `    const marker = newMarker();`,
    `    const payload = ${iso};`,
    `    const { id } = await resource.create(api, payload);`,
    `    let deleted = false;`,
    `    try {`,
    `      let items = await listUntil(api, ${first}, has(id));`,
    `      expectFields(expectContains(items, ID, id, 'created resource'), payload, FIELDS);`,
    `      const update = resource.newUpdatePayload();`,
    `      const res = await ${call(upd, '{ data: update }')};`,
    `      ${expectSuccess(upd)}`,
    `      const current = (xs: unknown[]) => {`,
    `        try {`,
    `          expectFields(xs.find((i) => String(readPointer(i, ID)) === id), update, FIELDS);`,
    `          return true;`,
    `        } catch {`,
    `          return false;`,
    `        }`,
    `      };`,
    `      items = await listUntil(api, ${after}, current);`,
    `      expectFields(expectContains(items, ID, id, 'updated resource'), update, FIELDS);`,
    `      const removed = await ${call(del)};`,
    `      ${expectSuccess(del, 'removed')}`,
    `      deleted = true;`,
    ...(plan.c.deletedDisappears
      ? [`      items = await listUntil(api, ${after}, (xs) => !has(id)(xs));`, `      expectNotContains(items, ID, id, 'deleted resource');`]
      : [`      // Not asserted: the deps file does not confirm that a deleted resource leaves the list ("deletedDisappears").`]),
    `    } finally {`,
    `      if (!deleted) await resource.remove(api, id);`,
    `    }`,
    `  });`,
    '',
  ];
}

/* ------------------------------------------------------------------ Python */

const PY_IMPORTS = 'from contract import expect_all_match, expect_contains, expect_fields, expect_no_duplicate_across_pages, expect_not_contains, expect_page_size, expect_sorted_by, expect_unique_by, items_of, poll, with_value  # noqa: F401';

export function pyCollectionPrelude(s: SuiteInput, ci: CollectionInput): string[] {
  const { plan } = ci;
  const op = s.op;
  const c = plan.c;
  const req = requiredRequest(op).params;
  const page = pageEntries(plan, 'i', 'size', (k) => py(k));
  const L = [
    PY_IMPORTS,
    '',
    `# Collection checks: the reviewed "collection" mapping of ${op.operationId ?? op.key} in the deps file.`,
    `ITEMS = ${py(c.items)}`,
    `ID = ${py(c.id)}`,
    `# Fields the API keeps as sent, with their comparison policy (exact, tolerance:<n>, schema, ignore).`,
    `FIELDS = ${py(c.fields ?? {})}`,
    `# Bounded polling (documented eventual consistency); 0 = one read.`,
    `POLL_TIMEOUT_MS = ${c.consistency?.pollTimeoutMs ?? 0}`,
    `POLL_INTERVAL_MS = ${c.consistency?.pollIntervalMs ?? 100}`,
    `MAX_PAGES = ${c.maxPages}`,
    `WALK = ${plan.walkSize}`,
    '',
    '',
    'def _marker():',
    '    """A value no other data has: the records a test creates carry it, so the test reads only its own records."""',
    '    return "ata-" + uuid.uuid4().hex[:8]',
    '',
    '',
  ];
  if (plan.iso) {
    const f = plan.iso;
    L.push(
      'def _isolate(payload, marker):',
      `    """${f.param} ${f.match} ${f.field}: the isolating filter."""`,
      `    return with_value(payload, ${py(f.field)}, ${f.match === 'contains' ? '[marker]' : 'marker'})`,
      '',
      '',
      'def _iso(marker):',
      `    return {${py(f.param)}: marker}`,
      '',
      '',
    );
  }
  L.push(
    'def _list_page(api, params):',
    `    res = api.${op.method}(${pathExpr(op)}, params={**${py(req)}, **params}${pyRequired(op, ['params'])})`,
    `    ${assertSuccess(op)}`,
    '    return items_of(res.json(), ITEMS)',
    '',
    '',
    'def _list_pages(api, params, size=WALK):',
    ...(page
      ? [
          '    pages = []',
          '    for i in range(MAX_PAGES):',
          `        page = _list_page(api, {**params, ${page}})`,
          '        pages.append(page)',
          '        if len(page) < size:',
          '            break',
          '    return pages',
        ]
      : ['    return [_list_page(api, params)]  # no reviewed paging: the one response']),
    '',
    '',
    'def _list_all(api, params):',
    '    return [item for page in _list_pages(api, params) for item in page]',
    '',
    '',
    'def _has(*ids):',
    '    return lambda items: all(any(str(read_pointer(i, ID)) == str(r) for i in items) for r in ids)',
    '',
    '',
    'def _list_until(api, params, done):',
    '    return poll(lambda: _list_all(api, params), done, POLL_TIMEOUT_MS, POLL_INTERVAL_MS)',
    '',
    '',
  );
  return L;
}

function pySeeded(name: string, mark: string, fx: string, payloads: string[], body: string[]): string[] {
  return [
    mark,
    `def ${name}(api, ${fx}):`,
    '    marker = _marker()  # noqa: F841',
    '    payloads = [',
    ...payloads.map((p) => `        ${p},`),
    '    ]',
    '    ids = []',
    '    try:',
    '        for p in payloads:',
    `            ids.append(${fx}.create(p)[0])`,
    ...body.map((l) => `        ${l}`),
    '    finally:',
    '        for rid in ids:',
    `            ${fx}.remove(rid)`,
    '',
    '',
  ];
}

export function pyCollectionTests(s: SuiteInput, ci: CollectionInput): string[] {
  const { plan, chain } = ci;
  const fx = resourceModule(chain).replace(/_resource$/, '');
  const L: string[] = [];
  const iso = (p: string) => (plan.iso ? `_isolate(${p}, marker)` : p);
  const isoParams = plan.iso ? '_iso(marker)' : '{}';
  const fresh = `${fx}.new_create_payload()`;
  const names = new Set<string>();
  const nameOf = (base: string) => {
    let n = pyName(base).replace(/_+/g, '_').replace(/_$/, '');
    while (names.has(n)) n += '_2';
    names.add(n);
    return n;
  };
  plan.tests.forEach((t, n) => {
    const mark = withId('@pytest.mark.positive', s.ids?.functional.collection?.[n]);
    if (t.kind === 'listed') {
      L.push(...pySeeded(nameOf('test_created_resource_is_listed_with_its_fields'), mark, fx, [iso(fresh)], [
        `found = _list_until(api, ${isoParams}, _has(ids[0]))`,
        'expect_fields(expect_contains(found, ID, ids[0], "created resource"), payloads[0], FIELDS)',
      ]));
    } else if (t.kind === 'filter' && t.mode === 'controlled') {
      const f = t.filter!;
      const set = (which: 'a' | 'b') => {
        const v = filterValue(t, which, 'py');
        const p = `with_value(${fresh}, ${py(f.field)}, ${f.match === 'contains' ? `[${v}]` : v})`;
        return t.filterValues!.kind === 'enum' ? iso(p) : p;
      };
      const params = t.filterValues!.kind === 'enum' ? `{**_iso(marker), ${py(f.param)}: ${filterValue(t, 'a', 'py')}}` : `{${py(f.param)}: ${filterValue(t, 'a', 'py')}}`;
      L.push(...pySeeded(nameOf(`test_filter_${f.param}_returns_matching_and_leaves_out_other`), mark, fx, [set('a'), set('b')], [
        `found = _list_until(api, ${params}, _has(ids[0]))`,
        `expect_contains(found, ID, ids[0], ${py(`resource matching ${f.param}`)})`,
        `expect_not_contains(found, ID, ids[1], ${py(`resource not matching ${f.param}`)})`,
        `expect_all_match(found, ${py(f.field)}, ${py(f.match)}, ${filterValue(t, 'a', 'py')})`,
      ]));
    } else if (t.kind === 'filter') {
      const f = t.filter!;
      const values = f.match === 'contains' ? 'v if isinstance(v, list) else []' : '[] if v is None else [v]';
      L.push(
        mark,
        `def ${nameOf(`test_filter_${f.param}_returns_only_matching`)}(api):`,
        '    candidates = []',
        '    for item in _list_all(api, {}):',
        `        v = read_pointer(item, ${py(f.field)})`,
        `        candidates.extend(${values})`,
        '    if not candidates:',
        `        pytest.skip(${py(`no existing resource has a value in ${f.field} to filter by (read-only check)`)})`,
        '    value = candidates[0]',
        `    found = _list_all(api, {${py(f.param)}: value})`,
        '    assert found, "the filter finds the resource the value came from"',
        `    expect_all_match(found, ${py(f.field)}, ${py(f.match)}, value)`,
        '',
        '',
      );
    } else if (t.kind === 'sort' && t.mode === 'controlled') {
      const so = t.sort!;
      L.push(...pySeeded(nameOf(`test_sort_${so.param}_${so.value.replace(/^-/, 'desc_')}`), mark, fx, t.sortValues!.map((v) => `with_value(_isolate(${fresh}, marker), ${py(so.field)}, ${sortValue(v, 'py')})`), [
        `found = _list_until(api, {**_iso(marker), ${py(so.param)}: ${py(so.value)}}, _has(*ids))`,
        'for rid in ids:',
        '    expect_contains(found, ID, rid)',
        `expect_sorted_by(found, ${py(so.field)}, ${py(so.order)})`,
      ]));
    } else if (t.kind === 'sort') {
      const so = t.sort!;
      L.push(
        mark,
        `def ${nameOf(`test_sort_${so.param}_${so.value.replace(/^-/, 'desc_')}`)}(api):`,
        `    found = _list_all(api, {${py(so.param)}: ${py(so.value)}})`,
        '    if len(found) < 2:',
        '        pytest.skip("fewer than 2 resources: the order cannot be checked (read-only check)")',
        `    expect_sorted_by(found, ${py(so.field)}, ${py(so.order)})`,
        '',
        '',
      );
    } else if (t.kind === 'pagination' && t.mode === 'controlled') {
      const ps = plan.pageSize;
      L.push(...pySeeded(nameOf('test_pages_have_requested_size_and_never_repeat'), mark, fx, Array.from({ length: ps + 1 }, () => iso(fresh)), [
        `pages = poll(lambda: _list_pages(api, _iso(marker), ${ps}), lambda p: _has(*ids)([x for page in p for x in page]), POLL_TIMEOUT_MS, POLL_INTERVAL_MS)`,
        'for page in pages:',
        `    expect_page_size(page, ${ps})`,
        `assert len(pages[0]) == ${ps}, f"the first page is full: {len(pages[0])} of ${ps}"`,
        'expect_no_duplicate_across_pages(pages, ID)',
        'for rid in ids:',
        '    expect_contains([x for page in pages for x in page], ID, rid)',
      ]));
    } else if (t.kind === 'pagination') {
      const ps = plan.pageSize;
      L.push(
        mark,
        `def ${nameOf('test_pages_have_requested_size_and_never_repeat')}(api):`,
        `    pages = _list_pages(api, {}, ${ps})`,
        `    if sum(len(p) for p in pages) <= ${ps}:`,
        '        pytest.skip("not more than one page of resources (read-only check)")',
        '    for page in pages:',
        `        expect_page_size(page, ${ps})`,
        `    assert len(pages[0]) == ${ps}, f"the first page is full: {len(pages[0])} of ${ps}"`,
        '    expect_no_duplicate_across_pages(pages, ID)',
        '',
        '',
      );
    } else if (t.kind === 'unique' && t.mode === 'controlled') {
      L.push(...pySeeded(nameOf(`test_unique_by_${leaf(t.unique!)}`), mark, fx, [iso(fresh), iso(fresh)], [
        `found = _list_until(api, _iso(marker), _has(*ids))`,
        `expect_unique_by(found, ${py(t.unique)})`,
      ]));
    } else {
      L.push(mark, `def ${nameOf(`test_unique_by_${leaf(t.unique!)}`)}(api):`, `    expect_unique_by(_list_all(api, {}), ${py(t.unique)})`, '', '');
    }
  });
  return L;
}

export function pyLifecycle(s: SuiteInput, ci: CollectionInput): string[] {
  const { plan, chain } = ci;
  const ch = chain.chain;
  const fx = resourceModule(chain).replace(/_resource$/, '');
  const upd = ch.update!;
  const del = ch.delete!;
  const first = plan.iso ? '_iso(marker)' : '{}';
  const after = plan.lifecycleIso ? first : '{}';
  return [
    withId('@pytest.mark.positive', s.ids?.scenario.lifecycle),
    `def test_create_list_update_list_delete_list(api, ${fx}):`,
    '    marker = _marker()  # noqa: F841',
    `    payload = ${plan.iso ? `_isolate(${fx}.new_create_payload(), marker)` : `${fx}.new_create_payload()`}`,
    `    rid, _ = ${fx}.create(payload)`,
    '    deleted = False',
    '    try:',
    `        found = _list_until(api, ${first}, _has(rid))`,
    '        expect_fields(expect_contains(found, ID, rid, "created resource"), payload, FIELDS)',
    `        update = ${fx}.new_update_payload()`,
    `        res = api.${upd.method}(${pathExpr(upd, ch.param, 'rid')}, json=update${pyRequired(upd)})`,
    `        ${assertSuccess(upd)}`,
    '',
    '        def current(xs):',
    '            try:',
    '                expect_fields(next((i for i in xs if str(read_pointer(i, ID)) == str(rid)), None), update, FIELDS)',
    '                return True',
    '            except AssertionError:',
    '                return False',
    '',
    `        found = _list_until(api, ${after}, current)`,
    '        expect_fields(expect_contains(found, ID, rid, "updated resource"), update, FIELDS)',
    `        removed = api.${del.method}(${pathExpr(del, ch.param, 'rid')}${pyRequired(del)})`,
    `        ${assertSuccess(del, 'removed')}`,
    '        deleted = True',
    ...(plan.c.deletedDisappears
      ? [`        found = _list_until(api, ${after}, lambda xs: not _has(rid)(xs))`, '        expect_not_contains(found, ID, rid, "deleted resource")']
      : ['        # Not asserted: the deps file does not confirm that a deleted resource leaves the list ("deletedDisappears").']),
    '    finally:',
    '        if not deleted:',
    `            ${fx}.remove(rid)`,
    '',
    '',
  ];
}

/* ------------------------------------------------------------------ approved fixtures (strategy B) */

export const fixtureModule = (f: LoadedFixture) => `${f.fixture.operationId.replace(/[^\w-]/g, '_')}`;

function fixturePage(f: LoadedFixture, i: string, q: (s: string) => string): { entries?: string; size: number; maxPages: number } {
  const p = f.fixture.page;
  const size = p?.size ?? 50;
  const maxPages = Math.min(p?.maxPages ?? 20, 50);
  if (p?.style === 'offset') return { entries: `${q(p.offsetParam)}: ${i} * ${size}, ${q(p.limitParam)}: ${size}`, size, maxPages };
  if (p?.style === 'page') return { entries: `${q(p.pageParam)}: ${i} + ${p.firstPage ?? 1}, ${q(p.sizeParam)}: ${size}`, size, maxPages };
  return { size, maxPages };
}

const fixturePath = (f: LoadedFixture) => f.file.split('\\').join('/');

/** _support/approved/<operationId>.fixture.ts: the approved fixture, copied so the suite runs on its own. */
export function tsFixtureModule(f: LoadedFixture, version: string): string {
  return `// Approved fixture ${fixturePath(f)}, copied by api-test-agent ${version}. Edit the approved file, not this copy.\nexport const fixture = ${JSON.stringify(f.fixture, null, 2)};\n`;
}

export const tsFixtureImport = (f: LoadedFixture) => `import { fixture as approved } from '../../_support/approved/${fixtureModule(f)}.fixture.js';`;

export function tsFixtureTest(s: SuiteInput, f: LoadedFixture): string[] {
  const op = s.op;
  const ref = s.refs.get(op)!;
  const req = requiredRequest(op).params;
  const pg = fixturePage(f, 'i', js);
  const call = (extra: string) => `await ${apiCall(ref, 'api', pathArgs(op, ref), `{ params: { ...${js(req)}, ...approved.query, ${extra} } as Record<string, string | number | boolean> }`)}`;
  return [
    `  test(${js(`matches the approved fixture ${fixturePath(f)}`)}, ${testOptions('positive', s.ids?.functional.fixture)}, async ({ api }) => {`,
    `    const items: unknown[] = [];`,
    ...(pg.entries
      ? [
          `    for (let i = 0; i < ${pg.maxPages}; i++) {`,
          `      const res = ${call(pg.entries)};`,
          `      ${expectSuccess(op)}`,
          `      const page = itemsOf(await res.json(), approved.items);`,
          `      items.push(...page);`,
          `      if (page.length < ${pg.size}) break;`,
          `    }`,
        ]
      : [`    const res = ${call('')};`, `    ${expectSuccess(op)}`, `    items.push(...itemsOf(await res.json(), approved.items));`]),
    `    expectMatchesFixture(items, approved);`,
    `  });`,
    '',
  ];
}

export function pyFixtureTest(s: SuiteInput, f: LoadedFixture): string[] {
  const op = s.op;
  const req = requiredRequest(op).params;
  const pg = fixturePage(f, 'i', (k) => py(k));
  const call = (extra: string) => `api.${op.method}(${pathExpr(op)}, params={**${py(req)}, **fixture.get("query", {})${extra ? ', ' + extra : ''}}${pyRequired(op, ['params'])})`;
  return [
    'import pathlib  # noqa: E402',
    'from contract import expect_matches_fixture, items_of  # noqa: E402,F401',
    '',
    '',
    withId('@pytest.mark.positive', s.ids?.functional.fixture),
    'def test_matches_approved_fixture(api):',
    `    """Approved fixture ${fixturePath(f)} (copied to _support/approved)."""`,
    `    fixture = json.loads((pathlib.Path(__file__).resolve().parents[2] / "_support" / "approved" / ${py(fixtureModule(f) + '.json')}).read_text(encoding="utf-8"))`,
    '    items = []',
    ...(pg.entries
      ? [`    for i in range(${pg.maxPages}):`, `        res = ${call(pg.entries)}`, `        ${assertSuccess(op)}`, '        page = items_of(res.json(), fixture["items"])', '        items.extend(page)', `        if len(page) < ${pg.size}:`, '            break']
      : [`    res = ${call('')}`, `    ${assertSuccess(op)}`, '    items.extend(items_of(res.json(), fixture["items"]))']),
    '    expect_matches_fixture(items, fixture)',
    '',
    '',
  ];
}
