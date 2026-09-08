import type { ProfileYaml } from '../config/schema.js';

/**
 * A profile's fully-loaded content: the parsed profile.yaml plus a snapshot
 * of every file under the profile's `config/`.
 *
 * INVARIANT: every key of `configFiles` is a relative path produced by
 * `path.relative()` over a walk rooted at that profile's `config/`, so no key
 * escapes its destination directory when re-joined. Enforced at the only
 * producer (`loadProfile`), which is the filesystem boundary.
 */
export interface ProfileContent {
  profileYaml: ProfileYaml;
  configFiles: Record<string, string>;
}

export interface Profile {
  name: string;
  runtime: string;
  /** Absolute path to the profile's directory (containing profile.yaml + config/). */
  sourceDir: string;
}

export interface ResolvedProfile {
  name: string;
  runtime: string;
  /** Fully-loaded profile.yaml content plus a snapshot of config/ file contents. */
  content: ProfileContent;
  digest: string;
}
