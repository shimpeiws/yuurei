import { open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redactSecrets } from './redact.js';
import { TraceSchema, type Trace } from './schema.js';

/**
 * Validates and persists a trace to `<runDir>/trace.json`.
 *
 * `trace.json` is the completion marker (#111): its presence means the run
 * finished and every durable output succeeded. A direct write could leave a
 * truncated or malformed file after a crash mid-write, which the
 * completion-marker logic would then treat as complete and that `trace show`
 * would fail to parse. The trace is therefore written to a same-directory
 * temporary file, fsynced, and atomically renamed into place, so `trace.json`
 * only ever appears in a complete, valid state. On an ordinary failure the
 * temporary file is removed; one left behind by a hard crash shares the run
 * directory and is dropped together with it, and is never read as a trace
 * (readers address `trace.json` exactly).
 */
export async function writeTrace(runDir: string, trace: Trace): Promise<void> {
  const parsed = TraceSchema.parse(trace);
  const serialized = redactSecrets(JSON.stringify(parsed, null, 2));
  const tracePath = join(runDir, 'trace.json');
  const tempPath = join(runDir, `.trace.json.tmp-${randomUUID()}`);
  try {
    await writeFile(tempPath, serialized, 'utf8');
    const handle = await open(tempPath, 'r+');
    try {
      // Flush data to disk before the rename, so a crash right after the
      // atomic name flip cannot expose a zero-length trace.json.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, tracePath);
  } catch (error) {
    // A failed write/fsync/rename publishes nothing; leave neither a partial
    // trace nor its temporary sibling behind.
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
