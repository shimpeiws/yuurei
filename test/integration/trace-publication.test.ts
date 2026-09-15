import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPipeline } from '../../src/run/pipeline.js';
import { readTrace } from '../../src/trace/reader.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import type { ArtifactManifest } from '../../src/artifact/types.js';
import type { ResolvedProfile } from '../../src/profile/types.js';
import type { IsolationContext } from '../../src/isolation/types.js';
import type { NormalizationContext, PreparedRun, Runtime } from '../../src/runtime/types.js';
import type { ResolvedCell } from '../../src/cell/types.js';

/**
 * Fault injection for the persistence-failure tests: the test sets
 * `writeFileFailOn` to path substrings that should make `writeFile` throw.
 * Keyed on the durable run directory (`runs/<id>/...`) rather than on the
 * isolation root, so the fake runtime's own log writes inside the cell are
 * unaffected. Trace-publication tests inject exactly which persistence point
 * fails and assert nothing is left that `yuurei trace show` could consume.
 */
const fault = vi.hoisted(() => ({ writeFileFailOn: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      const path = String(args[0]);
      if (fault.writeFileFailOn.some((substring) => path.includes(substring))) {
        throw Object.assign(new Error('injected writeFile failure'), { code: 'EIO' });
      }
      return actual.writeFile(...args);
    }),
  };
});

/** Fake runtime whose execute() writes a small stdout log and returns 0. */
function makeTrivialRuntime(id: string): Runtime {
  return {
    id: () => id,
    detect: async () => ({
      installed: true,
      version: null,
      executablePath: null,
      authUsable: null,
    }),
    prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
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
      await writeFile(stdoutPath, 'hello from the fixture runtime\n', 'utf8');
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
      runtime: { id, version: context.runtimeVersion },
      model: { requested: '', resolved: null },
      execution: { exitCode: 0, signal: null, durationMs: 0 },
      usage: {},
    }),
  };
}

function makeProfile(runtime: string): ResolvedProfile {
  return {
    name: 'trace-publication',
    runtime,
    content: { profileYaml: { runtime }, configFiles: {} },
    digest: 'sha256:0000',
  };
}

describe('trace publication', () => {
  let workDir: string;
  let taskPath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-trace-pub-'));
    taskPath = join(workDir, 'task.md');
    await writeFile(taskPath, '# Task\n', 'utf8');
    fault.writeFileFailOn = [];
  });

  afterEach(async () => {
    fault.writeFileFailOn = [];
    await rm(workDir, { recursive: true, force: true });
  });

  it('lists the actual artifacts in the trace, consistent with artifacts.json', async () => {
    const profile = makeProfile('fake-trace-runtime');
    const result = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      resolveRuntime: () => makeTrivialRuntime('fake-trace-runtime'),
    });

    const trace = await readTrace(result.runDir);
    const manifest = JSON.parse(
      await readFile(join(result.runDir, 'artifacts.json'), 'utf8'),
    ) as ArtifactManifest;

    const expected = manifest.artifacts.map(({ path, kind }) => ({ path, kind }));
    expect(trace.artifacts).toEqual(expected);
    expect(trace.artifacts).toContainEqual({ path: 'stdout.log', kind: 'log' });
  });

  it('records the yuurei version as observed, without hashing it into the digest', async () => {
    const profile = makeProfile('fake-version-runtime');
    const base = {
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiDir: workDir,
      isolationStrategy: 'level1' as const,
      keep: false,
      resolveRuntime: () => makeTrivialRuntime('fake-version-runtime'),
    };

    const first = await runPipeline({ ...base, yuureiVersion: '0.0.1' });
    const second = await runPipeline({ ...base, yuureiVersion: '9.9.9' });

    expect(first.trace.yuurei_version).toBe('0.0.1');
    expect(second.trace.yuurei_version).toBe('9.9.9');
    // ADR-0011: the version is an observation, not a digest input.
    expect(second.trace.requested_cell?.digest).toBe(first.trace.requested_cell?.digest);
  });

  it('records the execution contracts and the digest input-set version', async () => {
    const profile = makeProfile('fake-contracts-runtime');
    const result = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: 'sonnet',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      timeoutMs: 5000,
      executionOptions: { bridge_codex_auth_file: false },
      definition: { run: 'smoke', cli_overrides: [] },
      resolveRuntime: () => makeTrivialRuntime('fake-contracts-runtime'),
    });

    expect(result.trace.execution_options).toEqual({
      timeout_ms: 5000,
      runtime: { bridge_codex_auth_file: false },
    });
    expect(result.trace.definition).toEqual({ run: 'smoke', cli_overrides: [] });
    expect(result.trace.requested_cell).toEqual({
      digest: result.cell.requestedCellDigest,
      inputs_version: 1,
    });
  });

  it('normalizes an unspecified timeout and an explicit null to one digest', async () => {
    const profile = makeProfile('fake-normalize-runtime');
    const base = {
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1' as const,
      keep: false,
      resolveRuntime: () => makeTrivialRuntime('fake-normalize-runtime'),
    };

    const unspecified = await runPipeline({ ...base, timeoutMs: undefined });
    const explicitNull = await runPipeline({ ...base, timeoutMs: null });

    expect(unspecified.trace.requested_cell?.digest).toBe(
      explicitNull.trace.requested_cell?.digest,
    );
  });

  it.each([
    ['the resolved-profile write', 'resolved-profile.json'],
    ['a durable log write', join('runs', '')],
    ['the artifact manifest write', 'artifacts.json'],
  ])('leaves no consumable run when %s fails', async (_label, failOn) => {
    fault.writeFileFailOn = [failOn];
    const profile = makeProfile('fake-fail-runtime');

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
        resolveRuntime: () => makeTrivialRuntime('fake-fail-runtime'),
      }),
    ).rejects.toThrow(/injected writeFile failure/);
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
        resolveRuntime: () => makeTrivialRuntime(profile.runtime),
      }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.TRACE_OR_ARTIFACT_SAVE_FAILED });

    // trace.json is the completion marker and is written last; a failure in
    // any earlier persistence step must not leave a run that `trace show`
    // could consume.
    const runsDir = join(workDir, 'runs');
    const entries = await readdir(runsDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it('leaves no consumable run when the trace write itself fails', async () => {
    fault.writeFileFailOn = ['trace.json'];
    const profile = makeProfile('fake-trace-fail-runtime');

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
        resolveRuntime: () => makeTrivialRuntime('fake-trace-fail-runtime'),
      }),
    ).rejects.toThrow(/injected writeFile failure/);
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
        resolveRuntime: () => makeTrivialRuntime(profile.runtime),
      }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.TRACE_OR_ARTIFACT_SAVE_FAILED });

    const runsDir = join(workDir, 'runs');
    const entries = await readdir(runsDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });
});
