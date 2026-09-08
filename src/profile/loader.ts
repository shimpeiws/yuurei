import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { canonicalJsonStringify } from '../util/json.js';
import { sha256Digest } from '../util/hash.js';
import { pathExists } from '../util/fs.js';
import { ProfileYamlSchema } from '../config/schema.js';
import type { Profile, ResolvedProfile } from './types.js';

/**
 * Loads `profile.yaml` and every file under `config/` into resolved
 * content, then digests that content. The digest is computed over actual
 * file contents, not the profile name, so two profiles with the same name
 * but different config never collide (design doc §7.3).
 */
export async function loadProfile(profile: Profile): Promise<ResolvedProfile> {
  const profileYamlRaw = await readFile(join(profile.sourceDir, 'profile.yaml'), 'utf8');
  const profileYaml = ProfileYamlSchema.parse(parse(profileYamlRaw));

  const configDir = join(profile.sourceDir, 'config');
  const configFiles = (await pathExists(configDir)) ? await readAllFiles(configDir) : {};

  const content = { profileYaml, configFiles };
  const digest = sha256Digest(canonicalJsonStringify(content));

  return {
    name: profile.name,
    runtime: profileYaml.runtime,
    content,
    digest,
  };
}

async function readAllFiles(rootDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        result[relative(rootDir, fullPath)] = await readFile(fullPath, 'utf8');
      }
    }
  }

  await walk(rootDir);
  return result;
}
