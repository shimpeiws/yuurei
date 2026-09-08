import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TraceSchema, type Trace } from './schema.js';

/** Loads and validates `<runDir>/trace.json`. */
export async function readTrace(runDir: string): Promise<Trace> {
  const raw = await readFile(join(runDir, 'trace.json'), 'utf8');
  return TraceSchema.parse(JSON.parse(raw));
}
