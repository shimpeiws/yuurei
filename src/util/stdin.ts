import { buffer } from 'node:stream/consumers';

/**
 * Reads all of `process.stdin` as UTF-8. Used by `yuurei run --task -`, which
 * lets a caller holding a task as a string pass it through without first
 * writing a file. Reads to EOF, so a piped or redirected stdin terminates; an
 * interactive stdin terminates on the operator's end-of-input.
 */
export async function readStdin(): Promise<string> {
  return (await buffer(process.stdin)).toString('utf8');
}
