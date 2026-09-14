import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from './json.js';

describe('canonicalJsonStringify', () => {
  it('is independent of insertion order', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('orders keys by code unit, independent of locale', () => {
    // 'A' (0x41) sorts before 'a' (0x61) under a code-unit comparison. A
    // locale-sensitive comparator can flip this, which would make a digest
    // depend on the machine's locale.
    expect(canonicalJsonStringify({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');
  });

  it('sorts keys recursively', () => {
    expect(canonicalJsonStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('preserves a __proto__ key instead of dropping it', () => {
    // JSON.parse creates an own `__proto__` property. A naive `{}` clone
    // invokes the prototype setter and loses it, colliding with `{}`.
    const withProto = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;

    expect(canonicalJsonStringify(withProto)).toBe('{"__proto__":{"x":1}}');
    expect(canonicalJsonStringify(withProto)).not.toBe(canonicalJsonStringify({}));
  });
});
