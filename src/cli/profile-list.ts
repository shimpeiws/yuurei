import { findYuureiDir } from '../config/discovery.js';
import { loadYuureiConfig } from '../config/yuurei-config.js';
import { YuureiError, EXIT_CODES } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export async function runProfileList(cwd: string, logger: Logger): Promise<void> {
  const yuureiDir = await findYuureiDir(cwd);
  if (!yuureiDir) {
    throw new YuureiError('no .yuurei/ directory found', EXIT_CODES.CONFIG_ERROR);
  }

  const config = await loadYuureiConfig(yuureiDir);
  for (const [name, profile] of Object.entries(config.profiles)) {
    logger.info(name, { runtime: profile.runtime, source: profile.source });
  }
}
