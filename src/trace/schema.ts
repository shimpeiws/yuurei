import { z } from 'zod';

/**
 * Independent of the yuurei package version — this only changes when the
 * on-disk trace.json shape changes (design doc §6.3).
 */
export const TRACE_SCHEMA_VERSION = '0.3';

/**
 * Why `model.resolved` has its value. `observed` = the effective model was
 * seen; `unobserved` = the runtime produced no model identity; `parse_failed`
 * = an expected source existed but could not be read. Lets a consumer tell
 * "not observed" from "observation failed" without parsing prose, and keeps
 * an unknown distinct from zero (§6.3).
 */
const MODEL_RESOLUTION_REASONS = ['observed', 'unobserved', 'parse_failed'] as const;
export type ModelResolutionReason = (typeof MODEL_RESOLUTION_REASONS)[number];

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
    // Additive and optional: omitted when resolved is non-null, and older
    // traces (written before this field existed) still parse.
    resolved_reason: z.enum(MODEL_RESOLUTION_REASONS).optional(),
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
    signal: z.string().nullable(),
    duration_ms: z.number().nullable(),
    timed_out: z.boolean(),
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
  // Durable, secret-free non-fatal notes (e.g. malformed runtime output). The
  // adapter's `warnings` remain operator-only and are not persisted (§6.3);
  // this is the durable record. Additive and optional.
  diagnostics: z.array(z.string()).optional(),
});

export type Trace = z.infer<typeof TraceSchema>;
