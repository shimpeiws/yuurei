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

  it('rejects an unknown resolved_reason', () => {
    expect(() =>
      TraceSchema.parse({
        ...validTrace,
        model: { requested: '', resolved: null, resolved_reason: 'guessed' },
      }),
    ).toThrow();
  });
});
