import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRuntime } from '../../src/runtime/claude-code/index.js';
import { CodexRuntime } from '../../src/runtime/codex/index.js';
import { execCapture } from '../../src/runtime/exec.js';
import type { Runtime, PreparedRun, NormalizedTraceFragment } from '../../src/runtime/types.js';
import type { ResolvedCell } from '../../src/cell/types.js';
import type { IsolationContext } from '../../src/isolation/types.js';
import { configRootOf } from '../../src/isolation/config-root.js';
import { Level0Isolation } from '../../src/isolation/level0.js';
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

function profileWithConfigFiles(
  configFiles: Record<string, { content: Buffer; mode: number }> = {},
): {
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

describe('level0 isolation', () => {
  it('configRootOf() resolves to rootDir, not a homeDir, unlike level1', async () => {
    const isolation = new Level0Isolation();
    const context = await isolation.create({} as ResolvedCell);
    try {
      expect(context.homeDir).toBeNull();
      expect(configRootOf(context)).toBe(context.rootDir);
    } finally {
      await isolation.dispose(context);
    }
  });

  it('preserves the real HOME in-process, unlike level1 (design doc §9.3: config-root swap only)', async () => {
    const realHome = process.env['HOME'];
    if (realHome === undefined) {
      throw new Error('test requires process.env.HOME to be set');
    }

    const isolation = new Level0Isolation();
    const context = await isolation.create({} as ResolvedCell);
    try {
      expect(context.env['HOME']).toBe(realHome);
      const report = await isolation.verify(context);
      expect(report.verified).toBe(true);
    } finally {
      await isolation.dispose(context);
    }
  });

  it('actually hands the real HOME to a spawned child process, not just the in-memory env object', async () => {
    // The unit-level assertion above only proves context.env carries HOME —
    // it does not prove a real OS child process launched with that env
    // object actually receives it. Spawn one for real via execCapture, the
    // same primitive runtime adapters use to launch claude/codex, to close
    // that gap.
    const realHome = process.env['HOME'];
    if (realHome === undefined) {
      throw new Error('test requires process.env.HOME to be set');
    }

    const isolation = new Level0Isolation();
    const context = await isolation.create({} as ResolvedCell);
    const stdoutPath = join(context.rootDir, 'stdout.log');
    const stderrPath = join(context.rootDir, 'stderr.log');
    try {
      await execCapture({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.HOME || "")'],
        env: context.env,
        cwd: context.rootDir,
        stdoutPath,
        stderrPath,
      });
      expect(await readFile(stdoutPath, 'utf8')).toBe(realHome);
    } finally {
      await isolation.dispose(context);
    }
  });

  describe('global config untouched under level0', () => {
    let globalHome: string;
    let workDir: string;
    let taskPath: string;
    let realHome: string | undefined;

    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'yuurei-level0-test-'));
      taskPath = join(workDir, 'task.md');
      await writeFile(taskPath, '# Task\n\nDo nothing.\n', 'utf8');

      // Same rationale as the level1 "global config untouched" test: point
      // process.env.HOME at a fixture so the assertions below prove
      // something rather than passing vacuously.
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

    it('points CLAUDE_CONFIG_DIR under rootDir and never touches the real ~/.claude', async () => {
      const sentinel = join(globalHome, '.claude', 'settings.json');
      await mkdir(dirname(sentinel), { recursive: true });
      await writeFile(sentinel, '{"sentinel":true}\n', 'utf8');
      const before = await stat(sentinel);

      let observed: PreparedRun | undefined;

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
        profile: profileWithConfigFiles({
          'settings.json': { content: Buffer.from('{"from":"profile"}\n'), mode: 0o644 },
        }),
        taskPath,
        yuureiVersion: '0.0.1',
        yuureiDir: workDir,
        isolationStrategy: 'level0',
        keep: false,
        resolveRuntime: () => fake,
      });

      const after = await stat(sentinel);
      expect(await readFile(sentinel, 'utf8')).toBe('{"sentinel":true}\n');
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(before.size);

      if (!observed) throw new Error('fake runtime prepare() was never called');

      // level0 has no homeDir: CLAUDE_CONFIG_DIR must be swapped to a path
      // under rootDir instead (design doc §9.3), never left pointing at the
      // real ~/.claude that HOME still resolves to. HOME itself is
      // deliberately left as the real value under level0 (unlike level1) —
      // see Level0Isolation's doc comment — so it is the one env value
      // expected to still point at globalHome here.
      expect(observed.isolation.homeDir).toBeNull();
      expect(observed.env['HOME']).toBe(globalHome);
      expect(observed.env['CLAUDE_CONFIG_DIR']).toBe(join(observed.isolation.rootDir, '.claude'));
      expect(observed.env['CLAUDE_CONFIG_DIR']).not.toBe(join(globalHome, '.claude'));
      for (const [key, value] of Object.entries(observed.env)) {
        if (key === 'HOME') continue;
        expect(value.startsWith(globalHome)).toBe(false);
      }

      expect(await pathExists(observed.isolation.rootDir)).toBe(false);
      expect(result.trace.isolation.verified).toBe(true);
    });

    it('points CODEX_HOME under rootDir and never touches the real ~/.codex', async () => {
      let observed: PreparedRun | undefined;

      const fake: Runtime = {
        id: () => 'fake',
        detect: async () => ({
          installed: true,
          version: null,
          executablePath: null,
          authUsable: null,
        }),
        prepare: async (cell: ResolvedCell, isolation: IsolationContext) => {
          observed = await new CodexRuntime().prepare(cell, isolation);
          return observed;
        },
        execute: async (run: PreparedRun) => {
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

      await runPipeline({
        runtimeId: 'fake',
        requestedModel: '',
        profile: profileWithConfigFiles({}),
        taskPath,
        yuureiVersion: '0.0.1',
        yuureiDir: workDir,
        isolationStrategy: 'level0',
        keep: false,
        resolveRuntime: () => fake,
      });

      if (!observed) throw new Error('fake runtime prepare() was never called');

      expect(observed.isolation.homeDir).toBeNull();
      expect(observed.env['CODEX_HOME']).toBe(join(observed.isolation.rootDir, '.codex'));
      expect(observed.env['CODEX_HOME']).not.toBe(join(globalHome, '.codex'));
      expect(await pathExists(join(globalHome, '.codex'))).toBe(false);
    });
  });
});
