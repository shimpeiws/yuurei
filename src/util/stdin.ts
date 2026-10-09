import { ERROR_CODES, EXIT_CODES, YuureiError } from '../cli/exit-codes.js';

/**
 * Upper bound for a task read from stdin: 128 KiB, Linux's per-argument
 * limit (MAX_ARG_STRLEN = 32 pages), the strictest of the supported
 * platforms. The content is passed to the runtime as a single positional
 * argument, so a task beyond this bound can never run; bounding the read
 * also keeps a pipe that never ends from exhausting memory first.
 */
const MAX_STDIN_TASK_BYTES = 128 * 1024;

/**
 * Reads all of `process.stdin` as UTF-8, up to MAX_STDIN_TASK_BYTES. Used by
 * `yuurei run --task -`, which lets a caller holding a task as a string pass
 * it through without first writing a file. Reads to EOF, so a piped or
 * redirected stdin terminates; an interactive stdin terminates on the
 * operator's end-of-input.
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += (chunk as Buffer).length;
    if (total >= MAX_STDIN_TASK_BYTES) {
      throw new YuureiError(
        `task from stdin reaches the ${MAX_STDIN_TASK_BYTES}-byte argument bound; the runtime receives the task as a single argument and cannot run a task this large`,
        EXIT_CODES.CONFIG_ERROR,
        ERROR_CODES.INVALID_INPUT,
      );
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
