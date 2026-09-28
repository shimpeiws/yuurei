/**
 * Opt-in seeded project workspaces (#202): the seed selects one local Git
 * repository root and materializes its tracked, regular files — and only
 * those — into the cell workspace before the runtime starts.
 *
 * `SEED_POLICY` is the fixed, machine-readable name of that policy, recorded
 * in the trace's `seed.policy`: seed only regular files tracked by Git from
 * the selected, clean worktree. Untracked and ignored files, `.git/`, and
 * `.yuurei/` are outside the seed — a seeded workspace never claims to
 * contain every local project file.
 */
export const SEED_POLICY = 'git-tracked-files' as const;

/** Documented seed limits (contract, `--seed-repo`). Exceeding one fails closed. */
export const SEED_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const SEED_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const SEED_MAX_FILES = 20_000;

/** The three seed limits as one injectable set; the constants are the defaults. */
export interface SeedLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

/**
 * One materializable seed entry: a regular file tracked by Git, recorded as
 * the canonical manifest's path-and-content identity. `mode` is the
 * materialized permission (`0o644` or `0o755`), not the raw Git tree mode.
 */
export interface SeedFileEntry {
  /** sha256 digest of the file's content bytes. */
  digest: string;
  mode: number;
  bytes: number;
}

/** The canonical path-and-content-hash manifest: relative path → identity. */
export type SeedManifest = Record<string, SeedFileEntry>;

/**
 * The stable source-project identity of a seeded run (#214): a declared,
 * reproducible identity derived from the selected repository — never from
 * the temporary cell path — so two cells prepared from the same source share
 * it while distinct source projects do not. It is provenance, not an input
 * to `requested_cell.digest`, and must not imply that two observations or
 * executions are identical.
 *
 * The derivation deliberately matches the observer's (pfl's) own project
 * identity: `git-<hex16>` over the normalized remote URL when the repository
 * has one, else `path-<hex16>` over the canonical source root — so a
 * host-side inspection and a prepared-cell observation of the same project
 * carry the same id.
 */
export interface SourceProjectIdentity {
  /** `git-<hex16>` or `path-<hex16>` — see `resolveSourceProjectIdentity`. */
  id: string;
  /** Which derivation produced the id. */
  kind: 'git-remote' | 'local-path';
  /** The normalized remote URL the `git-` id hashes; only for `git-remote`. */
  remote?: string;
  /** Absolute, symlink-resolved source repository root — the same value as `sourceDir`. */
  source: string;
  /** The source repository's HEAD commit at resolution time (provenance). */
  head: string;
}

/**
 * The requested seed, resolved from the source repository before the cell
 * exists. `digest` is the whole-baseline digest over the canonical manifest;
 * `head` and `sourceDir` are non-secret provenance recorded in the trace and
 * in `baseline-manifest.json`, not inputs to that digest.
 */
export interface ResolvedSeed {
  /** Absolute, symlink-resolved path of the selected repository root. */
  sourceDir: string;
  /** The repository's HEAD commit at resolution time (provenance). */
  head: string;
  /** Canonical manifest of every file the seed will materialize. */
  files: SeedManifest;
  /** Whole-baseline digest over `files` (the baseline's identity). */
  digest: string;
  fileCount: number;
  totalBytes: number;
  /** Fixed-string notes for the trace's diagnostics (e.g. policy exclusions). */
  diagnostics: string[];
  /**
   * The declared source-project identity handed to the observer and recorded
   * in the trace's `seed.source_project` (#214).
   */
  sourceProject: SourceProjectIdentity;
}

/**
 * The changes the run produced relative to the materialized baseline, by
 * content digest. A file whose content is byte-identical to the baseline is
 * unchanged regardless of mtime or mode; mode and other metadata changes are
 * not part of the recorded change set.
 */
export interface WorkspaceChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}
