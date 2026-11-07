import { resolvePointer, type OpenApiDoc } from '../spec/loader.js';

export type Sample = { ok: true; value: unknown; sources: string[] } | { ok: false; reason: string };

const FORMAT_VALUES: Record<string, unknown> = {
  uuid: '00000000-0000-4000-8000-000000000000',
  email: 'qa.agent@example.com',
  'date-time': '2030-01-01T00:00:00Z',
  date: '2030-01-01',
  uri: 'https://example.com/',
  url: 'https://example.com/',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
};

/**
 * Deterministic payload from a schema. Order of preference: example → default → enum/const →
 * a minimal value that satisfies simple constraints. Optional properties are included only
 * when the spec gives an example, so every value can be traced to the spec.
 * Refuses (ok:false) instead of guessing when a constraint cannot be met deterministically.
 */
export function sampleFromSchema(doc: OpenApiDoc, schema: any, path = '$', depth = 0): Sample {
  if (depth > 8) return { ok: false, reason: `${path}: schema nesting too deep` };
  if (schema?.$ref) {
    const name = schema.$ref.split('/').pop();
    const r = sampleFromSchema(doc, resolvePointer(doc, schema.$ref.slice(1)).node, path, depth + 1);
    return r.ok ? { ...r, sources: r.sources.map((s) => s.replace(path, `${path}<${name}>`)) } : r;
  }
  if (!schema || typeof schema !== 'object') return { ok: false, reason: `${path}: no schema` };

  if (schema.example !== undefined) return { ok: true, value: schema.example, sources: [`${path}: example`] };
  if (Array.isArray(schema.examples) && schema.examples.length) return { ok: true, value: schema.examples[0], sources: [`${path}: examples[0]`] };
  if (schema.default !== undefined) return { ok: true, value: schema.default, sources: [`${path}: default`] };
  if (schema.const !== undefined) return { ok: true, value: schema.const, sources: [`${path}: const`] };
  if (Array.isArray(schema.enum) && schema.enum.length) return { ok: true, value: schema.enum[0], sources: [`${path}: enum[0]`] };

  if (Array.isArray(schema.allOf)) {
    const merged: Record<string, unknown> = {};
    const sources: string[] = [];
    for (const part of schema.allOf) {
      const r = sampleFromSchema(doc, part, path, depth + 1);
      if (!r.ok) return r;
      if (typeof r.value !== 'object' || r.value === null) return { ok: false, reason: `${path}: allOf of non-objects is not supported` };
      Object.assign(merged, r.value);
      sources.push(...r.sources);
    }
    return { ok: true, value: merged, sources };
  }
  const alt = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(alt)) {
    if (schema.discriminator) return { ok: false, reason: `${path}: polymorphic body with discriminator, choose the variant explicitly` };
    return sampleFromSchema(doc, alt[0], `${path}(variant 0)`, depth + 1);
  }

  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type ?? (schema.properties ? 'object' : undefined);
  switch (type) {
    case 'object': {
      const value: Record<string, unknown> = {};
      const sources: string[] = [];
      const required: string[] = schema.required ?? [];
      for (const [prop, sub] of Object.entries<any>(schema.properties ?? {})) {
        const subNode = sub?.$ref ? resolvePointer(doc, sub.$ref.slice(1)).node : sub;
        if (subNode?.readOnly) continue;
        const isReq = required.includes(prop);
        const hasExample = subNode?.example !== undefined || (Array.isArray(subNode?.examples) && subNode.examples.length);
        if (!isReq && !hasExample) continue;
        const r = sampleFromSchema(doc, sub, `${path}.${prop}`, depth + 1);
        if (!r.ok) {
          if (isReq) return r;
          continue;
        }
        value[prop] = r.value;
        sources.push(...r.sources);
      }
      const missing = required.filter((k) => !(k in value) && !(schema.properties ?? {})[k]);
      if (missing.length) return { ok: false, reason: `${path}: required ${missing.join(', ')} not described in properties` };
      return { ok: true, value, sources };
    }
    case 'array': {
      const min = schema.minItems ?? 0;
      if (!min) return { ok: true, value: [], sources: [`${path}: empty array (no minItems)`] };
      const r = sampleFromSchema(doc, schema.items, `${path}[]`, depth + 1);
      return r.ok ? { ok: true, value: Array.from({ length: min }, () => r.value), sources: r.sources } : r;
    }
    case 'string': {
      if (schema.format && FORMAT_VALUES[schema.format] !== undefined) return { ok: true, value: FORMAT_VALUES[schema.format], sources: [`${path}: format ${schema.format}`] };
      if (schema.pattern) return { ok: false, reason: `${path}: string with pattern ${schema.pattern} and no example, cannot derive a valid value` };
      const min = schema.minLength ?? 0;
      const max = schema.maxLength ?? Infinity;
      let v = 'api-agent';
      while (v.length < min) v += '-x';
      return { ok: true, value: v.slice(0, Math.min(max, Math.max(min, v.length))), sources: [`${path}: minimal string`] };
    }
    case 'integer':
    case 'number': {
      const lo = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? Number(schema.exclusiveMinimum) + 1 : 1);
      const hi = schema.maximum ?? Infinity;
      if (lo > hi) return { ok: false, reason: `${path}: minimum > maximum` };
      return { ok: true, value: type === 'integer' ? Math.ceil(lo) : lo, sources: [`${path}: minimal number`] };
    }
    case 'boolean':
      return { ok: true, value: false, sources: [`${path}: boolean false`] };
    default:
      return { ok: false, reason: `${path}: no type, example or default` };
  }
}
