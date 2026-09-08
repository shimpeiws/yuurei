import { describe, expect, it } from 'vitest';
import { redactKnownValues, redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('redacts common token shapes while preserving surrounding text', () => {
    expect(redactSecrets('request sk-1234567890abcdef completed')).toBe(
      'request [REDACTED] completed',
    );
    expect(redactSecrets('Bearer abcdefghijklmnop')).toBe('[REDACTED]');
  });
});

describe('redactKnownValues', () => {
  it('redacts exact values and ignores values too short to be credentials', () => {
    expect(redactKnownValues('token=secret-value; short=abc', ['secret-value', 'abc'])).toBe(
      'token=[REDACTED]; short=abc',
    );
  });
});
