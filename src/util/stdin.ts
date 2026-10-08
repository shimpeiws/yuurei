import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';

/**
 * Upper bound for a task read from stdin. The content is passed to the
 * runtime as a single positional argument, so a task beyond the platform
 * argument-size limit can never run; bounding the read keeps a pipe that
 * never ends from exhausting memory before that limit is even reached.
 */
const MAX_STDIN_TASK_BYTES = 1024 * 1024;

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
    if (total > MAX_STDIN_TASK_BYTES) {
      throw new YuureiError(
        `task from stdin exceeds ${MAX_STDIN_TASK_BYTES} bytes; the runtime receives the task as a single argument and cannot run a task this large`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
