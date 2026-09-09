import { describe, expect, it } from 'vitest';
import type { ResolvedCell } from '../../cell/types.js';
import { buildCodexArgs } from './args.js';

function makeCell(requestedModel: string): ResolvedCell {
  return {
    runtimeId: 'codex',
    requestedModel,
    resolvedProfile: {
      name: 'test',
      content: { profileYaml: { runtime: 'codex' }, configFiles: {} },
      digest: 'sha256:test',
    },
    resolvedTask: { source: 'task.md', content: 'do the thing', digest: 'sha256:task' },
    yuureiVersion: '0.0.1',
    executionOptions: {},
    isolationStrategy: 'level1',
    cellDigest: 'sha256:cell',
  };
}

describe('buildCodexArgs', () => {
  it('always forces the file-backed credential store, regardless of model', () => {
    const args = buildCodexArgs(makeCell(''));
    expect(args).toContain('-c');
    expect(args).toContain('cli_auth_credentials_store="file"');
    expect(args).toContain('mcp_oauth_credentials_store="file"');
  });

  it('places the credential-store overrides before the task prompt', () => {
    // A materialized profile's config.toml could set cli_auth_credentials_store
    // to "keyring"/"auto" — the override must not be something a later flag
    // (or the caller re-invoking with a different arg order) can shadow.
    const args = buildCodexArgs(makeCell(''));
    const storeIndex = args.indexOf('cli_auth_credentials_store="file"');
    const promptIndex = args.indexOf('do the thing');
    expect(storeIndex).toBeGreaterThanOrEqual(0);
    expect(promptIndex).toBeGreaterThan(storeIndex);
  });

  it('still appends --model when a model is requested', () => {
    const args = buildCodexArgs(makeCell('o3'));
    expect(args).toContain('--model');
    expect(args[args.length - 1]).toBe('o3');
  });

  it('includes --json for JSONL event output', () => {
    const args = buildCodexArgs(makeCell(''));
    expect(args).toContain('--json');
  });
});
