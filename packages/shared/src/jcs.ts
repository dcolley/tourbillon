/**
 * APR-2: RFC 8785 JSON Canonicalization Scheme (JCS) for hitl hashes and signatures.
 *
 * ECMAScript `JSON.stringify` already gives the RFC 8785 forms for strings, finite numbers,
 * booleans and null; objects are written with keys sorted by UTF-16 code units (the default
 * JavaScript string order). Non-finite numbers and non-JSON values are refused.
 */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => jcs(v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported value of type ${typeof value}`);
  }
}
