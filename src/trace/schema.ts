import { z } from 'zod';

/**
 * Independent of the yuurei package version — this only changes when the
 * on-disk trace.json shape changes (design doc §6.3).
 */
export const TRACE_SCHEMA_VERSION = '0.1';

export const TraceSchema = z.object({
  schema_version: z.literal(TRACE_SCHEMA_VERSION),
  run_id: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  runtime: z.object({
    id: z.string(),
    version: z.string().nullable(),
  }),
  model: z.object({
    requested: z.string(),
    resolved: z.string().nullable(),
  }),
  profile: z.object({
    name: z.string(),
    digest: z.string(),
  }),
  task: z.object({
    source: z.string(),
    digest: z.string(),
  }),
  isolation: z.object({
    strategy: z.string(),
    verified: z.boolean(),
  }),
  execution: z.object({
    exit_code: z.number().nullable(),
    duration_ms: z.number().nullable(),
  }),
  // An observed value not present in `usage` (rather than present as null)
  // means it was never even attempted; null means attempted but unobserved.
  usage: z.record(z.string(), z.number().nullable()),
  // null = cost was not estimated for this run (CostModel is a no-op in v0.3).
  cost: z
    .object({
      amount: z.number(),
      currency: z.string(),
    })
    .nullable(),
  artifacts: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
    }),
  ),
});

export type Trace = z.infer<typeof TraceSchema>;
