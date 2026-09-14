import type { ResolvedCell } from '../../cell/types.js';

/**
 * Builds the non-interactive invocation for OpenCode. Kept isolated from the
 * rest of the codebase so a future CLI flag change only touches this file
 * (design doc §6.1: adapter-internal conventions must not leak).
 *
 * `run` is the non-interactive entry point. `--format json` emits NDJSON
 * events (the usage source). `--auto` is required for a coding run: without a
 * TTY and without it, OpenCode auto-rejects permission requests. The task is
 * passed as a positional argument; execCapture spawns with stdin at EOF, so
 * OpenCode's stdin read returns empty rather than hanging.
 *
 * `-m` takes a `provider/model` string; `cell.requestedModel` is passed
 * through verbatim, so a caller must supply the provider-qualified form.
 */
export function buildOpenCodeArgs(cell: ResolvedCell): string[] {
  const args = ['run', '--format', 'json', '--auto'];
  if (cell.requestedModel) {
    args.push('-m', cell.requestedModel);
  }
  args.push(cell.resolvedTask.content);
  return args;
}
