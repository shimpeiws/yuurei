export interface Artifact {
  path: string;
  kind: string;
  digest: string;
  truncated?: boolean;
}

export interface ArtifactManifest {
  artifacts: Artifact[];
}
