import { describe, expect, it } from 'vitest';
import { exitCodeForSignal, SIGNAL_EXIT_CODES } from './signals.js';

describe('exitCodeForSignal', () => {
  it('returns 130 for SIGINT', () => {
    expect(exitCodeForSignal('SIGINT')).toBe(SIGNAL_EXIT_CODES.SIGINT);
    expect(exitCodeForSignal('SIGINT')).toBe(130);
  });

  it('returns 143 for SIGTERM', () => {
    expect(exitCodeForSignal('SIGTERM')).toBe(SIGNAL_EXIT_CODES.SIGTERM);
    expect(exitCodeForSignal('SIGTERM')).toBe(143);
  });

  it('returns 128 for unmapped signals (never exit 0 for a killed run)', () => {
    expect(exitCodeForSignal('SIGKILL')).toBe(128);
    expect(exitCodeForSignal('SIGHUP')).toBe(128);
    expect(exitCodeForSignal('UNKNOWN')).toBe(128);
  });
});
