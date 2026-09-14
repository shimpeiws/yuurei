import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../cli/exit-codes.js';
import { assertNoOpenCodeFileReferencesEscape } from './config-guard.js';

function config(files: Record<string, string>): Record<string, { content: Buffer; mode: number }> {
  return Object.fromEntries(
    Object.entries(files).map(([key, value]) => [
      key,
      { content: Buffer.from(value), mode: 0o644 },
    ]),
  );
}

describe('assertNoOpenCodeFileReferencesEscape', () => {
  let cellRoot: string;
  let destDir: string;
  let realHome: string;

  beforeEach(async () => {
    cellRoot = await mkdtemp(join(tmpdir(), 'yuurei-oc-guard-cell-'));
    realHome = await mkdtemp(join(tmpdir(), 'yuurei-oc-guard-home-'));
    destDir = join(cellRoot, '.config', 'opencode');
    await mkdir(destDir, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all([
      rm(cellRoot, { recursive: true, force: true }),
      rm(realHome, { recursive: true, force: true }),
    ]);
  });

  it('allows a relative reference that resolves inside the cell', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"instructions":["{file:./notes.md}"]}' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a ~-rooted reference when HOME is outside the cell (level0)', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({
          'opencode.json':
            '{"provider":{"openrouter":{"options":{"apiKey":"{file:~/.local/share/opencode/auth.json}"}}}}',
        }),
        realHome,
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects an absolute reference outside the cell', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': `{"x":"{file:${join(realHome, 'secret')}}"}` }),
        realHome,
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects a relative reference that traverses out of the cell', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x":"{file:../../../../../../etc/hosts}"}' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects an empty {file:} reference', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x":"{file:}"}' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('does not treat {env:...} as a file reference', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"model":"{env:OPENCODE_MODEL}"}' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a literal provider apiKey (it would persist under --keep)', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({
          'opencode.json': '{"provider":{"p":{"options":{"apiKey":"sk-literal-secret"}}}}',
        }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('allows an env-referenced provider apiKey', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({
          'opencode.json': '{"provider":{"p":{"options":{"apiKey":"{env:OPENROUTER_API_KEY}"}}}}',
        }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a {file:} reference hidden behind a JSON \\/ escape', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x":"{file:~\\/.local/share/opencode/auth.json}"}' }),
        realHome,
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects a {file:} reference hidden behind a JSON \\u escape', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x":"{file:\\u007e/.local/share/opencode/auth.json}"}' }),
        realHome,
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects a literal apiKey hidden behind a JSON \\u escape in the key', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"provider":{"p":{"options":{"api\\u004bey":"literal"}}}}' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('refuses a ~ reference when HOME is not set in the environment', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x":"{file:~/.local/share/opencode/auth.json}"}' }),
        null,
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('allows an in-cell relative reference when HOME is not set', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x":"{file:./notes.md}"}' }),
        null,
        cellRoot,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects an unsupported ~user reference', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x":"{file:~root/secret}"}' }),
        realHome,
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('accepts JSONC with comments and trailing commas when references stay in-cell', async () => {
    const jsonc = '{ // provider config\n  "x": "{file:./notes.md}",\n}\n';
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.jsonc': jsonc }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a JSON config that does not parse (fail closed)', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x": "unterminated' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('treats a CR-only line comment as a comment terminator (no bypass)', async () => {
    const jsonc = `{\n// comment\r"x":"{file:${join(realHome, 'secret')}"}\n}\n`;
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.jsonc': jsonc }),
        realHome,
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects an unterminated block comment (fail closed)', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.jsonc': '{"x":1} /*' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects a substitution with a literal prefix/suffix', async () => {
    for (const value of [
      '{env:SAFE}literal-secret',
      '{file:./key}literal-secret',
      'Bearer {env:X}',
    ]) {
      await expect(
        assertNoOpenCodeFileReferencesEscape(
          destDir,
          config({ 'opencode.json': `{"provider":{"p":{"options":{"apiKey":"${value}"}}}}` }),
          join(cellRoot, 'home'),
          cellRoot,
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    }
  });

  it('allows a single in-cell {file:...} apiKey reference', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"provider":{"p":{"options":{"apiKey":"{file:./key}"}}}}' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects surrounding whitespace and empty env names in apiKey', async () => {
    for (const value of [' {env:X} ', '{env: }', '{file: }']) {
      await expect(
        assertNoOpenCodeFileReferencesEscape(
          destDir,
          config({ 'opencode.json': `{"apiKey":"${value}"}` }),
          join(cellRoot, 'home'),
          cellRoot,
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    }
  });

  it('rejects duplicate apiKey keys hiding a literal behind a substitution', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({
          'opencode.json': '{"apiKey":"literal-secret","apiKey":"{env:SAFE}"}',
        }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects duplicate keys even when one is escape-encoded', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({
          'opencode.json': '{"api\\u004bey":"literal-secret","apiKey":"{env:SAFE}"}',
        }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects a non-string apiKey value regardless of type', async () => {
    for (const value of ['{"secret":"literal"}', '123', 'null', '["a"]', 'true']) {
      await expect(
        assertNoOpenCodeFileReferencesEscape(
          destDir,
          config({ 'opencode.json': `{"provider":{"p":{"options":{"apiKey":${value}}}}}` }),
          join(cellRoot, 'home'),
          cellRoot,
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    }
  });

  it('rejects an empty literal apiKey (only substitution forms are accepted)', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"provider":{"p":{"options":{"apiKey":""}}}}' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects an unescaped control character in a JSON string', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'opencode.json': '{"x":"a\u0000b"}' }),
        join(cellRoot, 'home'),
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('still scans non-JSON config as raw text', async () => {
    await expect(
      assertNoOpenCodeFileReferencesEscape(
        destDir,
        config({ 'agents/x.md': `key: {file:${join(realHome, 'secret')}}\n` }),
        realHome,
        cellRoot,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });
});
