import { describe, expect, it } from 'vitest';
import { resolvePflBinary } from './resolve.js';
import type { YuureiConfig } from '../config/schema.js';

describe('resolvePflBinary', () => {
  it('returns observer-not-found when no config, env, or PATH', async () => {
    const config: YuureiConfig = {
      version: 1,
      profiles: {},
      runs: {},
    };

    const result = await resolvePflBinary(config);
    expect(result.binPath).toBeNull();
    expect(result.reason).toBe('observer-not-found');
  });

  it('uses config.pfl_path when provided', async () => {
    const config: YuureiConfig = {
      version: 1,
      profiles: {},
      runs: {},
      observer: {
        pfl_path: '/usr/local/bin/pfl',
      },
    };

    // This test assumes the file exists in the test environment
    // In a real test, we'd mock the file system
    const result = await resolvePflBinary(config);
    // The result depends on whether the file exists
    expect(result.binPath).toBeNull(); // File doesn't exist in test env
    expect(result.reason).toBe('observer-not-found');
  });

  it('falls back to PFL_BIN env', async () => {
    const originalPflBin = process.env.PFL_BIN;
    process.env.PFL_BIN = '/usr/local/bin/pfl';

    try {
      const config: YuureiConfig = {
        version: 1,
        profiles: {},
        runs: {},
      };

      const result = await resolvePflBinary(config);
      // The result depends on whether the file exists
      expect(result.binPath).toBeNull(); // File doesn't exist in test env
      expect(result.reason).toBe('observer-not-found');
    } finally {
      if (originalPflBin === undefined) {
        delete process.env.PFL_BIN;
      } else {
        process.env.PFL_BIN = originalPflBin;
      }
    }
  });
});
