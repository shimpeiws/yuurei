import { describe, expect, it } from 'vitest';
import { isVersionAtLeast } from './detect.js';
import { MIN_SUPPORTED_VERSION as CLAUDE_MIN } from './claude-code/index.js';
import { MIN_SUPPORTED_VERSION as CODEX_MIN } from './codex/index.js';
import { MIN_SUPPORTED_VERSION as OPENCODE_MIN } from './opencode/index.js';

interface MinimumCase {
  runtime: string;
  /** The adapter's declared minimum, imported from the adapter. */
  minimum: [number, number, number];
  /** The value this test pins. Changing the adapter's constant fails here first. */
  declared: [number, number, number];
  /** A version just below the minimum. */
  below: string;
}

const CASES: MinimumCase[] = [
  { runtime: 'claude-code', minimum: CLAUDE_MIN, declared: [2, 0, 0], below: '1.9.9' },
  { runtime: 'codex', minimum: CODEX_MIN, declared: [0, 100, 0], below: '0.99.9' },
  { runtime: 'opencode', minimum: OPENCODE_MIN, declared: [1, 18, 0], below: '1.17.9' },
];

describe('runtime minimum supported versions', () => {
  it.each(CASES)('$runtime pins its declared minimum', ({ minimum, declared }) => {
    // A change to an adapter's boundary has to update this expectation too, so
    // it is a deliberate edit rather than a silent drift (#144).
    expect(minimum).toEqual(declared);
  });

  it.each(CASES)('$runtime accepts its minimum and rejects one below', ({ minimum, below }) => {
    const atMinimum = minimum.join('.');
    expect(isVersionAtLeast(atMinimum, minimum)).toBe(true);
    expect(isVersionAtLeast(below, minimum)).toBe(false);
  });
});

describe('isVersionAtLeast', () => {
  it('returns null when the version is unknown', () => {
    expect(isVersionAtLeast(null, [1, 0, 0])).toBeNull();
  });

  it('compares major, then minor, then patch', () => {
    expect(isVersionAtLeast('2.0.0', [1, 9, 9])).toBe(true);
    expect(isVersionAtLeast('1.10.0', [1, 9, 9])).toBe(true);
    expect(isVersionAtLeast('1.9.10', [1, 9, 9])).toBe(true);
    expect(isVersionAtLeast('1.9.9', [1, 9, 10])).toBe(false);
  });
});
