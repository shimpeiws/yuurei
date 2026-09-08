import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuntimeIds, getRuntime } from '../runtime/registry.js';
import type { Logger } from '../util/logger.js';

interface DoctorRuntimeCheck {
  runtimeId: string;
  installed: boolean;
  version: string | null;
  /** Not implemented in the v0.3 scaffold; filled in during Phase 1+. */
  authUsable: null;
}

export interface DoctorReport {
  runtimes: DoctorRuntimeCheck[];
  canWriteOutputDir: boolean;
}

/**
 * `yuurei doctor` — inspection only, never mutates the environment
 * (design doc §8.1). Only the checks that are genuinely cheap and
 * meaningful in the scaffold are implemented for real; the rest are left
 * as explicit `null` rather than guessed.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const runtimes: DoctorRuntimeCheck[] = [];
  for (const runtimeId of listRuntimeIds()) {
    const detection = await getRuntime(runtimeId).detect();
    runtimes.push({
      runtimeId,
      installed: detection.installed,
      version: detection.version,
      authUsable: null,
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
