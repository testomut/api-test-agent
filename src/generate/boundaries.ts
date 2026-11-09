/** Boundary-valid values shared by the generator (accepted-value cases) and registry validation. */

/**
 * The valid limits of a scalar schema: minimum / maximum (inside exclusive bounds, on multipleOf) and the shortest /
 * longest string (strings without pattern / format, at most 64 characters so the case ID stays readable).
 */
export function boundaryValues(schema: any): (string | number)[] {
  const t = Array.isArray(schema?.type) ? schema.type.find((x: string) => x !== 'null') : schema?.type;
  const out: (string | number)[] = [];
  if (t === 'integer' || t === 'number') {
    const m = typeof schema.multipleOf === 'number' && schema.multipleOf > 0 ? schema.multipleOf : t === 'integer' ? 1 : undefined;
    const fits = (v: number) =>
      (t !== 'integer' || Number.isInteger(v)) &&
      (m === undefined || Math.abs(v / m - Math.round(v / m)) < 1e-9) &&
      (typeof schema.minimum !== 'number' || v >= schema.minimum) &&
      (typeof schema.maximum !== 'number' || v <= schema.maximum) &&
      (typeof schema.exclusiveMinimum !== 'number' || v > schema.exclusiveMinimum) &&
      (typeof schema.exclusiveMaximum !== 'number' || v < schema.exclusiveMaximum) &&
      !(schema.exclusiveMinimum === true && v === schema.minimum) &&
      !(schema.exclusiveMaximum === true && v === schema.maximum);
    const lo = typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' && m ? Math.floor(schema.exclusiveMinimum / m + 1) * m : undefined;
    const hi = typeof schema.maximum === 'number' ? schema.maximum : typeof schema.exclusiveMaximum === 'number' && m ? Math.ceil(schema.exclusiveMaximum / m - 1) * m : undefined;
    for (const v of [lo, hi]) if (v !== undefined && fits(v) && !out.includes(v)) out.push(v);
  }
  if (t === 'string' && !schema.pattern && !schema.format) {
    for (const n of [schema.minLength, schema.maxLength]) if (typeof n === 'number' && n > 0 && n <= 64 && !out.includes('x'.repeat(n))) out.push('x'.repeat(n));
  }
  return out;
}
