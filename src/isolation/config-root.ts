import type { IsolationContext } from './types.js';

/**
 * Returns the directory from which runtime-specific config paths should be
 * resolved. Under level1, this is the isolated homeDir; under level0, it is
 * rootDir (so CLAUDE_CONFIG_DIR / CODEX_HOME still point away from the user's
 * real ~/.claude / ~/.codex — see design doc §9.3).
 */
export function configRootOf(context: IsolationContext): string {
  return context.homeDir ?? context.rootDir;
}
