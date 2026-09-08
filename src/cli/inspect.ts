import { join } from 'node:path';
import { findYuureiDir } from '../config/discovery.js';
import { loadYuureiConfig } from '../config/yuurei-config.js';
import { loadProfile } from '../profile/loader.js';
import { YuureiError, EXIT_CODES } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

/** `yuurei inspect <profile-name>` — resolves a profile's config but never runs anything. */
export async function runInspect(cwd: string, profileName: string, logger: Logger): Promise<void> {
  const yuureiDir = await findYuureiDir(cwd);
  if (!yuureiDir) {
    throw new YuureiError('no .yuurei/ directory found', EXIT_CODES.CONFIG_ERROR);
  }

  const config = await loadYuureiConfig(yuureiDir);
  const profileEntry = config.profiles[profileName];
  if (!profileEntry) {
    throw new YuureiError(`unknown profile: ${profileName}`, EXIT_CODES.CONFIG_ERROR);
  }

  const resolved = await loadProfile({
    name: profileName,
    runtime: profileEntry.runtime,
    sourceDir: join(yuureiDir, profileEntry.source),
  });

  logger.info(profileName, { runtime: resolved.runtime, digest: resolved.digest });
}
