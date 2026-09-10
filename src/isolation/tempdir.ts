import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'yuurei-';

/**
 * Default minimum age before a `yuurei-*` temp dir counts as orphaned. A
 * run's temp root is only written directly at creation time (level1 writes
 * `home/` right after), so an actively-used root can look idle for a long
 * time; the threshold exists so the sweep never touches a directory a
 * (possibly hung) live run still owns.
 */
export const ORPHAN_TEMP_DIR_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface OrphanTempDir {
  /** Absolute path to the orphaned directory. */
  path: string;
  /** Milliseconds since the directory was last modified. */
  ageMs: number;
}

export interface FindOrphanTempDirsOptions {
  /**
   * Directory to scan for `yuurei-*` entries. Defaults to `os.tmpdir()`.
   * Injectable for tests so the sweep can run against a scratch root.
   */
  root?: string;
  /** Only directories older than this many milliseconds count. Defaults to `ORPHAN_TEMP_DIR_MIN_AGE_MS`. */
  olderThanMs?: number;
}

export async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), PREFIX));
}

export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Lists `yuurei-*` temp directories directly under the temp root that are
 * old enough to be considered orphaned — left behind by a `SIGKILL`, power
 * loss, or hard crash that bypassed the signal handler and `finally`-block
 * cleanup (design doc §9.1, §15 safety regression). Only real directories
 * are considered: a planted `yuurei-*` symlink or plain file with the prefix
 * is ignored, so the sweep can never be tricked into deleting its target.
 * Directories owned by another user are skipped too: `os.tmpdir()` is
 * per-user on macOS, but a Linux host with a shared `/tmp` puts other
 * people's `yuurei-*` runs in the same root, and this sweep deletes.
 * Unreadable roots and entries are skipped rather than propagated.
 */
export async function findOrphanTempDirs(
  options?: FindOrphanTempDirsOptions,
): Promise<OrphanTempDir[]> {
  const root = options?.root ?? tmpdir();
  const olderThanMs = options?.olderThanMs ?? ORPHAN_TEMP_DIR_MIN_AGE_MS;
  const now = Date.now();
  const orphans: OrphanTempDir[] = [];
  // Undefined on platforms without POSIX uids, where there is no ownership
  // to compare and the other guards above still apply.
  const uid = process.getuid?.();

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return orphans;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(PREFIX)) continue;
    // withFileTypes reads d_type; excludes symlinks (type 'symlink') and files.
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    // lstat (not stat) so a symlink swapped in after readdir is not followed.
    const info = await lstat(path).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    if (uid !== undefined && info.uid !== uid) continue;
    const ageMs = now - info.mtimeMs;
    if (ageMs >= olderThanMs) orphans.push({ path, ageMs });
  }

  return orphans;
}

export interface RemoveOrphanTempDirsResult {
  removed: OrphanTempDir[];
  failed: { path: string; error: string }[];
}

/**
 * Finds and removes orphaned temp directories (see `findOrphanTempDirs`).
 * Removal is best-effort: a failed deletion is reported in the result
 * rather than aborting the sweep, so one unremovable directory does not
 * hide the rest.
 */
export async function removeOrphanTempDirs(
  options?: FindOrphanTempDirsOptions,
): Promise<RemoveOrphanTempDirsResult> {
  const result: RemoveOrphanTempDirsResult = { removed: [], failed: [] };
  for (const orphan of await findOrphanTempDirs(options)) {
    try {
      await rm(orphan.path, { recursive: true, force: true });
      result.removed.push(orphan);
    } catch (error) {
      result.failed.push({
        path: orphan.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
