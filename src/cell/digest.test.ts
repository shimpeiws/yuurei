import { describe, expect, it } from 'vitest';
import { computeRequestedCellDigest } from './digest.js';
import type { RequestedCellInput } from './types.js';

const base: RequestedCellInput = {
  runtimeId: 'claude-code',
  requestedModel: 'sonnet',
  isolationStrategy: 'level1',
  executionOptions: { timeout_ms: null, runtime: {} },
  profileContentDigest: 'sha256:profile',
  taskContentDigest: 'sha256:task',
};

describe('computeRequestedCellDigest', () => {
  it('is stable for equivalent input', () => {
    expect(computeRequestedCellDigest(base)).toBe(computeRequestedCellDigest({ ...base }));
  });

  it('changes when a cell identity field changes', () => {
    expect(computeRequestedCellDigest({ ...base, requestedModel: 'opus' })).not.toBe(
      computeRequestedCellDigest(base),
    );
  });

  it('changes when the resolved profile or task content changes', () => {
    expect(computeRequestedCellDigest({ ...base, profileContentDigest: 'sha256:other' })).not.toBe(
      computeRequestedCellDigest(base),
    );
    expect(computeRequestedCellDigest({ ...base, taskContentDigest: 'sha256:other' })).not.toBe(
      computeRequestedCellDigest(base),
    );
  });

  it('changes between level0 and level1 for otherwise-identical input', () => {
    // level0 and level1 have materially different HOME/config semantics
    // (design doc §9.3) — an otherwise-identical run must not collapse to
    // the same cell identity just because isolationStrategy is a pipeline
    // concern rather than profile/task content.
    expect(computeRequestedCellDigest({ ...base, isolationStrategy: 'level0' })).not.toBe(
      computeRequestedCellDigest({ ...base, isolationStrategy: 'level1' }),
    );
  });

  it('changes when the timeout execution contract changes', () => {
    // The timeout changes the run's termination condition, so it is part of
    // cell identity (ADR-0011, ADR-0009).
    expect(
      computeRequestedCellDigest({
        ...base,
        executionOptions: { ...base.executionOptions, timeout_ms: 5000 },
      }),
    ).not.toBe(computeRequestedCellDigest(base));
  });

  it('changes when an adapter-owned execution contract changes', () => {
    expect(
      computeRequestedCellDigest({
        ...base,
        executionOptions: {
          ...base.executionOptions,
          runtime: { bridge_codex_auth_file: true },
        },
      }),
    ).not.toBe(computeRequestedCellDigest(base));
  });
});
