import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, YuureiError } from '../../src/cli/exit-codes.js';
import { runRun, type RunOptions } from '../../src/cli/run.js';
import type { Logger } from '../../src/util/logger.js';

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function baseOptions(overrides: Partial<RunOptions>): RunOptions {
  return {
    runName: undefined,
    profile: 'does-not-exist',
    task: 'does-not-exist.md',
    keep: undefined,
    model: undefined,
    timeoutMs: undefined,
    isolation: undefined,
    bridgeCodexAuthFile: undefined,
    ...overrides,
  };
}

describe('yuurei run --isolation', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-cli-isolation-test-'));
    await mkdir(join(workDir, '.yuurei'), { recursive: true });
    await writeFile(
      join(workDir, '.yuurei', 'yuurei.yaml'),
      'version: 1\nprofiles: {}\nruns: {}\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('rejects an unrecognized value before the profile lookup', async () => {
    const run = runRun(workDir, baseOptions({ isolation: 'banana' }), noopLogger);

    await expect(run).rejects.toBeInstanceOf(YuureiError);
    await expect(run).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    await expect(run).rejects.toThrow(/isolation must be one of: level0, level1/);
  });

  it('accepts "level0" and proceeds past validation to the (later) unknown-profile error', async () => {
    const run = runRun(workDir, baseOptions({ isolation: 'level0' }), noopLogger);

    await expect(run).rejects.toBeInstanceOf(YuureiError);
    await expect(run).rejects.toThrow(/unknown profile: does-not-exist/);
  });

  it('accepts "level1" and proceeds past validation to the (later) unknown-profile error', async () => {
    const run = runRun(workDir, baseOptions({ isolation: 'level1' }), noopLogger);

    await expect(run).rejects.toBeInstanceOf(YuureiError);
    await expect(run).rejects.toThrow(/unknown profile: does-not-exist/);
  });

  it('defaults to level1 when omitted, matching the pre-flag behavior', async () => {
    const run = runRun(workDir, baseOptions({ isolation: undefined }), noopLogger);

    // Reaches the same later failure as an explicit "level1" above, proving
    // the omitted flag validated (and defaulted) rather than short-circuiting.
    await expect(run).rejects.toBeInstanceOf(YuureiError);
    await expect(run).rejects.toThrow(/unknown profile: does-not-exist/);
  });
});
