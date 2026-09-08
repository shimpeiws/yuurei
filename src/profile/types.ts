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
  content: unknown;
  digest: string;
}
