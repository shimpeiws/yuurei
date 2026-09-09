import { describe, expect, it } from 'vitest';
import type { ResolvedCell } from '../../cell/types.js';
import { buildClaudeCodeArgs } from './args.js';

function makeCell(requestedModel: string): ResolvedCell {
  return {
    runtimeId: 'claude-code',
    requestedModel,
    resolvedProfile: {
      name: 'test',
      content: { profileYaml: { runtime: 'claude-code' }, configFiles: {} },
      digest: 'sha256:test',
    },
    resolvedTask: { source: 'task.md', content: 'do the thing', digest: 'sha256:task' },
    yuureiVersion: '0.0.1',
    executionOptions: {},
    isolationStrategy: 'level1',
    cellDigest: 'sha256:cell',
  };
}

describe('buildClaudeCodeArgs', () => {
  it('includes --print and --output-format json for structured output', () => {
    const args = buildClaudeCodeArgs(makeCell(''));
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('places the task prompt after the flags', () => {
    const args = buildClaudeCodeArgs(makeCell(''));
    const promptIndex = args.indexOf('do the thing');
    const printIndex = args.indexOf('--print');
    expect(promptIndex).toBeGreaterThan(printIndex);
  });

  it('appends --model when a model is requested', () => {
    const args = buildClaudeCodeArgs(makeCell('claude-opus-4'));
    expect(args).toContain('--model');
    expect(args[args.length - 1]).toBe('claude-opus-4');
  });
});
