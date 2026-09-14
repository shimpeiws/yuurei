import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeOpenCodeApiKeys, bridgeOpenCodeAuthFile } from './auth.js';

describe('bridgeOpenCodeApiKeys', () => {
  const keys = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'UNRELATED_SECRET'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('forwards allowlisted provider keys and returns their values to redact', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-value';
    process.env['OPENROUTER_API_KEY'] = 'sk-or-value';
    process.env['UNRELATED_SECRET'] = 'nope';

    const env: Record<string, string> = {};
    const redact = bridgeOpenCodeApiKeys(env);

    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-value', OPENROUTER_API_KEY: 'sk-or-value' });
    expect(env['UNRELATED_SECRET']).toBeUndefined();
    expect(redact).toEqual(expect.arrayContaining(['sk-ant-value', 'sk-or-value']));
  });

  it('forwards nothing when no allowlisted key is set', () => {
    expect(bridgeOpenCodeApiKeys({})).toEqual([]);
  });
});

describe('bridgeOpenCodeAuthFile', () => {
  let home: string;
  let dataDir: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yuurei-oc-auth-home-'));
    dataDir = await mkdtemp(join(tmpdir(), 'yuurei-oc-auth-data-'));
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  });

  async function writeRealAuth(content: string): Promise<string> {
    const realDir = join(home, '.local', 'share', 'opencode');
    await mkdir(realDir, { recursive: true });
    const path = join(realDir, 'auth.json');
    await writeFile(path, content, 'utf8');
    return path;
  }

  it('copies the real auth.json into the cell at 0600 and extracts its secrets', async () => {
    await writeRealAuth('{"openrouter":{"type":"api","key":"SECRET_KEY"}}\n');

    const secrets = await bridgeOpenCodeAuthFile(dataDir);
    const dest = join(dataDir, 'auth.json');

    expect(await readFile(dest, 'utf8')).toContain('SECRET_KEY');
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
    expect(secrets).toEqual(['SECRET_KEY']);
  });

  it('extracts OAuth token fields as well', async () => {
    await writeRealAuth('{"p":{"type":"oauth","access":"A","refresh":"R"}}\n');
    expect(await bridgeOpenCodeAuthFile(dataDir)).toEqual(expect.arrayContaining(['A', 'R']));
  });

  it('bridges nothing when the real auth.json is absent', async () => {
    expect(await bridgeOpenCodeAuthFile(dataDir)).toEqual([]);
    await expect(readFile(join(dataDir, 'auth.json'), 'utf8')).rejects.toThrow();
  });
});
