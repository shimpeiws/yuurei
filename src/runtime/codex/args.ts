import type { ResolvedCell } from '../../cell/types.js';

/**
 * Builds the non-interactive CLI invocation for Codex. Kept isolated from
 * the rest of the codebase so a future CLI flag change only touches this
 * file (design doc §6.1: adapter-internal conventions must not leak).
 */
export function buildCodexArgs(cell: ResolvedCell): string[] {
  const args = ['exec', cell.resolvedTask.content];
  if (cell.requestedModel) {
    args.push('--model', cell.requestedModel);
  }
  return args;
}
