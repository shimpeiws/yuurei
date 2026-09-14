import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Resolves `path` (symlinks included) as far as the filesystem allows, like
 * `util/fs`'s `realpathAsFarAsExists` — but fails closed: only `ENOENT` (the
 * path genuinely does not exist yet) falls back to the lexical parent. Any
 * other error (`EACCES`, `ELOOP`, `EIO`) throws, so a containment check that
 * depends on this can never silently treat an unresolvable path as safe.
 *
 * The shared `isPathWithin` is deliberately lenient because it is used for
 * materialization, where a check-then-read race is an accepted risk (§12.1).
 * The OpenCode guard's contract is stronger — a profile must not be able to
 * reach an out-of-cell credential — so it uses this instead.
 */
async function realpathStrict(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const parent = dirname(path);
      if (parent === path) return path; // filesystem root
      return join(await realpathStrict(parent), basename(path));
    }
    throw err;
  }
}

/** Whether `child` is `parent` or nested inside it, resolving symlinks strictly. */
export async function isRealPathWithin(parent: string, child: string): Promise<boolean> {
  const [realParent, realChild] = await Promise.all([
    realpathStrict(resolve(parent)),
    realpathStrict(resolve(child)),
  ]);
  return realChild === realParent || realChild.startsWith(`${realParent}/`);
}
