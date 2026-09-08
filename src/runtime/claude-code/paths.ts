import { join } from 'node:path';

/** Claude Code's config root under a given HOME directory (real or isolated). */
export function claudeConfigDir(homeDir: string): string {
  return join(homeDir, '.claude');
}
