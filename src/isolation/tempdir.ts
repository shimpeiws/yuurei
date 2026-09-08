import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'yuurei-';

export async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), PREFIX));
}

export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
