import { removeOrphanTempDirs, type RemoveOrphanTempDirsResult } from '../isolation/tempdir.js';
import type { Logger } from '../util/logger.js';

export interface CleanOptions {
  /** Scan root for orphaned temp dirs. Defaults to `os.tmpdir()`. Injectable for tests. */
  tempDir?: string;
}

/**
 * `yuurei clean` — removes `yuurei-*` temp directories left behind by
 * abnormal termination (SIGKILL, power loss, hard crash) that are old
 * enough to be safe to delete. This is the recovery half of the design
 * doc §15 safety regression; `yuurei doctor` reports the orphans, this
 * command deletes them. Deletion is best-effort: failures are reported
 * via the logger and the result, never abort the sweep.
 */
export async function runClean(
  logger: Logger,
  options?: CleanOptions,
): Promise<RemoveOrphanTempDirsResult> {
  const result = await removeOrphanTempDirs(
    options?.tempDir === undefined ? undefined : { root: options.tempDir },
  );

  if (result.removed.length === 0) {
    logger.info('no orphaned isolation temp directories found');
  } else {
    const noun = result.removed.length === 1 ? 'directory' : 'directories';
    logger.info(`removed ${result.removed.length} orphaned isolation temp ${noun}`);
  }
  for (const failed of result.failed) {
    logger.warn(
      `failed to remove orphaned isolation temp directory: ${failed.path} (${failed.error})`,
    );
  }

  return result;
}
