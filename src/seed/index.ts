import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import { isPathWithin } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';
import { canonicalJsonStringify } from '../util/json.js';
import { gitHead, gitLsFiles, gitShowToplevel, gitStatusPorcelain } from './git.js';
import {
  SEED_MAX_FILE_BYTES,
  SEED_MAX_FILES,
  SEED_MAX_TOTAL_BYTES,
  SEED_POLICY,
  type ResolvedSeed,
  type SeedLimits,
  type SeedManifest,
} from './types.js';

/** The documented limits, as one object — the default `limits` for `resolveSeed`. */
const DEFAULT_SEED_LIMITS: SeedLimits = {
  maxFileBytes: SEED_MAX_FILE_BYTES,
  maxTotalBytes: SEED_MAX_TOTAL_BYTES,
  maxFiles: SEED_MAX_FILES,
};

/** Git index modes accepted for seeding: regular file, non-executable and executable. */
const REGULAR_FILE_MODES = new Set(['100644', '100755']);
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

/** Path components never materialized into a cell, even when tracked. */
const EXCLUDED_COMPONENTS = new Set(['.git', '.yuurei']);

function fail(message: string): never {
  throw new YuureiError(`seed: ${message}`, EXIT_CODES.CONFIG_ERROR);
}

/**
 * Validates one worktree-relative path before it is read from the source or
 * written into a cell. Components are already `/`-separated in Git output;
 * `..`, `.`, and empty components are rejected outright rather than
 * normalized, so nothing silently escapes the workspace.
 */
function assertSafeRelativePath(path: string): string[] {
  const components = path.split('/');
  if (components.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`unsafe path in repository index: ${path}`);
  }
  return components;
}

/** The git object id of a blob: sha1 over `blob <size>\0<content>`. */
function blobOid(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

/**
 * Resolves the requested seed: one explicitly selected local Git repository
 * root, in a clean tracked state, reduced to the canonical manifest of its
 * tracked regular files. Never clones or fetches, and never modifies the
 * source repository — every check is read-only.
 *
 * Fail-closed: any violation — a non-repository path, a subdirectory rather
 * than the root, an unborn HEAD, a dirty tracked state, a symlink, a
 * submodule, an unsafe path, a file that does not match its index blob, or a
 * documented limit — aborts the run before the cell exists.
 */
export async function resolveSeed(
  sourceDir: string,
  limits: SeedLimits = DEFAULT_SEED_LIMITS,
): Promise<ResolvedSeed> {
  const resolvedDir = await realpath(sourceDir).catch(() => fail(`cannot resolve ${sourceDir}`));
  if (!(await stat(resolvedDir).catch(() => null))?.isDirectory()) {
    fail(`${sourceDir} is not a directory`);
  }
  const toplevel = await gitShowToplevel(resolvedDir);
  if (toplevel === null) {
    fail(`${sourceDir} is not inside a Git repository`);
  }
  const resolvedToplevel = await realpath(toplevel).catch(() => null);
  if (resolvedToplevel === null || resolvedToplevel !== resolvedDir) {
    fail(`${sourceDir} is not the repository root (root is ${toplevel})`);
  }

  const head = await gitHead(resolvedDir);
  if (head === null) {
    fail(`${sourceDir} has no commits (unborn HEAD)`);
  }

  // A clean tracked state is required so local tracked edits cannot be
  // silently included: staged, unstaged, deleted or unmerged tracked paths
  // all fail here. Untracked and ignored files are excluded by policy and do
  // not affect cleanliness.
  const status = await gitStatusPorcelain(resolvedDir);
  if (status.trim() !== '') {
    fail(
      `repository ${sourceDir} is not clean; tracked files must match the index and HEAD. ` +
        'Commit, stash or revert the changes, or run without --seed-repo',
    );
  }

  const indexEntries = await gitLsFiles(resolvedDir);
  const files: SeedManifest = {};
  let excluded = 0;
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of indexEntries) {
    if (entry.stage !== '0') {
      fail(`path ${entry.path} has unresolved index stage ${entry.stage}`);
    }
    if (entry.mode === SYMLINK_MODE) fail(`tracked symlink ${entry.path} cannot be seeded`);
    if (entry.mode === GITLINK_MODE) fail(`submodule ${entry.path} cannot be seeded`);
    if (!REGULAR_FILE_MODES.has(entry.mode)) {
      fail(`unsupported index mode ${entry.mode} for ${entry.path}`);
    }
    const components = assertSafeRelativePath(entry.path);
    if (components.some((part) => EXCLUDED_COMPONENTS.has(part))) {
      excluded += 1;
      continue;
    }
    fileCount += 1;
    if (fileCount > limits.maxFiles) {
      fail(`seed exceeds the documented limit of ${limits.maxFiles} files`);
    }

    const sourcePath = join(resolvedDir, entry.path);
    const sourceStat = await lstat(sourcePath).catch(() => fail(`cannot stat ${entry.path}`));
    if (!sourceStat.isFile()) {
      fail(`tracked path ${entry.path} is not a regular file on disk`);
    }
    // lstat covers the final component only. `git status` already reports a
    // tracked path behind a symlinked directory as changed, so this is
    // defense in depth for the race window: a source that resolves outside
    // the repository root is never read into a cell.
    if (!(await isPathWithin(resolvedDir, sourcePath))) {
      fail(`tracked path ${entry.path} resolves outside the repository`);
    }
    if (sourceStat.size > limits.maxFileBytes) {
      fail(`tracked file ${entry.path} exceeds the per-file limit of ${limits.maxFileBytes} bytes`);
    }
    totalBytes += sourceStat.size;
    if (totalBytes > limits.maxTotalBytes) {
      fail(`seed exceeds the documented total limit of ${limits.maxTotalBytes} bytes`);
    }

    const content = await readFile(sourcePath).catch(() => fail(`cannot read ${entry.path}`));
    // The index blob id proves the bytes read are the bytes Git tracks; a
    // mismatch is a tracked local edit that slipped past the status check
    // (or a race with one) and must not be silently included.
    if (blobOid(content) !== entry.oid) {
      fail(`tracked file ${entry.path} does not match the index`);
    }
    files[entry.path] = {
      digest: sha256Digest(content),
      mode: entry.mode === '100755' ? 0o755 : 0o644,
      bytes: content.byteLength,
    };
  }

  const diagnostics: string[] = [];
  if (excluded > 0) {
    diagnostics.push(`seed: ${excluded} tracked path(s) excluded by policy`);
  }

  return {
    sourceDir: resolvedDir,
    head,
    files,
    digest: baselineDigest(files),
    fileCount,
    totalBytes,
    diagnostics,
  };
}

/** The whole-baseline digest: over the canonical manifest, nothing else. */
function baselineDigest(files: SeedManifest): string {
  return sha256Digest(canonicalJsonStringify({ version: 1, policy: SEED_POLICY, files }));
}

export interface MaterializedSeed {
  /** Whole-baseline digest recomputed from the bytes in the cell workspace. */
  digest: string;
}

/**
 * Materializes a resolved seed into the cell workspace, then verifies that
 * the materialized baseline agrees with the requested one — the runtime is
 * not started otherwise.
 *
 * Every source file is re-read and its digest re-checked against the
 * manifest, so a source change between resolution and materialization fails
 * rather than seeding stale bytes. After the writes, the workspace is walked
 * and its manifest recomputed: the materialized baseline must be exactly the
 * requested baseline — nothing extra, nothing missing, nothing different.
 */
export async function materializeSeed(
  seed: ResolvedSeed,
  workspaceDir: string,
): Promise<MaterializedSeed> {
  // The workspace is expected to be a fresh, empty directory — anything at
  // all, including an empty directory, is an unexpected extra and fails
  // before a single byte is written.
  if ((await readdir(workspaceDir)).length > 0) {
    fail('cell workspace is not empty before seeding');
  }
  for (const [path, entry] of Object.entries(seed.files)) {
    assertSafeRelativePath(path);
    const target = join(workspaceDir, path);
    if (!(await isPathWithin(workspaceDir, target))) {
      fail(`refusing to write ${path}: escapes the cell workspace`);
    }
    const content = await readFile(join(seed.sourceDir, path)).catch(() =>
      fail(`cannot read ${path} from the source repository`),
    );
    if (sha256Digest(content) !== entry.digest) {
      fail(`${path} changed between seed resolution and materialization`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    await chmod(target, entry.mode);
  }

  const materialized = await manifestOf(workspaceDir);
  const digest = baselineDigest(materialized);
  if (digest !== seed.digest) {
    fail('materialized workspace does not match the requested baseline');
  }
  return { digest };
}

/**
 * Recomputes the canonical manifest of a directory tree. Used to verify the
 * materialized workspace: a non-regular entry (a symlink planted under the
 * cell, a special file) is a verification failure, not a skip.
 */
async function manifestOf(dir: string): Promise<SeedManifest> {
  const files: SeedManifest = {};
  async function walk(relativeDir: string): Promise<void> {
    const entries = await readdir(join(dir, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const rel = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        const full = join(dir, rel);
        const content = await readFile(full);
        const fileStat = await stat(full);
        files[rel] = {
          digest: sha256Digest(content),
          mode: fileStat.mode & 0o777,
          bytes: content.byteLength,
        };
      } else {
        fail(`unexpected non-regular entry in the seeded workspace: ${rel}`);
      }
    }
  }
  await walk('');
  return files;
}

/** The durable record written to `baseline-manifest.json` on a seeded run. */
export function toBaselineManifest(
  seed: ResolvedSeed,
  materializedDigest: string,
): Record<string, unknown> {
  return {
    version: 1,
    policy: SEED_POLICY,
    source: seed.sourceDir,
    head: seed.head,
    requested_digest: seed.digest,
    materialized_digest: materializedDigest,
    files: seed.files,
  };
}
