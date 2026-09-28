import { z } from 'zod';

/** Schema for `.yuurei/yuurei.yaml` (design doc §7.2). */
export const YuureiConfigSchema = z.object({
  version: z.literal(1),
  profiles: z.record(
    z.string(),
    z.object({
      runtime: z.string(),
      source: z.string(),
    }),
  ),
  runs: z.record(
    z.string(),
    z.object({
      profile: z.string(),
      task: z.string(),
      model: z.string().optional(),
      timeout: z.number().int().optional(),
      isolation: z.string().optional(),
      seed_repo: z.string().optional(),
    }),
  ),
  /**
   * Observer configuration for pre-run observation (#210).
   * Resolution order: config observer.pfl_path → PFL_BIN env → pfl on PATH.
   */
  observer: z
    .object({
      /** Path to the pfl binary. If not set, falls back to PFL_BIN env or pfl on PATH. */
      pfl_path: z.string().optional(),
    })
    .optional(),
});

export type YuureiConfig = z.infer<typeof YuureiConfigSchema>;

/** Schema for a single `profiles/<name>/profile.yaml`. */
export const ProfileYamlSchema = z.object({
  runtime: z.string(),
  description: z.string().optional(),
});

export type ProfileYaml = z.infer<typeof ProfileYamlSchema>;
