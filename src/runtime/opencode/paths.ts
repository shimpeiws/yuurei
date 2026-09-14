import { join } from 'node:path';

/**
 * OpenCode resolves its roots from the XDG base-directory variables and its
 * scratch root from TMPDIR (verified against 1.18.0/1.18.30; see
 * docs/design/spike/opencode-contract.md). These helpers keep that layout in
 * one place so the adapter, not the core, owns OpenCode's conventions
 * (design doc §6.1).
 *
 * Everything is derived from a single `configRoot` (the isolated HOME under
 * level1, or the temp rootDir under level0), matching `configRootOf`.
 */

/** Environment overrides that redirect every OpenCode root into the cell. */
export function openCodeEnv(configRoot: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(configRoot, '.config'),
    XDG_DATA_HOME: join(configRoot, '.local', 'share'),
    XDG_STATE_HOME: join(configRoot, '.local', 'state'),
    XDG_CACHE_HOME: join(configRoot, '.cache'),
    // Without this OpenCode resolves `debug paths`'s tmp root to the fixed
    // /tmp/opencode, outside the cell.
    TMPDIR: join(configRoot, 'tmp'),
  };
}

export function openCodeConfigDir(configRoot: string): string {
  return join(configRoot, '.config', 'opencode');
}

export function openCodeDataDir(configRoot: string): string {
  return join(configRoot, '.local', 'share', 'opencode');
}

/** OpenCode's data dir under a real (operator) HOME — the auth.json bridge source. */
export function realOpenCodeDataDir(homeDir: string): string {
  return join(homeDir, '.local', 'share', 'opencode');
}
