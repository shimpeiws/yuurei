import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRuntime } from '../../src/runtime/claude-code/index.js';
import type { Runtime, PreparedRun, NormalizedTraceFragment } from '../../src/runtime/types.js';
import type { ResolvedCell } from '../../src/cell/types.js';
import type { IsolationContext } from '../../src/isolation/types.js';
import { runPipeline } from '../../src/run/pipeline.js';
import { pathExists } from '../../src/util/fs.js';
import type { ProfileContent } from '../../src/profile/types.js';

const NOW = new Date().toISOString();

const FRAGMENT: NormalizedTraceFragment = {
  runtime: { id: 'fake', version: null },
  model: { requested: '', resolved: null },
  execution: { exitCode: 0, durationMs: 0 },
  usage: {},
};

function profileWithConfigFiles(configFiles: Record<string, string>): {
  name: string;
  runtime: string;
  content: ProfileContent;
  digest: string;
} {
  return {
    name: 'test-profile',
    runtime: 'fake',
    content: { profileYaml: { runtime: 'fake' }, configFiles },
    digest: 'sha256:test',
  };
}

describe('global config untouched', () => {
  let globalHome: string;
  let workDir: string;
  let taskPath: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-pipeline-test-'));
    taskPath = join(workDir, 'task.md');
    await writeFile(taskPath, '# Task\n\nDo nothing.\n', 'utf8');

    // The fixture stands in for the operator's real global config root, and
    // process.env.HOME is pointed at it for the duration of the test. That is
    // what gives the assertions power: the code under test locates the *real*
    // home via process.env.HOME (bridgeCodexCredentials does exactly this), so
    // without the override the test proves nothing — and a Codex variant of it
    // would read the developer's actual ~/.codex/auth.json.
    globalHome = await mkdtemp(join(tmpdir(), 'yuurei-fake-global-home-'));
    realHome = process.env['HOME'];
    process.env['HOME'] = globalHome;
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
    await rm(workDir, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
  });

  it('leaves a global-config-shaped directory byte-, mtime-, and inode-identical', async () => {
    const sentinel = join(globalHome, '.claude', 'settings.json');
    await mkdir(dirname(sentinel), { recursive: true });
    await writeFile(sentinel, '{"sentinel":true}\n', 'utf8');
    const before = await stat(sentinel);

    let observed: PreparedRun | undefined;
    let materialized: string | undefined;

    // Only execute/normalize are faked. prepare() is delegated to the REAL
    // adapter, because prepare() spawns nothing — so materialization and
    // credential bridging actually run inside the pipeline and the sentinel
    // assertions below are a real regression guard rather than a tautology.
    const fake: Runtime = {
      id: () => 'fake',
      detect: async () => ({
        installed: true,
        version: null,
        executablePath: null,
        authUsable: null,
      }),
      prepare: async (cell: ResolvedCell, isolation: IsolationContext) => {
        observed = await new ClaudeCodeRuntime().prepare(cell, isolation);
        return observed;
      },
      execute: async (run: PreparedRun) => {
        // Read the materialized profile HERE, while the isolation is still alive:
        // runPipeline() disposes rootDir in its finally block before returning.
        const homeDir = run.isolation.homeDir;
        if (!homeDir) throw new Error('level1 isolation must provide homeDir');
        materialized = await readFile(join(homeDir, '.claude', 'settings.json'), 'utf8');

        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: 0,
          signal: null,
          startedAt: NOW,
          finishedAt: NOW,
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: async () => FRAGMENT,
    };

    const result = await runPipeline({
      runtimeId: 'fake',
      requestedModel: '',
      profile: profileWithConfigFiles({ 'settings.json': '{"from":"profile"}\n' }),
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      resolveRuntime: () => fake,
    });

    const after = await stat(sentinel);
    expect(await readFile(sentinel, 'utf8')).toBe('{"sentinel":true}\n');
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);

    // The profile really was materialized during this run — otherwise the
    // sentinel assertions above would pass for the trivial reason that nothing ran.
    expect(materialized).toBe('{"from":"profile"}\n');

    // The isolated HOME was never the fixture, and no env value points into it.
    expect(observed?.env['HOME']).not.toBe(globalHome);
    expect(observed?.isolation.homeDir).toMatch(/^\/.*yuurei-/);
    for (const value of Object.values(observed?.env ?? {})) {
      expect(value.startsWith(globalHome)).toBe(false);
    }

    // dispose() ran: no orphaned temp area (design doc §15, last bullet).
    if (!observed) throw new Error('fake runtime prepare() was never called');
    expect(await pathExists(observed.isolation.rootDir)).toBe(false);
    expect(result.trace.isolation.verified).toBe(true);
  });
});
