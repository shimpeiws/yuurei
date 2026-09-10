import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES, YuureiError } from '../../src/cli/exit-codes.js';
import { NoopCostModel } from '../../src/cost/noop.js';
import { runPipeline } from '../../src/run/pipeline.js';
import { pathExists } from '../../src/util/fs.js';
import type { ResolvedProfile } from '../../src/profile/types.js';
import type { IsolationContext } from '../../src/isolation/types.js';
import type { NormalizationContext, PreparedRun, Runtime } from '../../src/runtime/types.js';
import type { ResolvedCell } from '../../src/cell/types.js';

describe('run pipeline', () => {
  let workDir: string;
  let taskPath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-pipeline-test-'));
    taskPath = join(workDir, 'task.md');
    await writeFile(taskPath, '# Task\n\nDo nothing.\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('rejects a profile referencing an unregistered runtime before executing anything', async () => {
    const profile: ResolvedProfile = {
      name: 'unsupported',
      runtime: 'not-a-real-runtime',
      content: {
        profileYaml: { runtime: 'not-a-real-runtime' },
        configFiles: {},
      },
      digest: 'sha256:0000',
    };

    const run = runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level0',
      keep: false,
    });

    await expect(run).rejects.toThrow(/unknown runtime/);
    await expect(run).rejects.toMatchObject({
      exitCode: EXIT_CODES.RUNTIME_UNSUPPORTED,
    });
    await expect(run).rejects.toBeInstanceOf(YuureiError);
  });

  it('scrubs a prepared credential file even when --keep is set', async () => {
    // --keep must preserve config/logs for debugging but never bridged
    // credential material (the narrowed decision on PR #20's Blocker #2).
    const profile: ResolvedProfile = {
      name: 'fake-cred',
      runtime: 'fake-cred-runtime',
      content: {
        profileYaml: { runtime: 'fake-cred-runtime' },
        configFiles: {},
      },
      digest: 'sha256:0000',
    };

    let credentialPath: string | undefined;
    let observedRootDir: string | undefined;

    const fake: Runtime = {
      id: () => 'fake-cred-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => {
        observedRootDir = isolation.rootDir;
        credentialPath = join(isolation.rootDir, 'bridged-credential.txt');
        await writeFile(credentialPath, 'secret\n', 'utf8');
        return {
          runtimeId: 'fake-cred-runtime',
          command: 'true',
          args: [],
          env: {},
          cwd: isolation.rootDir,
          isolation,
          cell,
          runtimeVersion: null,
          credentialFilePaths: [credentialPath],
          credentialValuesToRedact: [],
        };
      },
      execute: async (run: PreparedRun) => {
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: 0,
          signal: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async (_result, context: NormalizationContext) => ({
        runtime: { id: 'fake-cred-runtime', version: context.runtimeVersion },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, durationMs: 0 },
        usage: {},
      }),
    };

    await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: true,
      resolveRuntime: () => fake,
    });

    if (!credentialPath || !observedRootDir)
      throw new Error('fake runtime prepare() was never called');
    await expect(readFile(credentialPath, 'utf8')).rejects.toThrow();
    expect(await pathExists(observedRootDir)).toBe(true);

    await rm(observedRootDir, { recursive: true, force: true });
  });

  it('warns instead of throwing when a credential file cannot be scrubbed', async () => {
    // Point credentialFilePaths at a non-empty directory: rm(path, { force: true })
    // (no `recursive: true`) throws on that, exercising the failure branch of the
    // scrub without needing to mock fs.
    const profile: ResolvedProfile = {
      name: 'fake-cred-unscrubbable',
      runtime: 'fake-cred-runtime-2',
      content: {
        profileYaml: { runtime: 'fake-cred-runtime-2' },
        configFiles: {},
      },
      digest: 'sha256:0000',
    };

    let unscrubbablePath: string | undefined;

    const fake: Runtime = {
      id: () => 'fake-cred-runtime-2',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => {
        unscrubbablePath = join(isolation.rootDir, 'not-actually-a-file');
        await mkdir(unscrubbablePath, { recursive: true });
        await writeFile(join(unscrubbablePath, 'inner.txt'), 'x', 'utf8');
        return {
          runtimeId: 'fake-cred-runtime-2',
          command: 'true',
          args: [],
          env: {},
          cwd: isolation.rootDir,
          isolation,
          cell,
          runtimeVersion: null,
          credentialFilePaths: [unscrubbablePath],
          credentialValuesToRedact: [],
        };
      },
      execute: async (run: PreparedRun) => {
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: 0,
          signal: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async () => ({
        runtime: { id: 'fake-cred-runtime-2', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, durationMs: 0 },
        usage: {},
      }),
    };

    const warnings: string[] = [];
    await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      resolveRuntime: () => fake,
      onWarning: (message) => warnings.push(message),
    });

    if (!unscrubbablePath) throw new Error('fake runtime prepare() was never called');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(unscrubbablePath);
  });

  it('reports a scrub-failure warning via onWarning even when a later step throws', async () => {
    // The whole point of the callback: when execute() throws, no
    // RunPipelineResult is ever returned, so onWarning is the only channel
    // through which a lost-credential warning can still reach the caller.
    const profile: ResolvedProfile = {
      name: 'fake-cred-throws',
      runtime: 'fake-cred-runtime-4',
      content: {
        profileYaml: { runtime: 'fake-cred-runtime-4' },
        configFiles: {},
      },
      digest: 'sha256:0000',
    };

    let unscrubbablePath: string | undefined;

    const fake: Runtime = {
      id: () => 'fake-cred-runtime-4',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => {
        unscrubbablePath = join(isolation.rootDir, 'not-actually-a-file');
        await mkdir(unscrubbablePath, { recursive: true });
        await writeFile(join(unscrubbablePath, 'inner.txt'), 'x', 'utf8');
        return {
          runtimeId: 'fake-cred-runtime-4',
          command: 'true',
          args: [],
          env: {},
          cwd: isolation.rootDir,
          isolation,
          cell,
          runtimeVersion: null,
          credentialFilePaths: [unscrubbablePath],
          credentialValuesToRedact: [],
        };
      },
      execute: async () => {
        throw new Error('simulated execution failure');
      },
      normalize: async () => ({
        runtime: { id: 'fake-cred-runtime-4', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, durationMs: 0 },
        usage: {},
      }),
    };

    const warnings: string[] = [];
    await expect(
      runPipeline({
        runtimeId: profile.runtime,
        requestedModel: '',
        profile,
        taskPath,
        yuureiVersion: '0.0.1',
        yuureiDir: workDir,
        isolationStrategy: 'level1',
        keep: false,
        resolveRuntime: () => fake,
        onWarning: (message) => warnings.push(message),
      }),
    ).rejects.toThrow('simulated execution failure');

    if (!unscrubbablePath) throw new Error('fake runtime prepare() was never called');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(unscrubbablePath);
  });

  it('redacts a known bridged credential value from persisted stdout/stderr', async () => {
    const profile: ResolvedProfile = {
      name: 'fake-cred-logging',
      runtime: 'fake-cred-runtime-3',
      content: {
        profileYaml: { runtime: 'fake-cred-runtime-3' },
        configFiles: {},
      },
      digest: 'sha256:0000',
    };

    const secretValue = 'sk-test-do-not-persist-this-literal-value';

    const fake: Runtime = {
      id: () => 'fake-cred-runtime-3',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
        runtimeId: 'fake-cred-runtime-3',
        command: 'true',
        args: [],
        env: { OPENAI_API_KEY: secretValue },
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialFilePaths: [],
        credentialValuesToRedact: [secretValue],
      }),
      execute: async (run: PreparedRun) => {
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        // Simulate the spawned process accidentally printing its own env,
        // the exact scenario the reviewer flagged.
        await writeFile(stdoutPath, `starting with OPENAI_API_KEY=${secretValue}\n`, 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: 0,
          signal: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async () => ({
        runtime: { id: 'fake-cred-runtime-3', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, durationMs: 0 },
        usage: {},
      }),
    };

    const result = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      resolveRuntime: () => fake,
    });

    const persistedStdout = await readFile(join(result.runDir, 'stdout.log'), 'utf8');
    expect(persistedStdout).not.toContain(secretValue);
    expect(persistedStdout).toContain('[REDACTED]');
  });

  it('caps redacted stdout and stderr without leaking a secret across chunks', async () => {
    const profile: ResolvedProfile = {
      name: 'fake-capped-logging',
      runtime: 'fake-capped-runtime',
      content: { profileYaml: { runtime: 'fake-capped-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    };
    const secretValue = 'secret-value-that-crosses-the-stream-chunk-boundary';

    const fake: Runtime = {
      id: () => 'fake-capped-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
        runtimeId: 'fake-capped-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialFilePaths: [],
        credentialValuesToRedact: [secretValue],
      }),
      execute: async (run: PreparedRun) => {
        await writeFile(
          join(run.isolation.rootDir, 'stdout.log'),
          `prefix ${secretValue} suffix\n`,
          'utf8',
        );
        await writeFile(
          join(run.isolation.rootDir, 'stderr.log'),
          'error output that is longer than the cap\n',
          'utf8',
        );
        return {
          exitCode: 0,
          signal: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath: join(run.isolation.rootDir, 'stdout.log'),
          stderrPath: join(run.isolation.rootDir, 'stderr.log'),
          timedOut: false,
        };
      },
      normalize: async () => ({
        runtime: { id: 'fake-capped-runtime', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, durationMs: 0 },
        usage: {},
      }),
    };

    const result = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      maxArtifactBytes: 12,
      resolveRuntime: () => fake,
    });

    await expect(readFile(join(result.runDir, 'stdout.log'), 'utf8')).resolves.toBe('prefix [REDA');
    await expect(readFile(join(result.runDir, 'stderr.log'), 'utf8')).resolves.toBe('error output');
    await expect(readFile(join(result.runDir, 'artifacts.json'), 'utf8')).resolves.toContain(
      '"truncated": true',
    );
    await expect(readFile(join(result.runDir, 'artifacts.json'), 'utf8')).resolves.not.toContain(
      secretValue,
    );
  });

  it('threads timeoutMs into Runtime.execute() and records timed_out in the trace', async () => {
    const profile: ResolvedProfile = {
      name: 'fake-timeout',
      runtime: 'fake-timeout-runtime',
      content: {
        profileYaml: { runtime: 'fake-timeout-runtime' },
        configFiles: {},
      },
      digest: 'sha256:0000',
    };

    let receivedTimeoutMs: number | null | undefined;

    const fake: Runtime = {
      id: () => 'fake-timeout-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
        runtimeId: 'fake-timeout-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialFilePaths: [],
        credentialValuesToRedact: [],
      }),
      execute: async (run: PreparedRun, timeoutMs: number | null) => {
        receivedTimeoutMs = timeoutMs;
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: null,
          signal: 'SIGTERM' as const,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: true,
        };
      },
      normalize: async () => ({
        runtime: { id: 'fake-timeout-runtime', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: null, durationMs: 0 },
        usage: {},
      }),
    };

    const result = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      timeoutMs: 5000,
      resolveRuntime: () => fake,
    });

    expect(receivedTimeoutMs).toBe(5000);
    expect(result.trace.execution.timed_out).toBe(true);
  });

  it('passes null to Runtime.execute() when no timeoutMs is configured', async () => {
    const profile: ResolvedProfile = {
      name: 'fake-no-timeout',
      runtime: 'fake-no-timeout-runtime',
      content: {
        profileYaml: { runtime: 'fake-no-timeout-runtime' },
        configFiles: {},
      },
      digest: 'sha256:0000',
    };

    let receivedTimeoutMs: number | null | undefined;

    const fake: Runtime = {
      id: () => 'fake-no-timeout-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
        runtimeId: 'fake-no-timeout-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialFilePaths: [],
        credentialValuesToRedact: [],
      }),
      execute: async (run: PreparedRun, timeoutMs: number | null) => {
        receivedTimeoutMs = timeoutMs;
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: 0,
          signal: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async () => ({
        runtime: { id: 'fake-no-timeout-runtime', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, durationMs: 0 },
        usage: {},
      }),
    };

    const result = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      resolveRuntime: () => fake,
    });

    expect(receivedTimeoutMs).toBeNull();
    expect(result.trace.execution.timed_out).toBe(false);
  });

  it('gives concurrent runs distinct run directories', async () => {
    const profile: ResolvedProfile = {
      name: 'fake-concurrent',
      runtime: 'fake-concurrent-runtime',
      content: { profileYaml: { runtime: 'fake-concurrent-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    };

    const fake: Runtime = {
      id: () => 'fake-concurrent-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
        runtimeId: 'fake-concurrent-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialFilePaths: [],
        credentialValuesToRedact: [],
      }),
      execute: async (run: PreparedRun) => {
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await Promise.all([writeFile(stdoutPath, '', 'utf8'), writeFile(stderrPath, '', 'utf8')]);
        return {
          exitCode: 0,
          signal: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async () => ({
        runtime: { id: 'fake-concurrent-runtime', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, durationMs: 0 },
        usage: {},
      }),
    };

    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        runPipeline({
          runtimeId: profile.runtime,
          requestedModel: '',
          profile,
          taskPath,
          yuureiVersion: '0.0.1',
          yuureiDir: workDir,
          isolationStrategy: 'level1',
          keep: false,
          resolveRuntime: () => fake,
        }),
      ),
    );

    expect(new Set(runs.map((r) => r.runDir)).size).toBe(runs.length);
  });

  it('gives otherwise-identical level0 and level1 runs different cell digests', async () => {
    // Regression guard for the isolation strategy being a cell-identity
    // input (design doc §7.3): level0 and level1 runs have materially
    // different HOME/config semantics and must never be treated as the
    // same execution cell by the comparison/ROI layer.
    const profile: ResolvedProfile = {
      name: 'fake-isolation-identity',
      runtime: 'fake-isolation-identity-runtime',
      content: {
        profileYaml: { runtime: 'fake-isolation-identity-runtime' },
        configFiles: {},
      },
      digest: 'sha256:0000',
    };

    const fake: Runtime = {
      id: () => 'fake-isolation-identity-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
        runtimeId: 'fake-isolation-identity-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialFilePaths: [],
        credentialValuesToRedact: [],
      }),
      execute: async (run: PreparedRun) => {
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: 0,
          signal: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async () => ({
        runtime: { id: 'fake-isolation-identity-runtime', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, durationMs: 0 },
        usage: {},
      }),
    };

    const runWithStrategy = (isolationStrategy: 'level0' | 'level1') =>
      runPipeline({
        runtimeId: profile.runtime,
        requestedModel: '',
        profile,
        taskPath,
        yuureiVersion: '0.0.1',
        yuureiDir: workDir,
        isolationStrategy,
        keep: false,
        resolveRuntime: () => fake,
      });

    const [level0Result, level1Result] = await Promise.all([
      runWithStrategy('level0'),
      runWithStrategy('level1'),
    ]);

    expect(level0Result.cell.isolationStrategy).toBe('level0');
    expect(level1Result.cell.isolationStrategy).toBe('level1');
    expect(level0Result.cell.cellDigest).not.toBe(level1Result.cell.cellDigest);
  });

  it('passes runtime, requested model, and observed usage to CostModel.estimate()', async () => {
    const profile: ResolvedProfile = {
      name: 'fake-cost',
      runtime: 'fake-cost-runtime',
      content: { profileYaml: { runtime: 'fake-cost-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    };

    const estimate = vi.spyOn(NoopCostModel.prototype, 'estimate');
    const fake: Runtime = {
      id: () => 'fake-cost-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
        runtimeId: 'fake-cost-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialFilePaths: [],
        credentialValuesToRedact: [],
      }),
      execute: async (run: PreparedRun) => {
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: 0,
          signal: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async () => ({
        runtime: { id: 'fake-cost-runtime', version: null },
        model: { requested: '', resolved: 'resolved-model' },
        execution: { exitCode: 0, durationMs: 0 },
        usage: { input_tokens: 123, output_tokens: null },
      }),
    };

    await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: 'requested-model',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      resolveRuntime: () => fake,
    });

    expect(estimate).toHaveBeenCalledWith({
      runtimeId: 'fake-cost-runtime',
      model: 'requested-model',
      tokensIn: 123,
      tokensOut: null,
    });
  });
});
