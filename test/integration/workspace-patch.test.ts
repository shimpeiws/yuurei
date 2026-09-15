import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPipeline } from '../../src/run/pipeline.js';
import type { ResolvedProfile } from '../../src/profile/types.js';
import type { IsolationContext } from '../../src/isolation/types.js';
import type { PreparedRun, Runtime } from '../../src/runtime/types.js';
import type { ResolvedCell } from '../../src/cell/types.js';

/** A runtime that writes `files` into the cell workspace, then succeeds. */
function makeWorkspaceRuntime(id: string, files: Record<string, string>): Runtime {
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
      cwd: isolation.workspaceDir,
      isolation,
      cell,
      runtimeVersion: null,
      credentialValuesToRedact: [],
    }),
    execute: async (run: PreparedRun) => {
      for (const [relative, content] of Object.entries(files)) {
        const path = join(run.isolation.workspaceDir, relative);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, 'utf8');
      }
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

function makeProfile(runtime: string): ResolvedProfile {
  return {
    name: 'workspace-patch',
    runtime,
    content: { profileYaml: { runtime }, configFiles: {} },
    digest: 'sha256:0000',
  };
}

describe('run pipeline workspace and patch', () => {
  let workDir: string;
  let taskPath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-ws-pipeline-'));
    taskPath = join(workDir, 'task.md');
    await writeFile(taskPath, '# Task\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function run(runtime: Runtime): ReturnType<typeof runPipeline> {
    const profile = makeProfile(runtime.id());
    return runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      resolveRuntime: () => runtime,
    });
  }

  it('copies the agent workspace and records it as patch.diff', async () => {
    const result = await run(makeWorkspaceRuntime('fake-ws', { 'src/hello.txt': 'hi\n' }));

    expect(await readFile(join(result.runDir, 'workspace', 'src', 'hello.txt'), 'utf8')).toBe(
      'hi\n',
    );
    const patch = await readFile(join(result.runDir, 'patch.diff'), 'utf8');
    expect(patch).toContain('--- /dev/null\n+++ src/hello.txt\n');
    expect(patch).toContain('+hi\n');

    const manifest = JSON.parse(await readFile(join(result.runDir, 'artifacts.json'), 'utf8')) as {
      artifacts: { path: string; kind: string }[];
    };
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({ path: 'patch.diff', kind: 'patch' }),
    );
    expect(result.trace.artifacts).toContainEqual({ path: 'patch.diff', kind: 'patch' });
  });

  it('writes an empty patch.diff when the agent produced no files', async () => {
    const result = await run(makeWorkspaceRuntime('fake-empty-ws', {}));

    expect(await readFile(join(result.runDir, 'patch.diff'), 'utf8')).toBe('');
    const manifest = JSON.parse(await readFile(join(result.runDir, 'artifacts.json'), 'utf8')) as {
      artifacts: { path: string; kind: string }[];
    };
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({ path: 'patch.diff', kind: 'patch' }),
    );
  });
});
