import { sha256Digest } from '../util/hash.js';
import type { ResolvedProfileRef } from '../cell/types.js';
import type { ProfileYaml } from '../config/schema.js';

/** What is recorded about one materialized profile config file. */
export interface ProfileFileManifest {
  digest: string;
  /** Permission bits the file was materialized with, as `writeFileTree` applies them. */
  mode: number;
  bytes: number;
}

/**
 * The durable record of which profile a run used, written to
 * `resolved-profile.json`.
 */
export interface ProfileManifest {
  name: string;
  digest: string;
  profileYaml: ProfileYaml;
  configFiles: Record<string, ProfileFileManifest>;
}

/**
 * Reduces a resolved profile to what §10.1 records, a digest of the profile
 * content rather than the content itself.
 *
 * Redacting the bytes instead does not work: `redactSecrets` matches
 * secret-shaped *text*, and a `Buffer` serializes to a numeric array, so the
 * patterns never see a string to match.
 */
export function toProfileManifest(resolved: ResolvedProfileRef): ProfileManifest {
  const configFiles: Record<string, ProfileFileManifest> = {};
  for (const [path, file] of Object.entries(resolved.content.configFiles)) {
    configFiles[path] = {
      digest: sha256Digest(file.content),
      // The same mask `writeFileTree` chmods with (`util/fs.ts`), so this
      // records the bits that actually landed, not the profile's raw stat mode.
      mode: file.mode & 0o777,
      bytes: file.content.byteLength,
    };
  }

  return {
    name: resolved.name,
    digest: resolved.digest,
    profileYaml: resolved.content.profileYaml,
    configFiles,
  };
}
