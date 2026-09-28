import { describe, expect, it } from 'vitest';
import { TRACE_SCHEMA_VERSION, TraceSchema } from './schema.js';

const validTrace = {
  schema_version: TRACE_SCHEMA_VERSION,
  run_id: 'run-1',
  started_at: '2026-01-01T00:00:00Z',
  finished_at: '2026-01-01T00:00:01Z',
  runtime: { id: 'codex', version: null },
  model: { requested: '', resolved: null },
  profile: { name: 'default', digest: 'sha256:profile' },
  task: { source: 'task.md', digest: 'sha256:task' },
  isolation: { strategy: 'level1', verified: true },
  execution: { exit_code: 0, signal: null, duration_ms: 1000, timed_out: false },
  usage: { tokens_in: null },
  cost: null,
  artifacts: [],
};

describe('TraceSchema', () => {
  it('accepts a valid trace', () => {
    expect(TraceSchema.parse(validTrace)).toEqual(validTrace);
  });

  it('rejects a trace with the wrong schema version', () => {
    expect(() => TraceSchema.parse({ ...validTrace, schema_version: '0.2' })).toThrow();
  });

  it('accepts the additive resolved_reason and diagnostics fields', () => {
    const withOptional = {
      ...validTrace,
      model: { requested: '', resolved: null, resolved_reason: 'unobserved' },
      diagnostics: ['opencode: 1 unparseable JSONL line(s) skipped (lines 2)'],
    };
    expect(TraceSchema.parse(withOptional)).toEqual(withOptional);
  });

  it('still parses a trace written before the additive fields existed', () => {
    // validTrace has neither field; it must remain readable.
    expect(() => TraceSchema.parse(validTrace)).not.toThrow();
  });

  it('accepts a non-null cost without source, as written before the field existed', () => {
    const withLegacyCost = {
      ...validTrace,
      cost: { amount: 0.42, currency: 'USD' },
    };
    expect(TraceSchema.parse(withLegacyCost)).toEqual(withLegacyCost);
  });

  it('rejects an unknown resolved_reason', () => {
    expect(() =>
      TraceSchema.parse({
        ...validTrace,
        model: { requested: '', resolved: null, resolved_reason: 'guessed' },
      }),
    ).toThrow();
  });

  it('accepts a trace with cell_id', () => {
    const withCellId = {
      ...validTrace,
      cell_id: 'cell_20260928T120000Z-a1b2c3d4',
    };
    expect(TraceSchema.parse(withCellId)).toEqual(withCellId);
  });

  it('still parses a trace without cell_id', () => {
    expect(() => TraceSchema.parse(validTrace)).not.toThrow();
  });

  it('accepts a trace with observation record (recorded)', () => {
    const withObservation = {
      ...validTrace,
      observation: {
        observer: { id: 'pfl', version: '1.2.0' },
        status: 'recorded',
        reason: null,
        completeness: 'complete',
        snapshot_ids: { observed: 'obs_abc123', resolved: 'res_def456' },
        artifacts: [{ path: 'observation/export.json', kind: 'observation' }],
      },
    };
    expect(TraceSchema.parse(withObservation)).toEqual(withObservation);
  });

  it('accepts a trace with observation record (unavailable)', () => {
    const withUnavailableObservation = {
      ...validTrace,
      observation: {
        observer: { id: 'pfl', version: null },
        status: 'unavailable',
        reason: 'observer-not-found',
        completeness: null,
        snapshot_ids: null,
        artifacts: [],
      },
    };
    expect(TraceSchema.parse(withUnavailableObservation)).toEqual(withUnavailableObservation);
  });

  it('accepts a trace with observation record (partial)', () => {
    const withPartialObservation = {
      ...validTrace,
      observation: {
        observer: { id: 'pfl', version: '1.2.0' },
        status: 'partial',
        reason: null,
        completeness: 'partial',
        snapshot_ids: { observed: 'obs_xyz789', resolved: 'res_uvw012' },
        artifacts: [{ path: 'observation/export.json', kind: 'observation' }],
      },
    };
    expect(TraceSchema.parse(withPartialObservation)).toEqual(withPartialObservation);
  });

  it('still parses a trace without observation', () => {
    expect(() => TraceSchema.parse(validTrace)).not.toThrow();
  });

  it('rejects an invalid observation status', () => {
    expect(() =>
      TraceSchema.parse({
        ...validTrace,
        observation: {
          observer: { id: 'pfl', version: null },
          status: 'invalid',
          reason: null,
          completeness: null,
          snapshot_ids: null,
          artifacts: [],
        },
      }),
    ).toThrow();
  });

  it('rejects an invalid observation reason', () => {
    expect(() =>
      TraceSchema.parse({
        ...validTrace,
        observation: {
          observer: { id: 'pfl', version: null },
          status: 'unavailable',
          reason: 'invalid-reason',
          completeness: null,
          snapshot_ids: null,
          artifacts: [],
        },
      }),
    ).toThrow();
  });
});
