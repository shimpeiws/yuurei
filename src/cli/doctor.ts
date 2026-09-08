import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuntimeIds, getRuntime } from '../runtime/registry.js';
import type { Logger } from '../util/logger.js';

interface DoctorRuntimeCheck {
  runtimeId: string;
  installed: boolean;
  version: string | null;
  versionSupported: boolean | null;
  authUsable: boolean | null;
}

export interface DoctorReport {
  runtimes: DoctorRuntimeCheck[];
  canWriteOutputDir: boolean;
}

/**
 * `yuurei doctor` — inspection only, never mutates the environment
 * (design doc §8.1). Authentication is reported only when an installed
 * runtime has credentials available through its supported default path.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const runtimes: DoctorRuntimeCheck[] = [];
  for (const runtimeId of listRuntimeIds()) {
    const detection = await getRuntime(runtimeId).detect();
    runtimes.push({
      runtimeId,
      installed: detection.installed,
      version: detection.version,
      versionSupported: detection.versionSupported,
      authUsable: detection.authUsable,
    });
  }

  return {
    runtimes,
    canWriteOutputDir: await canWriteToTempDir(),
  };
}

export function printDoctorReport(report: DoctorReport, logger: Logger): void {
  for (const runtime of report.runtimes) {
    logger.info(`${runtime.runtimeId}: ${runtime.installed ? 'installed' : 'not found'}`, {
      version: runtime.version,
      versionSupported: runtime.versionSupported,
      authUsable: runtime.authUsable,
    });
  }
  logger.info(`output directory writable: ${report.canWriteOutputDir}`);
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
