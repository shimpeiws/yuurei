import { randomBytes } from 'node:crypto';

/**
 * Generates a sortable, filesystem-safe run id: a compact UTC timestamp
 * plus a short random suffix (e.g. `20260908T150112Z-a3f9`). Used as a
 * directory name under `.yuurei/runs/`, so it must contain no `:` or `/`.
 */
export function generateRunId(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const suffix = randomBytes(2).toString('hex');
  return `${timestamp}-${suffix}`;
}
