import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { YuureiConfig } from '../config/schema.js';

/**
 * Observer binary resolution result.
 * Resolution order: config observer.pfl_path → PFL_BIN env → pfl on PATH.
 */
export interface ResolvedObserver {
  /** Path to the pfl binary, or null if not found. */
  binPath: string | null;
  /** Reason if not found, for recording in the observation record. */
  reason: string | null;
}

/**
 * Resolves the pfl binary path using the priority order defined in the design doc.
 * 1. config observer.pfl_path
 * 2. PFL_BIN environment variable
 * 3. pfl on PATH (checked via which-like logic)
 */
export async function resolvePflBinary(config: YuureiConfig): Promise<ResolvedObserver> {
  // 1. Check config
  if (config.observer?.pfl_path) {
    const binPath = config.observer.pfl_path;
    if (await isExecutable(binPath)) {
      return { binPath, reason: null };
    }
    return { binPath: null, reason: 'observer-not-found' };
  }

  // 2. Check PFL_BIN env
  const pflBin = process.env['PFL_BIN'];
  if (pflBin) {
    if (await isExecutable(pflBin)) {
      return { binPath: pflBin, reason: null };
    }
    return { binPath: null, reason: 'observer-not-found' };
  }

  // 3. Check PATH
  const pathBin = await findInPath('pfl');
  if (pathBin) {
    return { binPath: pathBin, reason: null };
  }

  return { binPath: null, reason: 'observer-not-found' };
}

/**
 * Checks if a file exists and is accessible.
 */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds an executable in PATH.
 * This is a simplified version - in production, we'd use which or similar.
 */
async function findInPath(name: string): Promise<string | null> {
  const pathDirs = (process.env['PATH'] ?? '/usr/bin:/bin').split(':');
  for (const dir of pathDirs) {
    const fullPath = join(dir, name);
    if (await isExecutable(fullPath)) {
      return fullPath;
    }
  }
  return null;
}
