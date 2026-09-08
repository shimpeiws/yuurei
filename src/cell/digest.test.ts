import { describe, expect, it } from 'vitest';
import { computeCellDigest } from './digest.js';
import type { CellIdentityInput } from './types.js';

const base: CellIdentityInput = {
  runtimeId: 'claude-code',
  requestedModel: 'sonnet',
  resolvedProfile: {
    name: 'default',
    content: { profileYaml: { runtime: 'claude-code' }, configFiles: {} },
    digest: 'sha256:profile',
  },
  resolvedTask: { source: 'task.md', content: '# Task\n', digest: 'sha256:task' },
  yuureiVersion: '0.0.1',
  executionOptions: {},
};

describe('computeCellDigest', () => {
  it('is stable for equivalent input', () => {
    expect(computeCellDigest(base)).toBe(computeCellDigest({ ...base }));
  });

  it('changes when a cell identity field changes', () => {
    expect(computeCellDigest({ ...base, requestedModel: 'opus' })).not.toBe(
      computeCellDigest(base),
    );
  });
});
