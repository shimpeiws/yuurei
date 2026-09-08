import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, YuureiError } from '../../src/cli/exit-codes.js';
import { runPipeline } from '../../src/run/pipeline.js';
import { pathExists } from '../../src/util/fs.js';
import type { ResolvedProfile } from '../../src/profile/types.js';
import type { IsolationContext } from '../../src/isolation/types.js';
import type { PreparedRun, Runtime } from '../../src/runtime/types.js';
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
      content: { profileYaml: { runtime: 'not-a-real-runtime' }, configFiles: {} },
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
      content: { profileYaml: { runtime: 'fake-cred-runtime' }, configFiles: {} },
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
          credentialFilePaths: [credentialPath],
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
        runtime: { id: 'fake-cred-runtime', version: null },
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
});
