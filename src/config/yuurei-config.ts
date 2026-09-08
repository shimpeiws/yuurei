import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { YuureiConfigSchema, type YuureiConfig } from './schema.js';

/** Loads and validates `<yuureiDir>/yuurei.yaml`. */
export async function loadYuureiConfig(yuureiDir: string): Promise<YuureiConfig> {
  const raw = await readFile(join(yuureiDir, 'yuurei.yaml'), 'utf8');
  return YuureiConfigSchema.parse(parse(raw));
}
