import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { createVerifiedIsolation } from '../../src/isolation/index.js';
import { Level0Isolation } from '../../src/isolation/level0.js';
import { Level1Isolation } from '../../src/isolation/level1.js';
import { runPipeline } from '../../src/run/pipeline.js';
import { OpenCodeRuntime } from '../../src/runtime/opencode/index.js';
import { openCodeConfigDir, openCodeDataDir } from '../../src/runtime/opencode/paths.js';
import { pathExists } from '../../src/util/fs.js';
import type { ResolvedCell } from '../../src/cell/types.js';
import type { Isolation, IsolationContext } from '../../src/isolation/types.js';
import type { ProfileContent } from '../../src/profile/types.js';
import type { PreparedRun, Runtime, RuntimeResult } from '../../src/runtime/types.js';

function makeCell(
  configFiles: Record<string, { content: Buffer; mode: number }> = {},
  runtimeExecutionOptions: Record<string, unknown> = {},
): ResolvedCell {
  const content: ProfileContent = { profileYaml: { runtime: 'opencode' }, configFiles };
  return {
    runtimeId: 'opencode',
    requestedModel: '',
    resolvedProfile: { name: 'test', content, digest: 'sha256:test' },
    resolvedTask: { source: 'task.md', content: '# Task\n', digest: 'sha256:task' },
    yuureiVersion: '0.0.1',
    executionOptions: { timeout_ms: null, runtime: runtimeExecutionOptions },
    isolationStrategy: 'level1',
    requestedCellDigest: 'sha256:cell',
  };
}

function isolatedHome(context: { homeDir: string | null }): string {
  if (!context.homeDir) throw new Error('level1 isolation must provide homeDir');
  return context.homeDir;
}

describe('OpenCode profile materialization', () => {
  let workDir: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-oc-mat-test-'));
    realHome = process.env['HOME'];
    process.env['HOME'] = workDir;
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
    await rm(workDir, { recursive: true, force: true });
  });

  it('materializes profile config into the isolated OpenCode config dir', async () => {
    const cell = makeCell({
      'opencode.json': { content: Buffer.from('{"username":"profile"}\n'), mode: 0o644 },
      'commands/deploy.md': { content: Buffer.from('# deploy\n'), mode: 0o644 },
    });
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      const prepared = await new OpenCodeRuntime().prepare(cell, context, () => {});

      const configDir = openCodeConfigDir(isolatedHome(context));
      expect(await readFile(join(configDir, 'opencode.json'), 'utf8')).toBe(
        '{"username":"profile"}\n',
      );
      expect(await readFile(join(configDir, 'commands', 'deploy.md'), 'utf8')).toBe('# deploy\n');

      // Every OpenCode root is redirected into the cell, including TMPDIR.
      for (const key of [
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'TMPDIR',
      ]) {
        const value = prepared.env[key];
        expect(value).toBeDefined();
        expect(value?.startsWith(context.rootDir)).toBe(true);
      }
      expect(prepared.env['OPENCODE_DISABLE_AUTOUPDATE']).toBe('1');
      expect(prepared.env['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1');
      expect(prepared.env['OPENCODE_DISABLE_EXTERNAL_SKILLS']).toBe('1');
    } finally {
      await isolation.dispose(context);
    }
  });

  it('rejects a profile config that reads a file outside the cell (absolute)', async () => {
    const cell = makeCell({
      'opencode.json': {
        content: Buffer.from('{"provider":{"p":{"options":{"apiKey":"{file:/etc/hosts}"}}}}\n'),
        mode: 0o644,
      },
    });
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      await expect(new OpenCodeRuntime().prepare(cell, context, () => {})).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    } finally {
      await isolation.dispose(context);
    }
  });

  it('rejects a ~-rooted credential reference under level0 (real HOME)', async () => {
    const cell = makeCell({
      'opencode.json': {
        content: Buffer.from(
          '{"provider":{"p":{"options":{"apiKey":"{file:~/.local/share/opencode/auth.json}"}}}}\n',
        ),
        mode: 0o644,
      },
    });
    const isolation = new Level0Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      await expect(new OpenCodeRuntime().prepare(cell, context, () => {})).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    } finally {
      await isolation.dispose(context);
    }
  });

  it('refuses a ~ reference under level0 when HOME is unset', async () => {
    delete process.env['HOME'];
    const cell = makeCell({
      'opencode.json': {
        content: Buffer.from('{"x":"{file:~/.local/share/opencode/auth.json}"}'),
        mode: 0o644,
      },
    });
    const isolation = new Level0Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      await expect(new OpenCodeRuntime().prepare(cell, context, () => {})).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    } finally {
      await isolation.dispose(context);
    }
  });

  it('does not bridge the real auth.json by default, even when one exists', async () => {
    const realDir = join(workDir, '.local', 'share', 'opencode');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'auth.json'), '{"p":{"type":"api","key":"REAL"}}\n', 'utf8');

    const cell = makeCell();
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      await new OpenCodeRuntime().prepare(cell, context, () => {});
      await expect(
        readFile(join(openCodeDataDir(isolatedHome(context)), 'auth.json'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await isolation.dispose(context);
    }
  });

  it('bridges the real auth.json into the cell at 0600 when opted in and registers it', async () => {
    const realDir = join(workDir, '.local', 'share', 'opencode');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'auth.json'), '{"p":{"type":"api","key":"BRIDGED"}}\n', 'utf8');

    const cell = makeCell({}, { bridge_opencode_auth_file: true });
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    const registered: string[] = [];
    try {
      const prepared = await new OpenCodeRuntime().prepare(cell, context, (p) =>
        registered.push(p),
      );
      const dest = join(openCodeDataDir(isolatedHome(context)), 'auth.json');
      expect(registered).toContain(dest);
      expect(await readFile(dest, 'utf8')).toContain('BRIDGED');
      expect((await stat(dest)).mode & 0o777).toBe(0o600);
      expect(prepared.credentialValuesToRedact).toContain('BRIDGED');
    } finally {
      await isolation.dispose(context);
    }
  });

  it('scrubs the bridged auth.json even under --keep', async () => {
    const realDir = join(workDir, '.local', 'share', 'opencode');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'auth.json'), '{"p":{"type":"api","key":"BRIDGED"}}\n', 'utf8');
    await writeFile(join(workDir, 'task.md'), '# Task\n', 'utf8');

    const oc = new OpenCodeRuntime();
    let captured: IsolationContext | undefined;
    const inner = new Level1Isolation();
    const wrapped: Isolation = {
      create: async (cell) => {
        captured = await inner.create(cell);
        return captured;
      },
      verify: (context) => inner.verify(context),
      dispose: (context) => inner.dispose(context),
    };
    const runtime: Runtime = {
      id: () => oc.id(),
      // A fake runtime: the pipeline checks the runtime before running, but this
      // test is about credential scrubbing, not detection.
      detect: async () => ({
        installed: true,
        version: '1.18.30',
        versionSupported: true,
        executablePath: 'opencode',
        authUsable: true,
      }),
      prepare: (cell, context, register) => oc.prepare(cell, context, register),
      execute: async (run: PreparedRun): Promise<RuntimeResult> => {
        const now = new Date().toISOString();
        const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
        const stderrPath = join(run.isolation.rootDir, 'stderr.log');
        await writeFile(stdoutPath, '', 'utf8');
        await writeFile(stderrPath, '', 'utf8');
        return {
          exitCode: 0,
          signal: null,
          startedAt: now,
          finishedAt: now,
          stdoutPath,
          stderrPath,
          timedOut: false,
        };
      },
      normalize: (result, context) => oc.normalize(result, context),
    };

    const profileContent: ProfileContent = {
      profileYaml: { runtime: 'opencode' },
      configFiles: {},
    };
    await runPipeline({
      runtimeId: 'opencode',
      requestedModel: '',
      profile: {
        name: 'p',
        runtime: 'opencode',
        content: profileContent,
        digest: 'sha256:p',
      },
      taskPath: join(workDir, 'task.md'),
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: true,
      executionOptions: { bridge_opencode_auth_file: true },
      resolveRuntime: () => runtime,
      createIsolation: () => wrapped,
    });

    const context = captured;
    if (!context) throw new Error('isolation context was not captured');
    const home = isolatedHome(context);
    // The rest of the isolated home is kept for debugging, but credential
    // material is scrubbed regardless of --keep (§9.2).
    expect(await pathExists(home)).toBe(true);
    expect(await pathExists(join(openCodeDataDir(home), 'auth.json'))).toBe(false);
    await inner.dispose({ ...context, keep: false });
  });
});
