import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Digest } from '../util/hash.js';
import type { Artifact, ArtifactManifest } from './types.js';

/**
 * Collects known output files from a run directory into an artifact
 * manifest. What counts as an artifact and how large a file it will
 * digest is deliberately narrow in v0.3 (design doc §10: don't
 * unconditionally duplicate secrets or huge files).
 */
export async function collectArtifacts(runDir: string, paths: string[]): Promise<ArtifactManifest> {
  const artifacts: Artifact[] = [];
  for (const path of paths) {
    const content = await readFile(join(runDir, path), 'utf8').catch(() => null);
    if (content === null) continue;
    artifacts.push({ path, kind: kindFor(path), digest: sha256Digest(content) });
  }
  return { artifacts };
}

export async function writeArtifactManifest(
  runDir: string,
  manifest: ArtifactManifest,
): Promise<void> {
  await writeFile(join(runDir, 'artifacts.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

function kindFor(path: string): string {
  if (path.endsWith('.diff')) return 'patch';
  if (path.endsWith('.log')) return 'log';
  return 'file';
}
