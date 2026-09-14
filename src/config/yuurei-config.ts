import { join } from 'node:path';
import { YuureiConfigSchema, type YuureiConfig } from './schema.js';
import { loadYamlConfig } from './load-yaml.js';

/** Loads and validates `<yuureiDir>/yuurei.yaml`. */
export async function loadYuureiConfig(yuureiDir: string): Promise<YuureiConfig> {
  return loadYamlConfig(join(yuureiDir, 'yuurei.yaml'), YuureiConfigSchema);
}
