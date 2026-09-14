import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES, YuureiError } from '../../src/cli/exit-codes.js';
import { runRun, type RunOptions } from '../../src/cli/run.js';
import type { RunPipelineInput } from '../../src/run/pipeline.js';
import type { Logger } from '../../src/util/logger.js';

const runPipelineMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/run/pipeline.js', () => ({ runPipeline: runPipelineMock }));

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function baseOptions(overrides: Partial<RunOptions>): RunOptions {
  return {
    runName: undefined,
    profile: undefined,
    task: undefined,
    keep: undefined,
    model: undefined,
    timeoutMs: undefined,
    isolation: undefined,
    bridgeCodexAuthFile: undefined,
    bridgeOpenCodeAuthFile: undefined,
    ...overrides,
  };
}

function capturedInput(): RunPipelineInput {
  const call = runPipelineMock.mock.calls[0];
  if (!call) throw new Error('runPipeline was not called');
  return call[0] as RunPipelineInput;
}

describe('yuurei run parameter resolution', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-run-params-'));
    await mkdir(join(workDir, '.yuurei', 'profiles', 'p'), { recursive: true });
    await mkdir(join(workDir, '.yuurei', 'tasks'), { recursive: true });
    await writeFile(
      join(workDir, '.yuurei', 'profiles', 'p', 'profile.yaml'),
      'runtime: claude-code\n',
    );
    await writeFile(join(workDir, '.yuurei', 'tasks', 'hello.md'), 'hello\n');
    await writeFile(
      join(workDir, '.yuurei', 'yuurei.yaml'),
      [
        'version: 1',
        'profiles:',
        '  p:',
        '    runtime: claude-code',
        '    source: ./profiles/p',
        'runs:',
        '  hello:',
        '    profile: p',
        '    task: ./tasks/hello.md',
        '    model: sonnet',
        '    timeout: 5000',
        '    isolation: level0',
        '  plain:',
        '    profile: p',
        '    task: ./tasks/hello.md',
        '',
      ].join('\n'),
      'utf8',
    );

    runPipelineMock.mockReset();
    runPipelineMock.mockResolvedValue({
      runId: 'run-1',
      runDir: join(workDir, '.yuurei', 'runs', 'run-1'),
      cell: {},
      trace: { execution: { exit_code: 0, signal: null } },
    });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('resolves model, timeout and isolation from the run definition', async () => {
    await runRun(workDir, baseOptions({ runName: 'hello' }), noopLogger);

    const input = capturedInput();
    expect(input.requestedModel).toBe('sonnet');
    expect(input.timeoutMs).toBe(5000);
    expect(input.isolationStrategy).toBe('level0');
    expect(input.definition).toEqual({ run: 'hello', cli_overrides: [] });
  });

  it('lets a CLI flag override the definition per field', async () => {
    await runRun(workDir, baseOptions({ runName: 'hello', model: 'opus' }), noopLogger);

    const input = capturedInput();
    expect(input.requestedModel).toBe('opus');
    // Passing --model must not discard the definition's timeout or isolation.
    expect(input.timeoutMs).toBe(5000);
    expect(input.isolationStrategy).toBe('level0');
    expect(input.definition).toEqual({ run: 'hello', cli_overrides: ['model'] });
  });

  it('applies the defaults when neither the CLI nor the definition supplies a value', async () => {
    await runRun(workDir, baseOptions({ runName: 'plain' }), noopLogger);

    const input = capturedInput();
    expect(input.requestedModel).toBe('');
    expect(input.timeoutMs).toBeNull();
    expect(input.isolationStrategy).toBe('level1');
    expect(input.definition).toEqual({ run: 'plain', cli_overrides: [] });
  });

  it('rejects --profile/--task combined with a run name', async () => {
    const withProfile = runRun(
      workDir,
      baseOptions({ runName: 'hello', profile: 'p' }),
      noopLogger,
    );
    await expect(withProfile).rejects.toBeInstanceOf(YuureiError);
    await expect(withProfile).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    await expect(withProfile).rejects.toThrow(/cannot be combined with a run name/);

    const withTask = runRun(
      workDir,
      baseOptions({ runName: 'hello', task: './tasks/hello.md' }),
      noopLogger,
    );
    await expect(withTask).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    await expect(withTask).rejects.toThrow(/cannot be combined with a run name/);

    expect(runPipelineMock).not.toHaveBeenCalled();
  });

  it('records the direct form with run null and the CLI-supplied parameters', async () => {
    await runRun(
      workDir,
      baseOptions({ profile: 'p', task: './task.md', model: 'opus' }),
      noopLogger,
    );

    const input = capturedInput();
    expect(input.requestedModel).toBe('opus');
    expect(input.timeoutMs).toBeNull();
    expect(input.definition).toEqual({ run: null, cli_overrides: ['model'] });
  });
});
