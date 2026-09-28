import { randomBytes } from 'node:crypto';

/**
 * Generates a cell instance identity (ADR-0021): a freshly allocated,
 * opaque identifier for each prepared isolation cell. Format:
 * `cell_<UTC timestamp>-<suffix>` (e.g. `cell_20260928T120000Z-a1b2c3`).
 *
 * - Starts with a letter, uses only `[A-Za-z0-9._:-]`, 1–128 characters.
 * - The `cell_` prefix distinguishes it from `run_id` and `requested_cell.digest`.
 * - The random suffix avoids collision without providing cryptographic security.
 * - The ID is not a secret; it is an observation provenance label.
 */
export function generateCellId(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const suffix = randomBytes(4).toString('hex');
  return `cell_${timestamp}-${suffix}`;
}
