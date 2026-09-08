import { dirname, join } from 'node:path';
import { pathExists } from '../util/fs.js';

/** Walks upward from `startDir` looking for a `.yuurei/` directory, like git finds `.git/`. */
export async function findYuureiDir(startDir: string): Promise<string | null> {
  let current = startDir;
  for (;;) {
    const candidate = join(current, '.yuurei');
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
