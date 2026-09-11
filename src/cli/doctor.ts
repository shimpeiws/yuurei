import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuntimeIds, getRuntime } from '../runtime/registry.js';
import { findOrphanTempDirs, type OrphanTempDir } from '../isolation/tempdir.js';
import type { Logger } from '../util/logger.js';

interface DoctorRuntimeCheck {
  runtimeId: string;
  installed: boolean;
  version: string | null;
  versionSupported: boolean | null;
  authUsable: boolean | null;
  authGuidance?: string;
}

export interface DoctorReport {
  runtimes: DoctorRuntimeCheck[];
  canWriteOutputDir: boolean;
  /** `yuurei-*` temp dirs left behind by abnormal termination (design doc §15). */
  orphanTempDirs: OrphanTempDir[];
}

export interface DoctorOptions {
  /** Scan root for orphaned temp dirs. Defaults to `os.tmpdir()`. Injectable for tests. */
  tempDir?: string;
}

/**
 * `yuurei doctor` — inspection only, never mutates the environment
 * (design doc §8.1). Authentication is reported only when an installed
 * runtime has credentials available through its supported default path.
 */
export async function runDoctor(options?: DoctorOptions): Promise<DoctorReport> {
  const runtimes: DoctorRuntimeCheck[] = [];
  for (const runtimeId of listRuntimeIds()) {
    const detection = await getRuntime(runtimeId).detect();
    runtimes.push({
      runtimeId,
      installed: detection.installed,
      version: detection.version,
      versionSupported: detection.versionSupported,
      authUsable: detection.authUsable,
      ...(detection.authGuidance !== undefined ? { authGuidance: detection.authGuidance } : {}),
    });
  }

  return {
    runtimes,
    canWriteOutputDir: await canWriteToTempDir(),
    orphanTempDirs: await findOrphanTempDirs(
      options?.tempDir === undefined ? undefined : { root: options.tempDir },
    ),
  };
}

export function printDoctorReport(report: DoctorReport, logger: Logger): void {
  for (const runtime of report.runtimes) {
    logger.info(`${runtime.runtimeId}: ${runtime.installed ? 'installed' : 'not found'}`, {
      version: runtime.version,
      versionSupported: runtime.versionSupported,
      authUsable: runtime.authUsable,
    });
    if (runtime.installed && runtime.authUsable === false && runtime.authGuidance !== undefined) {
      logger.warn(`${runtime.runtimeId}: authentication required — next steps`, {
        authGuidance: runtime.authGuidance,
      });
    }
  }
  logger.info(`output directory writable: ${report.canWriteOutputDir}`);
  if (report.orphanTempDirs.length === 0) {
    logger.info('no orphaned isolation temp directories found');
  } else {
    logger.warn(
      `found ${report.orphanTempDirs.length} orphaned isolation temp director${report.orphanTempDirs.length === 1 ? 'y' : 'ies'}; run "yuurei clean" to remove them`,
      { paths: report.orphanTempDirs.map((orphan) => orphan.path) },
    );
  }
}

async function canWriteToTempDir(): Promise<boolean> {
  try {
    const dir = await mkdtemp(join(tmpdir(), 'yuurei-doctor-'));
    await access(dir, constants.W_OK);
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
