import { describe, expect, it } from 'vitest';
import type { ResolvedCell } from '../../cell/types.js';
import { buildOpenCodeArgs } from './args.js';

function makeCell(requestedModel: string): ResolvedCell {
  return {
    runtimeId: 'opencode',
    requestedModel,
    resolvedProfile: {
      name: 'test',
      content: { profileYaml: { runtime: 'opencode' }, configFiles: {} },
      digest: 'sha256:test',
    },
    resolvedTask: { source: 'task.md', content: 'do the thing', digest: 'sha256:task' },
    yuureiVersion: '0.0.1',
    executionOptions: { timeout_ms: null, runtime: {} },
    isolationStrategy: 'level1',
    requestedCellDigest: 'sha256:cell',
  };
}

describe('buildOpenCodeArgs', () => {
  it('runs non-interactively with JSON output and auto-approved permissions', () => {
    const args = buildOpenCodeArgs(makeCell(''));
    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto']);
  });

  it('places the task prompt after the flags', () => {
    const args = buildOpenCodeArgs(makeCell(''));
    expect(args[args.indexOf('--auto') + 1]).toBe('do the thing');
  });

  it('omits -m when no model is requested', () => {
    expect(buildOpenCodeArgs(makeCell(''))).not.toContain('-m');
  });

  it('appends -m provider/model and keeps the task last', () => {
    const args = buildOpenCodeArgs(makeCell('openrouter/anthropic/claude-3.5-haiku'));
    expect(args[args.indexOf('-m') + 1]).toBe('openrouter/anthropic/claude-3.5-haiku');
    expect(args[args.length - 1]).toBe('do the thing');
  });
});
