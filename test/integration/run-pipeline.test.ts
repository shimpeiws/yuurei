import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES, YuureiError } from '../../src/cli/exit-codes.js';
import { NoopCostModel } from '../../src/cost/noop.js';
import { runPipeline } from '../../src/run/pipeline.js';
import { pathExists } from '../../src/util/fs.js';
import { sha256Digest } from '../../src/util/hash.js';
import type { ResolvedProfile } from '../../src/profile/types.js';
import type { IsolationContext } from '../../src/isolation/types.js';
import type {
  NormalizationContext,
  PreparedRun,
  RegisterCredentialPath,
  Runtime,
} from '../../src/runtime/types.js';
import type { ResolvedCell } from '../../src/cell/types.js';

/** A runtime that does nothing but satisfy the pipeline's happy path. */
function makeTrivialRuntime(id: string): Runtime {
  return {
    id: () => id,
    detect: async () => ({
      installed: true,
      version: null,
      executablePath: null,
      authUsable: null,
    }),
    prepare: async (
      cell: ResolvedCell,
      isolation: IsolationContext,
      _registerCredentialPath: RegisterCredentialPath,
    ): Promise<PreparedRun> => ({
      runtimeId: id,
      command: 'true',
      args: [],
      env: {},
      cwd: isolation.rootDir,
      isolation,
      cell,
      runtimeVersion: null,
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
      runtime: { id, version: null },
      model: { requested: '', resolved: null },
      execution: { exitCode: 0, signal: null, durationMs: 0 },
      usage: {},
    }),
  };
}

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

  it('records profile config files by digest, without their contents', async () => {
    // §10.1 records a digest of the profile content, not the content; §10.2
    // puts API keys and auth tokens outside what is recorded at all. A
    // profile's config/ can legitimately carry a secret (an MCP server
    // definition with an API key is the ordinary case), and .yuurei/runs/
    // outlives the cell by design.
    const secret = 'sk-ant-api03-THISISTHEPROFILESECRET';
    const mcpJson = JSON.stringify({ mcpServers: { x: { env: { API_KEY: secret } } } });
    const profile: ResolvedProfile = {
      name: 'leaky',
      runtime: 'fake-manifest-runtime',
      content: {
        profileYaml: { runtime: 'fake-manifest-runtime' },
        configFiles: { '.mcp.json': { content: Buffer.from(mcpJson), mode: 0o644 } },
      },
      digest: 'sha256:0000',
    };

    const fake = makeTrivialRuntime('fake-manifest-runtime');
    const { runDir } = await runPipeline({
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

    const raw = await readFile(join(runDir, 'resolved-profile.json'), 'utf8');
    // Compact first: the secret is unreachable by a plain grep of the
    // pretty-printed file even when it IS present, because JSON.stringify
    // renders a Buffer as a byte array with one element per line.
    const compact = JSON.stringify(JSON.parse(raw));
    expect(compact).not.toContain(secret);
    expect(compact).not.toContain(JSON.stringify([...Buffer.from(secret)]).slice(1, -1));
    // The invariant the two checks above sample: no file content reaches the
    // record at all, in any encoding.
    expect(compact).not.toContain('"type":"Buffer"');

    // Identity is still recorded, which is what §10.1 asks for.
    const manifest = JSON.parse(raw) as {
      configFiles: Record<string, { digest: string; mode: number; bytes: number }>;
    };
    const entry = manifest.configFiles['.mcp.json'];
    expect(entry).toBeDefined();
    expect(entry?.digest).toBe(sha256Digest(Buffer.from(mcpJson)));
    expect(entry?.bytes).toBe(Buffer.byteLength(mcpJson));
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => {
        observedRootDir = isolation.rootDir;
        credentialPath = join(isolation.rootDir, 'bridged-credential.txt');
        registerCredentialPath(credentialPath);
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
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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

  it('removes a kept isolation root when prepare() throws, and says why', async () => {
    // The signal variant of this window lives in signal-cleanup.test.ts; a
    // throwing prepare() reaches the same state in-process. This fake writes a
    // credential file WITHOUT registering it — the residual gap #55 protects
    // against. The pipeline cannot name the credential material (nothing is on
    // the sink), so under --keep the whole root goes rather than risk residue;
    // an adapter that registers at write time gets the precise scrub instead
    // (covered by the signal-during-prepare fixture). §9.2 puts credentials
    // outside what --keep may retain.
    const profile: ResolvedProfile = {
      name: 'fake-prepare-throws',
      runtime: 'fake-prepare-throws-runtime',
      content: { profileYaml: { runtime: 'fake-prepare-throws-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    };

    let credentialPath: string | undefined;
    let observedRootDir: string | undefined;
    const warnings: string[] = [];

    const fake: Runtime = {
      id: () => 'fake-prepare-throws-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (
        _cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => {
        observedRootDir = isolation.rootDir;
        credentialPath = join(isolation.rootDir, 'bridged-credential.txt');
        await writeFile(credentialPath, 'secret\n', 'utf8');
        throw new Error('adapter failed after writing the credential');
      },
      execute: async () => {
        throw new Error('execute() must not be reached');
      },
      normalize: async () => ({
        runtime: { id: 'fake-prepare-throws-runtime', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, signal: null, durationMs: 0 },
        usage: {},
      }),
    };

    await expect(
      runPipeline({
        runtimeId: profile.runtime,
        requestedModel: '',
        profile,
        taskPath,
        yuureiVersion: '0.0.1',
        yuureiDir: workDir,
        isolationStrategy: 'level1',
        keep: true,
        resolveRuntime: () => fake,
        onWarning: (message) => warnings.push(message),
      }),
    ).rejects.toThrow('adapter failed after writing the credential');

    if (!credentialPath || !observedRootDir)
      throw new Error('fake runtime prepare() was never called');
    expect(await pathExists(credentialPath)).toBe(false);
    expect(await pathExists(observedRootDir)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('despite --keep');
    expect(warnings[0]).toContain(observedRootDir);
  });

  it('warns instead of throwing when a credential file cannot be scrubbed', async () => {
    // Point the registered credential path at a non-empty directory: rm(path, { force: true })
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => {
        unscrubbablePath = join(isolation.rootDir, 'not-actually-a-file');
        await mkdir(unscrubbablePath, { recursive: true });
        await writeFile(join(unscrubbablePath, 'inner.txt'), 'x', 'utf8');
        registerCredentialPath(unscrubbablePath);
        return {
          runtimeId: 'fake-cred-runtime-2',
          command: 'true',
          args: [],
          env: {},
          cwd: isolation.rootDir,
          isolation,
          cell,
          runtimeVersion: null,
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
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => {
        unscrubbablePath = join(isolation.rootDir, 'not-actually-a-file');
        await mkdir(unscrubbablePath, { recursive: true });
        await writeFile(join(unscrubbablePath, 'inner.txt'), 'x', 'utf8');
        registerCredentialPath(unscrubbablePath);
        return {
          runtimeId: 'fake-cred-runtime-4',
          command: 'true',
          args: [],
          env: {},
          cwd: isolation.rootDir,
          isolation,
          cell,
          runtimeVersion: null,
          credentialValuesToRedact: [],
        };
      },
      execute: async () => {
        throw new Error('simulated execution failure');
      },
      normalize: async () => ({
        runtime: { id: 'fake-cred-runtime-4', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-cred-runtime-3',
        command: 'true',
        args: [],
        env: { OPENAI_API_KEY: secretValue },
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
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
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-capped-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
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
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-timeout-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
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
        execution: { exitCode: null, signal: null, durationMs: 0 },
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-no-timeout-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
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
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-concurrent-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
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
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-isolation-identity-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
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
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-cost-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
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
        execution: { exitCode: 0, signal: null, durationMs: 0 },
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

  it('records signal in the trace when the runtime child is killed by a signal', async () => {
    // Defect A: a signal-terminated child (exitCode null, signal 'SIGINT') must
    // be recorded in trace.execution.signal; exit_code stays null.
    const profile: ResolvedProfile = {
      name: 'fake-sigint',
      runtime: 'fake-sigint-runtime',
      content: { profileYaml: { runtime: 'fake-sigint-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    };

    const fake: Runtime = {
      id: () => 'fake-sigint-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-sigint-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialValuesToRedact: [],
      }),
      execute: async (run: PreparedRun) => {
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: null,
          signal: 'SIGINT' as const,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async (result) => ({
        runtime: { id: 'fake-sigint-runtime', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: result.exitCode, signal: result.signal, durationMs: 0 },
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

    expect(result.trace.execution.signal).toBe('SIGINT');
    expect(result.trace.execution.exit_code).toBeNull();
    expect(result.trace.execution.timed_out).toBe(false);
    // Schema must still be valid (signal-terminated run is a documented outcome).
    const { TraceSchema } = await import('../../src/trace/schema.js');
    expect(() => TraceSchema.parse(result.trace)).not.toThrow();
  });

  it('removes the run directory when the pipeline throws before writing a trace', async () => {
    // Defect B: any run that ends before writeTrace (here: execute() throws)
    // must not leave a partial run directory behind.
    const profile: ResolvedProfile = {
      name: 'fake-throw',
      runtime: 'fake-throw-runtime',
      content: { profileYaml: { runtime: 'fake-throw-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    };

    const fake: Runtime = {
      id: () => 'fake-throw-runtime',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (
        cell: ResolvedCell,
        isolation: IsolationContext,
        _registerCredentialPath: RegisterCredentialPath,
      ): Promise<PreparedRun> => ({
        runtimeId: 'fake-throw-runtime',
        command: 'true',
        args: [],
        env: {},
        cwd: isolation.rootDir,
        isolation,
        cell,
        runtimeVersion: null,
        credentialValuesToRedact: [],
      }),
      execute: async () => {
        throw new Error('simulated execute failure');
      },
      normalize: async () => ({
        runtime: { id: 'fake-throw-runtime', version: null },
        model: { requested: '', resolved: null },
        execution: { exitCode: null, signal: null, durationMs: 0 },
        usage: {},
      }),
    };

    const runsDir = join(workDir, 'runs');

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
      }),
    ).rejects.toThrow('simulated execute failure');

    // Runs dir may exist (created by createUniqueRunLayout) but must be empty.
    const entries = await readdir(runsDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });
});
