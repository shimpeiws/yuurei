export interface Artifact {
  path: string;
  kind: string;
  digest: string;
}

export interface ArtifactManifest {
  artifacts: Artifact[];
}
