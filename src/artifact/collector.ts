import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, ArtifactManifest } from './types.js';

export const DEFAULT_ARTIFACT_MAX_BYTES = 1024 * 1024;

export interface CollectArtifactsOptions {
  maxBytes?: number;
  truncatedPaths?: readonly string[];
}

/**
 * Collects known output files from a run directory into an artifact
 * manifest. What counts as an artifact and how large a file it will
 * digest is deliberately narrow in v0.3 (design doc §10: don't
 * unconditionally duplicate secrets or huge files).
 */
export async function collectArtifacts(
  runDir: string,
  paths: string[],
  options: CollectArtifactsOptions = {},
): Promise<ArtifactManifest> {
  const maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  validateMaxBytes(maxBytes);
  const artifacts: Artifact[] = [];
  for (const path of paths) {
    const artifact = await collectArtifact(
      runDir,
      path,
      maxBytes,
      options.truncatedPaths?.includes(path),
    );
    if (artifact) artifacts.push(artifact);
  }
  return { artifacts };
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
}

async function collectArtifact(
  runDir: string,
  path: string,
  maxBytes: number,
  knownTruncated = false,
): Promise<Artifact | null> {
  const sourcePath = join(runDir, path);
  const tempPath = `${sourcePath}.tmp-${randomUUID()}`;
  const hash = createHash('sha256');
  let bytes = 0;
  let truncated = knownTruncated;
  let needsRewrite = false;

  try {
    const source = createReadStream(sourcePath);
    const chunks: Buffer[] = [];
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        needsRewrite = true;
        break;
      }
      const kept = buffer.subarray(0, remaining);
      chunks.push(kept);
      hash.update(kept);
      bytes += kept.length;
      if (kept.length < buffer.length) {
        truncated = true;
        needsRewrite = true;
        break;
      }
    }

    if (needsRewrite) {
      const sourceStats = await stat(sourcePath);
      await writeFile(tempPath, Buffer.concat(chunks), { mode: sourceStats.mode & 0o7777 });
      await rename(tempPath, sourcePath);
    }
  } catch (error) {
    await rm(tempPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const artifact: Artifact = {
    path,
    kind: kindFor(path),
    digest: `sha256:${hash.digest('hex')}`,
  };
  if (truncated) artifact.truncated = true;
  return artifact;
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
