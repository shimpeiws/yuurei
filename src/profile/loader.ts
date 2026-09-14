import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { canonicalJsonStringify } from '../util/json.js';
import { sha256Digest } from '../util/hash.js';
import { isPathWithin, pathExists } from '../util/fs.js';
import { ProfileYamlSchema } from '../config/schema.js';
import { loadYamlConfig } from '../config/load-yaml.js';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import type { Profile, ResolvedProfile, ProfileContent } from './types.js';

/**
 * Loads `profile.yaml` and every file under `config/` into resolved
 * content, then digests that content. The digest is computed over actual
 * file contents, not the profile name, so two profiles with the same name
 * but different config never collide (design doc §7.3).
 */
export async function loadProfile(profile: Profile): Promise<ResolvedProfile> {
  const profileYaml = await loadYamlConfig(
    join(profile.sourceDir, 'profile.yaml'),
    ProfileYamlSchema,
  );

  const configDir = join(profile.sourceDir, 'config');
  let rawConfigFiles: Record<string, { content: Buffer; mode: number }>;
  try {
    rawConfigFiles = (await pathExists(configDir)) ? await readAllFiles(configDir) : {};
  } catch (error) {
    // Symlink/cycle faults already carry a configuration exit code; any other
    // I/O failure (ENOTDIR, EACCES, ENOENT) is likewise configuration, not a
    // runtime failure, so it exits 2 rather than 5.
    if (error instanceof YuureiError) throw error;
    throw new YuureiError(
      `cannot read profile config for '${profile.name}': ${
        error instanceof Error ? error.message : String(error)
      }`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }

  const content: ProfileContent = { profileYaml, configFiles: rawConfigFiles };

  // Digest over base64 (not raw Buffers) so JSON serialization of the
  // canonical form is stable and deterministic for binary content.
  const digestContent = {
    profileYaml,
    configFiles: Object.fromEntries(
      Object.entries(rawConfigFiles).map(([path, { content, mode }]) => [
        path,
        { content: content.toString('base64'), mode },
      ]),
    ),
  };
  const digest = sha256Digest(canonicalJsonStringify(digestContent));

  return {
    name: profile.name,
    runtime: profileYaml.runtime,
    content,
    digest,
  };
}

async function readAllFiles(
  rootDir: string,
): Promise<Record<string, { content: Buffer; mode: number }>> {
  const result: Record<string, { content: Buffer; mode: number }> = {};
  const rootReal = await realpath(rootDir);

  // `ancestors` holds the realpath of every directory on the CURRENT walk
  // branch (root to here), not every directory ever visited. A global
  // visited set would incorrectly drop a second, non-cyclic symlink to an
  // already-seen sibling directory (e.g. two symlinks both pointing at
  // config/shared/) and make the digest depend on readdir() ordering.
  // Tracking only the current branch still catches every real cycle,
  // including a symlink pointing back at a plain (non-symlink) ancestor.
  async function walk(currentDir: string, ancestors: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        // realpath() MUST come before isPathWithin(): isPathWithin() swallows a
        // realpath failure via .catch(() => resolve(child)), which makes a dangling
        // symlink appear to be within the boundary and pass the guard.
        const target = await realpath(fullPath).catch(() => null);
        if (target === null) {
          throw new YuureiError(
            `profile config contains a dangling symlink: ${relative(rootDir, fullPath)}`,
            EXIT_CODES.CONFIG_ERROR,
          );
        }
        if (!(await isPathWithin(rootReal, target))) {
          throw new YuureiError(
            `profile config symlink escapes the profile config directory: ${relative(rootDir, fullPath)}`,
            EXIT_CODES.CONFIG_ERROR,
          );
        }
        const targetStat = await stat(target);
        if (targetStat.isDirectory()) {
          if (ancestors.has(target)) {
            throw new YuureiError(
              `profile config symlink forms a cycle: ${relative(rootDir, fullPath)}`,
              EXIT_CODES.CONFIG_ERROR,
            );
          }
          await walk(fullPath, new Set([...ancestors, target]));
        } else if (targetStat.isFile()) {
          result[relative(rootDir, fullPath)] = {
            content: await readFile(target),
            mode: targetStat.mode,
          };
        }
      } else if (entry.isDirectory()) {
        const target = await realpath(fullPath);
        if (ancestors.has(target)) {
          throw new YuureiError(
            `profile config symlink forms a cycle: ${relative(rootDir, fullPath)}`,
            EXIT_CODES.CONFIG_ERROR,
          );
        }
        await walk(fullPath, new Set([...ancestors, target]));
      } else if (entry.isFile()) {
        result[relative(rootDir, fullPath)] = {
          content: await readFile(fullPath),
          mode: (await stat(fullPath)).mode,
        };
      }
    }
  }

  await walk(rootDir, new Set([rootReal]));
  return result;
}
