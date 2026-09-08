import type { ResolvedCell } from '../../cell/types.js';

/**
 * Builds the non-interactive CLI invocation for Claude Code. Kept isolated
 * from the rest of the codebase so a future CLI flag change only touches
 * this file (design doc §6.1: adapter-internal conventions must not leak).
 */
export function buildClaudeCodeArgs(cell: ResolvedCell): string[] {
  const args = ['--print', '--output-format', 'json', cell.resolvedTask.content];
  if (cell.requestedModel) {
    args.push('--model', cell.requestedModel);
  }
  return args;
}
