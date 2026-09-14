/**
 * Serializes a value to JSON with object keys sorted recursively, so that
 * two structurally-equal values always produce the same string regardless
 * of insertion order. Digests (cell_digest, profile digest, task digest)
 * must be computed over this canonical form, not `JSON.stringify`.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    // Code-unit order, not `localeCompare`: the canonical form must not depend
    // on the machine's locale, or two hosts would digest equal content
    // differently.
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    // Null prototype so a literal `__proto__` key is stored as an own
    // property. Assigning it onto `{}` invokes the prototype setter and drops
    // it, which would make `{ __proto__: { x: 1 } }` digest like `{}`.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const [key, entryValue] of entries) {
      sorted[key] = sortKeysDeep(entryValue);
    }
    return sorted;
  }
  return value;
}
