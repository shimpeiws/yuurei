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
  if (logger.format === 'json') {
    printDoctorReportJson(report, logger);
    return;
  }
  printDoctorReportHuman(report, logger);
}

/**
 * Machine-readable path: one JSON object per line, `level` + `message` plus
 * the runtime/guidance/orphan data as top-level keys. This is the schema
 * scripts rely on and must not change (issue #103).
 */
function printDoctorReportJson(report: DoctorReport, logger: Logger): void {
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

/**
 * Human-readable path: one compact status block per runtime, warnings marked
 * with a `WARNING:` prefix so they stand out from successful checks, orphan
 * paths listed one per line after the count and cleanup command. Never prints
 * credential values — only the runtime-provided guidance text.
 */
function printDoctorReportHuman(report: DoctorReport, logger: Logger): void {
  for (const runtime of report.runtimes) {
    printRuntimeBlock(runtime, logger);
    logger.info('');
  }
  if (report.canWriteOutputDir) {
    logger.info('output directory');
    logger.info(`${HUMAN_INDENT}writable: yes`);
  } else {
    logger.warn('WARNING: output directory is not writable');
  }
  if (report.orphanTempDirs.length === 0) {
    logger.info('no orphaned isolation temp directories found');
  } else {
    const noun = report.orphanTempDirs.length === 1 ? 'directory' : 'directories';
    logger.warn(`WARNING: found ${report.orphanTempDirs.length} orphaned isolation temp ${noun}`);
    logger.warn(`${HUMAN_INDENT}Run "yuurei clean" to remove them.`);
    for (const orphan of report.orphanTempDirs) {
      logger.warn(`${HUMAN_INDENT}${orphan.path}`);
    }
  }
}

function printRuntimeBlock(runtime: DoctorRuntimeCheck, logger: Logger): void {
  logger.info(runtime.runtimeId);
  if (!runtime.installed) {
    logger.info(`${HUMAN_INDENT}status: not found`);
    return;
  }
  logger.info(`${HUMAN_INDENT}status: installed`);
  if (runtime.version !== null) {
    logger.info(`${HUMAN_INDENT}version: ${runtime.version}`);
  }
  if (runtime.versionSupported !== null) {
    if (runtime.versionSupported) {
      logger.info(`${HUMAN_INDENT}supported: yes`);
    } else {
      logger.warn(
        `${HUMAN_INDENT}WARNING: supported: no — upgrade this runtime to a supported version`,
      );
    }
  }
  if (runtime.authUsable === true) {
    logger.info(`${HUMAN_INDENT}authentication: ready`);
  } else if (runtime.authUsable === false) {
    logger.warn(`${HUMAN_INDENT}WARNING: authentication: required`);
    if (runtime.authGuidance !== undefined) {
      for (const line of wrapText(
        runtime.authGuidance,
        HUMAN_LINE_WIDTH - HUMAN_SUB_INDENT.length,
      )) {
        logger.warn(`${HUMAN_SUB_INDENT}${line}`);
      }
    }
  } else {
    logger.info(`${HUMAN_INDENT}authentication: not checked`);
  }
}

const HUMAN_LINE_WIDTH = 80;
const HUMAN_INDENT = '  ';
const HUMAN_SUB_INDENT = '    ';

/** Wraps a paragraph at word boundaries to `maxWidth` columns. */
function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
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
