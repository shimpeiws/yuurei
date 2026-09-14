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

/**
 * How a run was specified (ADR-0013): the named run, or null for the
 * `--profile`/`--task` form, and which parameter fields the CLI took
 * precedence on. Field names only, never values.
 */
const DefinitionSchema = z.object({
  run: z.string().nullable(),
  cli_overrides: z.array(z.string()),
});
export type RunDefinition = z.infer<typeof DefinitionSchema>;

export const TraceSchema = z.object({
  schema_version: z.literal(TRACE_SCHEMA_VERSION),
  // Observed property of the run, not a digest input (ADR-0011). Absent on
  // traces written before v0.3.0; a reader treats absence as unknown.
  yuurei_version: z.string().optional(),
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
  // The requested-cell digest and the input set that produced it (ADR-0009,
  // ADR-0011). Absent on older traces; absence means unknown, never different.
  requested_cell: z
    .object({
      digest: z.string(),
      inputs_version: z.number().int(),
    })
    .optional(),
  isolation: z.object({
    strategy: z.string(),
    verified: z.boolean(),
  }),
  // The execution contracts that constitute cell identity (ADR-0009): the core
  // timeout, plus the adapter-owned generic record.
  execution_options: z
    .object({
      timeout_ms: z.number().int().nullable(),
      runtime: z.record(z.string(), z.unknown()),
    })
    .optional(),
  // How the run was specified (ADR-0013). Absent on older traces.
  definition: DefinitionSchema.optional(),
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
