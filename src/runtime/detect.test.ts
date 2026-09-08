import { describe, expect, it } from 'vitest';
import { isVersionAtLeast } from './detect.js';

describe('isVersionAtLeast', () => {
  it('compares versions embedded in runtime version output', () => {
    expect(isVersionAtLeast('2.1.265 (Claude Code)', [2, 0, 0])).toBe(true);
    expect(isVersionAtLeast('0.99.0', [0, 100, 0])).toBe(false);
    expect(isVersionAtLeast('0.100.0', [0, 100, 0])).toBe(true);
  });

  it('returns null when no comparable version is available', () => {
    expect(isVersionAtLeast(null, [1, 0, 0])).toBeNull();
    expect(isVersionAtLeast('development build', [1, 0, 0])).toBeNull();
  });

  it('uses the final version token in a CLI banner', () => {
    expect(isVersionAtLeast('build 2026.09.08 codex-cli 0.153.4', [0, 100, 0])).toBe(true);
  });
});
