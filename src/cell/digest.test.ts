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
  isolationStrategy: 'level1',
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

  it('changes between level0 and level1 for otherwise-identical input', () => {
    // level0 and level1 have materially different HOME/config semantics
    // (design doc §9.3) — an otherwise-identical run must not collapse to
    // the same cell identity just because isolationStrategy is a pipeline
    // concern rather than profile/task content.
    expect(computeCellDigest({ ...base, isolationStrategy: 'level0' })).not.toBe(
      computeCellDigest({ ...base, isolationStrategy: 'level1' }),
    );
  });

  it('changes when the yuurei version changes', () => {
    // A cell is identified by the yuurei release that built it: identical
    // profile/task work against a different release is a different cell
    // (#113). Guards against a stale version feeding the digest after a bump.
    expect(computeCellDigest({ ...base, yuureiVersion: '0.0.2' })).not.toBe(
      computeCellDigest(base),
    );
  });
});
