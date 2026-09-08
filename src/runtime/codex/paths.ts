import { join } from 'node:path';

/** Codex's config root under a given HOME directory (real or isolated). */
export function codexConfigDir(homeDir: string): string {
  return join(homeDir, '.codex');
}
