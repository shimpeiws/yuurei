import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';

/**
 * Resolves `path` as far as the filesystem actually allows (symlinks and
 * all), then appends whatever doesn't exist yet lexically. Plain
 * `realpath(path).catch(() => resolve(path))` is NOT safe when `path`
 * doesn't exist: it falls back to the fully-unresolved lexical path, so an
 * existing symlinked ancestor (e.g. macOS's `/var` -> `/private/var`, which
 * every OS temp dir sits under) is resolved on one side of a comparison and
 * not the other, producing a false negative.
 */
async function realpathAsFarAsExists(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path; // reached the filesystem root
    return join(await realpathAsFarAsExists(parent), basename(path));
  }
}

/** Whether `child` is `parent` itself or nested inside it, resolving symlinks on both sides. */
export async function isPathWithin(parent: string, child: string): Promise<boolean> {
  const [realParent, realChild] = await Promise.all([
    realpathAsFarAsExists(resolve(parent)),
    realpathAsFarAsExists(resolve(child)),
  ]);
  return realChild === realParent || realChild.startsWith(`${realParent}/`);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes an in-memory file tree under `destDir`, creating parent directories.
 * Keys are relative paths, normally produced by `loadProfile`'s guarded walk —
 * but this is the actual filesystem-write sink, so it re-validates every key
 * itself rather than trusting a caller-side invariant it cannot enforce.
 *
 * Deliberately sets no modes beyond the default: `destDir` and its
 * permissions are the caller's policy (the adapter creates it 0700).
 */
export async function writeFileTree(destDir: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(destDir, relPath);
    if (!(await isPathWithin(destDir, target))) {
      throw new YuureiError(
        `refusing to write ${relPath}: escapes destination directory ${destDir}`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}
