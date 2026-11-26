import { describe, expect, it } from 'vitest';
import { linuxOwnsTerminal } from './terminal.js';

describe('Linux terminal ownership', () => {
  it.each([
    ['42 (ghost ) run) S 1 42 1 34817 42 0', true],
    ['42 (ghost ) run) S 1 42 1 34817 24 0', false],
    ['42 (ghost) S 1 42 1 0 -1 0', false],
    ['42 (ghost) S 1 42 1 0 42 0', false],
    ['42 (ghost) S 1 42', false],
  ])('reads process groups from %s', (stat, expected) => {
    expect(linuxOwnsTerminal(stat)).toBe(expected);
  });
});
