import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from './redact.js';
import { TraceSchema, type Trace } from './schema.js';

/** Validates and persists a trace to `<runDir>/trace.json`. */
export async function writeTrace(runDir: string, trace: Trace): Promise<void> {
  const parsed = TraceSchema.parse(trace);
  const serialized = redactSecrets(JSON.stringify(parsed, null, 2));
  await writeFile(join(runDir, 'trace.json'), serialized, 'utf8');
}
