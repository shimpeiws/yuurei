import { join } from 'node:path';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';

/**
 * Rejects profile config entries that would land on a path the runtime reads
 * its own credential from (design doc §9.2). Without this, a profile shipping
 * its own credential file would survive untouched whenever bridging no-ops or
 * fails -- including simply being disabled -- and the run would silently
 * authenticate as whoever wrote the profile rather than as the operator.
 *
 * Enforced regardless of whether credential bridging is enabled for this run:
 * the isolated environment usually holds no credential of its own, so a
 * profile-supplied one competes with nothing and is used unconditionally.
 *
 * Comparison is on the *resolved destination*, via the same `join` the write
 * sink uses, rather than on the raw key. A guard that compares the raw key
 * lets `./auth.json` and `sub/../auth.json` through while `join` still lands
 * them on the reserved path. Lower-cased because a runtime resolves these
 * files by name on a filesystem that may not be case-sensitive.
 */
export function assertNoReservedConfigPath(
  destDir: string,
  configFiles: Record<string, { content: Buffer; mode: number }>,
  reservedNames: readonly string[],
): void {
  const reservedTargets = new Map(
    reservedNames.map((name) => [join(destDir, name).toLowerCase(), name]),
  );

  for (const key of Object.keys(configFiles)) {
    const reserved = reservedTargets.get(join(destDir, key).toLowerCase());
    if (reserved !== undefined) {
      const alias = key === reserved ? '' : ` (resolves to "${reserved}")`;
      throw new YuureiError(
        `profile config may not provide "${key}"${alias}: this path is reserved for the runtime's own credential`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
  }
}
