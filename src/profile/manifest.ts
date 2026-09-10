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
 * Reduces a resolved profile to what §10.1 says is recorded, a digest of the
 * profile content, rather than the content itself.
 *
 * A profile's `config/` legitimately carries secrets — an MCP server
 * definition with an API key is the ordinary case — and `.yuurei/runs/`
 * outlives the ephemeral cell by design, so serializing the bytes puts them
 * somewhere §10.2 says they are never recorded. Redacting the bytes instead
 * would not work: `redactSecrets` matches secret-shaped *text*, and a
 * `Buffer` serializes to a numeric array, so the patterns never see a string
 * to match. Digests avoid the question entirely.
 *
 * Per-file digests still answer what the record is for. Two runs used the
 * same profile if their digests agree, and a file that changed between runs
 * is identifiable by name without its contents being retained.
 */
export function toProfileManifest(resolved: ResolvedProfileRef): ProfileManifest {
  const configFiles: Record<string, ProfileFileManifest> = {};
  for (const [path, file] of Object.entries(resolved.content.configFiles)) {
    configFiles[path] = {
      digest: sha256Digest(file.content),
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
