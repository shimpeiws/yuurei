import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { createVerifiedIsolation } from '../../src/isolation/index.js';
import { Level1Isolation } from '../../src/isolation/level1.js';
import { loadProfile } from '../../src/profile/loader.js';
import { ClaudeCodeRuntime } from '../../src/runtime/claude-code/index.js';
import { CodexRuntime } from '../../src/runtime/codex/index.js';
import { writeFileTree } from '../../src/util/fs.js';
import type { ResolvedCell } from '../../src/cell/types.js';
import type { ProfileContent } from '../../src/profile/types.js';

function makeCell(
  configFiles: Record<string, { content: Buffer; mode: number }>,
  runtimeExecutionOptions: Record<string, unknown> = {},
): ResolvedCell {
  const content: ProfileContent = { profileYaml: { runtime: 'claude-code' }, configFiles };
  return {
    runtimeId: 'claude-code',
    requestedModel: '',
    resolvedProfile: { name: 'test', content, digest: 'sha256:test' },
    resolvedTask: { source: 'task.md', content: '# Task\n', digest: 'sha256:task' },
    yuureiVersion: '0.0.1',
    executionOptions: { timeout_ms: null, runtime: runtimeExecutionOptions },
    isolationStrategy: 'level1',
    requestedCellDigest: 'sha256:cell',
  };
}

describe('profile materialization', () => {
  let workDir: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-mat-test-'));
    // Override HOME so bridgeCodexCredentials doesn't read the real ~/.codex/auth.json.
    realHome = process.env['HOME'];
    process.env['HOME'] = workDir;
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
    await rm(workDir, { recursive: true, force: true });
  });

  // A profile must not be able to supply the file a runtime reads its own
  // credential from: the run would then silently authenticate as whoever wrote
  // the profile rather than as the operator (design doc §9.2). Verified against
  // Claude Code 2.1.267: a well-formed token planted at
  // $CLAUDE_CONFIG_DIR/.credentials.json is read, parsed and sent to the API,
  // and the isolated run reaches no credential of its own to compete with it.
  describe.each([
    {
      runtimeId: 'claude-code',
      reserved: '.credentials.json',
      make: () => new ClaudeCodeRuntime(),
    },
    { runtimeId: 'codex', reserved: 'auth.json', make: () => new CodexRuntime() },
  ])('$runtimeId reserved credential path', ({ runtimeId, reserved, make }) => {
    it.each([
      { label: 'exact', key: reserved },
      { label: 'dot-slash prefixed', key: `./${reserved}` },
      { label: 'traversing but equivalent', key: `sub/../${reserved}` },
      { label: 'upper-cased', key: reserved.toUpperCase() },
    ])('rejects a profile shipping $label', async ({ key }) => {
      const cell: ResolvedCell = {
        ...makeCell({ [key]: { content: Buffer.from('{"stolen":true}'), mode: 0o600 } }),
        runtimeId,
      };
      const isolation = new Level1Isolation();
      const context = await createVerifiedIsolation(isolation, cell);
      try {
        await expect(make().prepare(cell, context, () => {})).rejects.toMatchObject({
          exitCode: EXIT_CODES.CONFIG_ERROR,
        });
      } finally {
        await isolation.dispose(context);
      }
    });
  });

  it('materializes profile config files into the isolated .claude directory', async () => {
    const cell = makeCell({
      'settings.json': { content: Buffer.from('{"from":"profile"}\n'), mode: 0o644 },
      'skills/x/SKILL.md': { content: Buffer.from('# x\n'), mode: 0o644 },
    });

    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      await new ClaudeCodeRuntime().prepare(cell, context, () => {});

      const homeDir = context.homeDir;
      if (!homeDir) throw new Error('level1 isolation must provide homeDir');
      const dest = join(homeDir, '.claude');
      expect(await readFile(join(dest, 'settings.json'), 'utf8')).toBe('{"from":"profile"}\n');
      expect(await readFile(join(dest, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('# x\n');
    } finally {
      await isolation.dispose(context);
    }
  });

  it('rejects a symlink in profile config that escapes the config directory', async () => {
    // Set up a profile directory with a symlink config/escape.md -> /etc/hosts
    const profileDir = join(workDir, 'profile');
    const configDir = join(profileDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: claude-code\n', 'utf8');
    await symlink('/etc/hosts', join(configDir, 'escape.md'));

    const profile = {
      name: 'escape-test',
      runtime: 'claude-code',
      sourceDir: profileDir,
    };

    await expect(loadProfile(profile)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('rejects a dangling symlink in profile config', async () => {
    const profileDir = join(workDir, 'profile2');
    const configDir = join(profileDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: claude-code\n', 'utf8');
    await symlink(join(configDir, 'nonexistent.txt'), join(configDir, 'dangling.md'));

    const profile = {
      name: 'dangling-test',
      runtime: 'claude-code',
      sourceDir: profileDir,
    };

    await expect(loadProfile(profile)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('does NOT bridge ~/.codex/auth.json by default, even when one exists', async () => {
    // The opt-in experimental flag is the only way to reach the file-copy
    // path — this is the regression test for the reviewer-narrowed decision
    // that Codex auth-file bridging must be off by default.
    const realCodexDir = join(workDir, '.codex');
    await mkdir(realCodexDir, { recursive: true });
    await writeFile(join(realCodexDir, 'auth.json'), '{"token":"fake"}\n', 'utf8');

    const cell: ResolvedCell = { ...makeCell({}), runtimeId: 'codex' };
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      const registeredPaths: string[] = [];
      await new CodexRuntime().prepare(cell, context, (path) => registeredPaths.push(path));
      expect(registeredPaths).toEqual([]);

      const homeDir = context.homeDir;
      if (!homeDir) throw new Error('level1 isolation must provide homeDir');
      await expect(readFile(join(homeDir, '.codex', 'auth.json'), 'utf8')).rejects.toThrow();
    } finally {
      await isolation.dispose(context);
    }
  });

  it('bridges a real ~/.codex/auth.json into the isolated CODEX_HOME at mode 0600 when opted in', async () => {
    const realCodexDir = join(workDir, '.codex');
    await mkdir(realCodexDir, { recursive: true });
    const authJson = JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      last_refresh: '2026-09-08T00:00:00Z',
      tokens: {
        access_token: 'fake-access-token-value-long-enough',
        account_id: 'acct_123',
        id_token: 'fake-id-token-value-long-enough',
        refresh_token: 'fake-refresh-token-value-long-enough',
      },
    });
    await writeFile(join(realCodexDir, 'auth.json'), authJson, 'utf8');

    const cell: ResolvedCell = {
      ...makeCell({}, { bridge_codex_auth_file: true }),
      runtimeId: 'codex',
    };
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      const registeredPaths: string[] = [];
      const prepared = await new CodexRuntime().prepare(cell, context, (path) =>
        registeredPaths.push(path),
      );

      const homeDir = context.homeDir;
      if (!homeDir) throw new Error('level1 isolation must provide homeDir');
      const bridgedPath = join(homeDir, '.codex', 'auth.json');
      expect(await readFile(bridgedPath, 'utf8')).toBe(authJson);
      expect((await stat(bridgedPath)).mode & 0o777).toBe(0o600);
      // The path must be registered with the pipeline at write time (#55), so
      // the scrub reaches it even if prepare() never returns.
      expect(registeredPaths).toEqual([bridgedPath]);
      // The OAuth token triple, not just OPENAI_API_KEY, must be reported for
      // log redaction -- these values can never be reached by a redaction
      // pass that only looks at PreparedRun.env's known key names, since
      // they live only inside the bridged file's content.
      expect(prepared.credentialValuesToRedact).toEqual(
        expect.arrayContaining([
          'fake-access-token-value-long-enough',
          'fake-id-token-value-long-enough',
          'fake-refresh-token-value-long-enough',
        ]),
      );
    } finally {
      await isolation.dispose(context);
    }
  });

  it('aborts prepare() when a failed bridge cannot be cleaned up (double fault)', async () => {
    const realCodexDir = join(workDir, '.codex');
    await mkdir(realCodexDir, { recursive: true });
    await writeFile(join(realCodexDir, 'auth.json'), '{"token":"fake"}\n', 'utf8');

    const cell: ResolvedCell = {
      ...makeCell({}, { bridge_codex_auth_file: true }),
      runtimeId: 'codex',
    };
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    const homeDir = context.homeDir;
    if (!homeDir) throw new Error('level1 isolation must provide homeDir');

    // Pre-create the reserved destination path as a NON-EMPTY directory:
    // copyFile() then fails (EISDIR), and the catch block's own cleanup
    // rm(dest, { force: true }) (no `recursive: true`) fails too, on the
    // same non-empty directory -- reproducing the double fault where a
    // failed bridge cannot even clean up after itself.
    const unscrubbableDest = join(homeDir, '.codex', 'auth.json');
    await mkdir(unscrubbableDest, { recursive: true });
    await writeFile(join(unscrubbableDest, 'inner.txt'), 'x', 'utf8');

    try {
      await expect(new CodexRuntime().prepare(cell, context, () => {})).rejects.toMatchObject({
        exitCode: EXIT_CODES.ISOLATION_VERIFICATION_FAILED,
        message: expect.stringContaining(unscrubbableDest),
      });
    } finally {
      await rm(unscrubbableDest, { recursive: true, force: true });
      await isolation.dispose(context);
    }
  });

  it('proceeds without a credential file when opted in but ~/.codex/auth.json does not exist', async () => {
    // workDir has no .codex/ at all — bridging must be a silent no-op, not a failure.
    const cell: ResolvedCell = {
      ...makeCell({}, { bridge_codex_auth_file: true }),
      runtimeId: 'codex',
    };
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      const registeredPaths: string[] = [];
      const prepared = await new CodexRuntime().prepare(cell, context, (path) =>
        registeredPaths.push(path),
      );
      expect(prepared.command).toBe('codex');
      // Registration happens before the copy (#55), so the destination is on
      // the scrub list even when the bridge no-ops on a missing source — a
      // path the copy never reaches is a harmless no-op for the scrub.
      const homeDir = context.homeDir;
      if (!homeDir) throw new Error('level1 isolation must provide homeDir');
      expect(registeredPaths).toEqual([join(homeDir, '.codex', 'auth.json')]);
      await expect(readFile(join(homeDir, '.codex', 'auth.json'), 'utf8')).rejects.toThrow();
    } finally {
      await isolation.dispose(context);
    }
  });

  it('forwards OPENAI_API_KEY under both names into the isolated env (no file written)', async () => {
    const realApiKey = process.env['OPENAI_API_KEY'];
    const realCodexKey = process.env['CODEX_API_KEY'];
    delete process.env['CODEX_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test-forwarded';
    try {
      const cell: ResolvedCell = { ...makeCell({}), runtimeId: 'codex' };
      const isolation = new Level1Isolation();
      const context = await createVerifiedIsolation(isolation, cell);
      try {
        const registeredPaths: string[] = [];
        const prepared = await new CodexRuntime().prepare(cell, context, (path) =>
          registeredPaths.push(path),
        );
        // `codex exec` reads CODEX_API_KEY; OPENAI_API_KEY is kept for the
        // login flow and older releases.
        expect(prepared.env['CODEX_API_KEY']).toBe('sk-test-forwarded');
        expect(prepared.env['OPENAI_API_KEY']).toBe('sk-test-forwarded');
        expect(registeredPaths).toEqual([]);
      } finally {
        await isolation.dispose(context);
      }
    } finally {
      if (realApiKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = realApiKey;
      if (realCodexKey === undefined) delete process.env['CODEX_API_KEY'];
      else process.env['CODEX_API_KEY'] = realCodexKey;
    }
  });

  it('forwards CODEX_API_KEY alone as well', async () => {
    const realApiKey = process.env['OPENAI_API_KEY'];
    const realCodexKey = process.env['CODEX_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    process.env['CODEX_API_KEY'] = 'sk-codex-only';
    try {
      const cell: ResolvedCell = { ...makeCell({}), runtimeId: 'codex' };
      const isolation = new Level1Isolation();
      const context = await createVerifiedIsolation(isolation, cell);
      try {
        const prepared = await new CodexRuntime().prepare(cell, context, () => {});
        expect(prepared.env['CODEX_API_KEY']).toBe('sk-codex-only');
        expect(prepared.env['OPENAI_API_KEY']).toBe('sk-codex-only');
      } finally {
        await isolation.dispose(context);
      }
    } finally {
      if (realApiKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = realApiKey;
      if (realCodexKey === undefined) delete process.env['CODEX_API_KEY'];
      else process.env['CODEX_API_KEY'] = realCodexKey;
    }
  });

  it('falls back to OPENAI_API_KEY when CODEX_API_KEY is present but empty', async () => {
    const realApiKey = process.env['OPENAI_API_KEY'];
    const realCodexKey = process.env['CODEX_API_KEY'];
    // A CI env table often defines the variable with an unset secret, so an
    // empty CODEX_API_KEY must not mask a valid OPENAI_API_KEY.
    process.env['CODEX_API_KEY'] = '';
    process.env['OPENAI_API_KEY'] = 'sk-from-openai';
    try {
      const cell: ResolvedCell = { ...makeCell({}), runtimeId: 'codex' };
      const isolation = new Level1Isolation();
      const context = await createVerifiedIsolation(isolation, cell);
      try {
        const prepared = await new CodexRuntime().prepare(cell, context, () => {});
        expect(prepared.env['CODEX_API_KEY']).toBe('sk-from-openai');
        expect(prepared.env['OPENAI_API_KEY']).toBe('sk-from-openai');
      } finally {
        await isolation.dispose(context);
      }
    } finally {
      if (realApiKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = realApiKey;
      if (realCodexKey === undefined) delete process.env['CODEX_API_KEY'];
      else process.env['CODEX_API_KEY'] = realCodexKey;
    }
  });

  it('writeFileTree refuses a key that escapes the destination directory', async () => {
    const destDir = join(workDir, 'dest');
    await mkdir(destDir, { recursive: true });

    await expect(writeFileTree(destDir, { '../escaped.txt': 'pwned\n' })).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
    await expect(readFile(join(workDir, 'escaped.txt'), 'utf8')).rejects.toThrow();
  });

  it('materializes two symlinks that both point at the same real subdirectory', async () => {
    // Not a cycle: aaa and zzz are siblings, neither is an ancestor of the other,
    // so both must be walked even though they resolve to the same real dir.
    const profileDir = join(workDir, 'profile3');
    const configDir = join(profileDir, 'config');
    const realDir = join(configDir, 'real');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: claude-code\n', 'utf8');
    await writeFile(join(realDir, 'f.md'), '# f\n', 'utf8');
    await symlink(realDir, join(configDir, 'aaa'));
    await symlink(realDir, join(configDir, 'zzz'));

    const profile = { name: 'siblings-test', runtime: 'claude-code', sourceDir: profileDir };
    const resolved = await loadProfile(profile);

    expect(Object.keys(resolved.content.configFiles).sort()).toEqual([
      'aaa/f.md',
      'real/f.md',
      'zzz/f.md',
    ]);
  });

  it('rejects a profile-supplied auth.json instead of letting it survive a failed bridge', async () => {
    // No ~/.codex/auth.json on the real side (workDir has no .codex/), so if the
    // reservation guard weren't there, a profile-supplied auth.json would land
    // untouched by a bridge that legitimately no-ops on a missing source.
    const cell: ResolvedCell = {
      ...makeCell({
        'auth.json': { content: Buffer.from('{"token":"attacker-controlled"}\n'), mode: 0o644 },
      }),
      runtimeId: 'codex',
    };
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      await expect(new CodexRuntime().prepare(cell, context, () => {})).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    } finally {
      await isolation.dispose(context);
    }
  });

  it('rejects a symlink that forms a real cycle', async () => {
    const profileDir = join(workDir, 'profile4');
    const configDir = join(profileDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: claude-code\n', 'utf8');
    await symlink(configDir, join(configDir, 'self'));

    const profile = { name: 'cycle-test', runtime: 'claude-code', sourceDir: profileDir };
    await expect(loadProfile(profile)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });
});
