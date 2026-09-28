import { mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import type { IsolationContext } from '../isolation/types.js';
import { stripCredentials, parseEnvelope, normalizeObservationDir, runObserver } from './run.js';

describe('stripCredentials', () => {
  it('removes known credential keys from environment', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_AUTH_TOKEN: 'auth-token-xxx',
      CODEX_API_KEY: 'codex-key-xxx',
      OPENAI_API_KEY: 'openai-key-xxx',
      GOOGLE_API_KEY: 'google-key-xxx',
      GEMINI_API_KEY: 'gemini-key-xxx',
      MISTRAL_API_KEY: 'mistral-key-xxx',
      COHERE_API_KEY: 'cohere-key-xxx',
      AZURE_OPENAI_API_KEY: 'azure-openai-key-xxx',
      AZURE_API_KEY: 'azure-key-xxx',
      AWS_ACCESS_KEY_ID: 'aws-access-key-xxx',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key-xxx',
      CUSTOM_VAR: 'custom-value',
    };

    const stripped = stripCredentials(env);

    expect(stripped.PATH).toBe('/usr/bin:/bin');
    expect(stripped.HOME).toBe('/home/user');
    expect(stripped.CUSTOM_VAR).toBe('custom-value');
    expect(stripped.ANTHROPIC_API_KEY).toBeUndefined();
    expect(stripped.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(stripped.CODEX_API_KEY).toBeUndefined();
    expect(stripped.OPENAI_API_KEY).toBeUndefined();
    expect(stripped.GOOGLE_API_KEY).toBeUndefined();
    expect(stripped.GEMINI_API_KEY).toBeUndefined();
    expect(stripped.MISTRAL_API_KEY).toBeUndefined();
    expect(stripped.COHERE_API_KEY).toBeUndefined();
    expect(stripped.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(stripped.AZURE_API_KEY).toBeUndefined();
    expect(stripped.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(stripped.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('preserves non-credential keys', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      NODE_ENV: 'production',
    };

    const stripped = stripCredentials(env);

    expect(stripped.PATH).toBe('/usr/bin:/bin');
    expect(stripped.HOME).toBe('/home/user');
    expect(stripped.NODE_ENV).toBe('production');
  });

  it('handles empty environment', () => {
    const env = {};
    const stripped = stripCredentials(env);
    expect(stripped).toEqual({});
  });
});

describe('parseEnvelope', () => {
  it('parses a valid pfl inspect envelope', () => {
    const envelope = {
      pflVersion: '1.2.0',
      command: 'inspect',
      ok: true,
      completeness: 'complete',
      diagnostics: [],
      data: {
        runtime: 'claude-code',
        runtimeVersion: '2.1.0',
        runtimeCompatibility: 'verified',
        project: 'test-project',
        store: '/tmp/.pfl',
        observed: {
          snapshotId: 'obs_abc123',
          elements: 10,
          opaqueLayers: 2,
          completeness: 'complete',
          cellId: 'cell_20260928T120000Z-a1b2c3',
        },
        resolved: {
          snapshotId: 'res_def456',
          effective: 8,
          conditional: 1,
          shadowed: 1,
          confidence: 'high',
        },
      },
    };

    const result = parseEnvelope<typeof envelope.data>(JSON.stringify(envelope));

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.pflVersion).toBe('1.2.0');
    expect(result?.completeness).toBe('complete');
    expect(result?.data.observed.snapshotId).toBe('obs_abc123');
    expect(result?.data.resolved.snapshotId).toBe('res_def456');
  });

  it('returns null for invalid JSON', () => {
    expect(parseEnvelope('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseEnvelope('')).toBeNull();
  });

  it('parses a failure envelope', () => {
    const envelope = {
      pflVersion: '1.2.0',
      command: 'inspect',
      ok: false,
      completeness: 'unknown',
      diagnostics: [],
      data: {
        error: { code: 'CONSENT_REQUIRED', message: 'consent required' },
        missingScopes: ['claude-code:user'],
      },
    };

    const result = parseEnvelope(JSON.stringify(envelope));

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
  });
});

describe('normalizeObservationDir', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('renames snapshot-id.json to export.json and collects artifacts', async () => {
    tmpDir = await mkdtemp(join('/tmp', 'yuurei-obs-test-'));
    const observationDir = join(tmpDir, 'observation');
    await mkdir(observationDir, { recursive: true });
    await mkdir(join(observationDir, 'bundle'), { recursive: true });

    // Simulate pfl --out output
    await writeFile(join(observationDir, 'obs_abc123.json'), '{"test": true}', 'utf8');
    await writeFile(join(observationDir, 'bundle', 'harness.json'), '{"harness": true}', 'utf8');
    await writeFile(join(observationDir, 'bundle', 'manifest.json'), '{"manifest": true}', 'utf8');

    const artifacts = await normalizeObservationDir(observationDir);

    // export.json should exist
    const entries = await readdir(observationDir);
    expect(entries).toContain('export.json');
    expect(entries).not.toContain('obs_abc123.json');

    // Artifact paths
    expect(artifacts).toContain('observation/export.json');
    expect(artifacts).toContain('observation/bundle/harness.json');
    expect(artifacts).toContain('observation/bundle/manifest.json');
  });

  it('handles already-named export.json', async () => {
    tmpDir = await mkdtemp(join('/tmp', 'yuurei-obs-test-'));
    const observationDir = join(tmpDir, 'observation');
    await mkdir(observationDir, { recursive: true });

    await writeFile(join(observationDir, 'export.json'), '{"test": true}', 'utf8');

    const artifacts = await normalizeObservationDir(observationDir);

    expect(artifacts).toContain('observation/export.json');
    const entries = await readdir(observationDir);
    expect(entries).toContain('export.json');
  });

  it('returns empty array for empty directory', async () => {
    tmpDir = await mkdtemp(join('/tmp', 'yuurei-obs-test-'));
    const observationDir = join(tmpDir, 'observation');
    await mkdir(observationDir, { recursive: true });

    const artifacts = await normalizeObservationDir(observationDir);
    expect(artifacts).toEqual([]);
  });

  it('handles missing bundle directory', async () => {
    tmpDir = await mkdtemp(join('/tmp', 'yuurei-obs-test-'));
    const observationDir = join(tmpDir, 'observation');
    await mkdir(observationDir, { recursive: true });

    await writeFile(join(observationDir, 'obs_xyz.json'), '{}', 'utf8');

    const artifacts = await normalizeObservationDir(observationDir);
    expect(artifacts).toEqual(['observation/export.json']);
  });
});

describe('runObserver source-project declaration', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('records source-project-declaration-failed when the contract cannot be materialized', async () => {
    tmpDir = await mkdtemp(join('/tmp', 'yuurei-obs-test-'));
    const context: IsolationContext = {
      strategy: 'level1',
      // A cell root that does not exist makes the contract write fail.
      rootDir: join(tmpDir, 'missing-cell-root'),
      workspaceDir: tmpDir,
      homeDir: null,
      env: {},
      keep: false,
    };

    const result = await runObserver(
      { binPath: '/bin/true', reason: null },
      context,
      'cell_test',
      'claude-code',
      tmpDir,
      5000,
      {
        id: 'git-deadbeefdeadbeef',
        kind: 'git-remote',
        remote: 'example.com/owner/repo',
        source: '/src/repo',
        head: 'deadbeef',
      },
    );

    // The declaration is a hard prerequisite of a labeled observation: its
    // failure is recorded as its own reason, and the observer binary is
    // never spawned.
    expect(result.record.status).toBe('unavailable');
    expect(result.record.reason).toBe('source-project-declaration-failed');
    expect(result.stdout).toBe('');
  });
});
