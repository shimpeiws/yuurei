import { access, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Whether `child` is `parent` itself or nested inside it, resolving symlinks on both sides. */
export async function isPathWithin(parent: string, child: string): Promise<boolean> {
  const [realParent, realChild] = await Promise.all([
    realpath(resolve(parent)).catch(() => resolve(parent)),
    realpath(resolve(child)).catch(() => resolve(child)),
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
