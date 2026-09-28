import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import { decodeUtf8Strict, isPathWithin } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';
import { canonicalJsonStringify } from '../util/json.js';
import { gitHead, gitLsFiles, gitShowToplevel, gitStatusPorcelain } from './git.js';
import { resolveSourceProjectIdentity } from './project-identity.js';
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
    // Tracked filenames stay out of error output — a name may itself be
    // sensitive, the same reason patch diagnostics count without naming.
    fail('unsafe path in seed manifest');
  }
  return components;
}

/**
 * The git object id of a blob over `blob <size>\0<content>`, hashed with the
 * repository's object format. The index object ids carry the format: sha1 ids
 * are 40 hex characters, sha256 ids are 64. Hashing a sha256 repository with
 * sha1 would make every tracked file look locally edited.
 */
function blobOid(content: Buffer, indexOid: string): string {
  const algorithm = indexOid.length === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm).update(`blob ${content.byteLength}\0`).update(content).digest('hex');
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
  // Null prototype: a tracked path literally named `__proto__` must land as
  // an own key — assigning it onto `{}` invokes the prototype setter and
  // silently drops the file from the baseline (same reason as
  // canonicalJsonStringify's sort).
  const files = Object.create(null) as SeedManifest;
  let excluded = 0;
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of indexEntries) {
    if (entry.stage !== '0') {
      fail(`a tracked path has unresolved index stage ${entry.stage}`);
    }
    if (entry.mode === SYMLINK_MODE) fail('a tracked symlink cannot be seeded');
    if (entry.mode === GITLINK_MODE) fail('a tracked submodule cannot be seeded');
    if (!REGULAR_FILE_MODES.has(entry.mode)) {
      fail(`unsupported index mode ${entry.mode} for a tracked path`);
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
    // `git status` already reports a tracked path behind a symlinked
    // directory as changed; this is defense in depth for the race window —
    // a source that resolves outside the repository root is never read into
    // a cell.
    if (!(await isPathWithin(resolvedDir, sourcePath))) {
      fail('a tracked path resolves outside the repository');
    }
    // A blocking open would hang on a FIFO until a writer appears, so the
    // open is non-blocking and the descriptor itself is validated with
    // fstat below: a check-then-read on the path could observe two
    // different files, but the fd pins the inode — the bytes hashed below
    // are the bytes the stat described.
    const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK).catch(
      () => fail('cannot open a tracked file'),
    );
    let content: Buffer;
    try {
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) {
        fail('a tracked path is not a regular file on disk');
      }
      if (sourceStat.size > limits.maxFileBytes) {
        fail(`a tracked file exceeds the per-file limit of ${limits.maxFileBytes} bytes`);
      }
      totalBytes += sourceStat.size;
      if (totalBytes > limits.maxTotalBytes) {
        fail(`seed exceeds the documented total limit of ${limits.maxTotalBytes} bytes`);
      }
      content = await sourceHandle.readFile().catch(() => fail('cannot read a tracked file'));
    } finally {
      await sourceHandle.close();
    }
    // The index blob id proves the bytes read are the bytes Git tracks; a
    // mismatch is a tracked local edit that slipped past the status check
    // (or a race with one) and must not be silently included. Repositories
    // with clean filters (text=auto CRLF conversion, custom clean filters)
    // fail here by design: raw worktree bytes are never equal to the index
    // blob once a filter rewrites them.
    if (blobOid(content, entry.oid) !== entry.oid) {
      fail(
        'a tracked file does not match the index ' +
          '(content filters such as text=auto are not supported by seeding)',
      );
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
    sourceProject: await resolveSourceProjectIdentity(resolvedDir, head),
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
      fail('refusing to write a tracked path: escapes the cell workspace');
    }
    // Same non-blocking discipline as resolveSeed: a blocking open would
    // hang forever on a FIFO planted at the tracked path, so the open is
    // non-blocking and fstat on the descriptor proves the opened object is
    // a regular file.
    const sourcePath = join(seed.sourceDir, path);
    const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK).catch(
      () => fail('cannot read a tracked file from the source repository'),
    );
    let content: Buffer;
    try {
      if (!(await sourceHandle.stat()).isFile()) {
        fail('cannot read a tracked file from the source repository');
      }
      content = await sourceHandle
        .readFile()
        .catch(() => fail('cannot read a tracked file from the source repository'));
    } finally {
      await sourceHandle.close();
    }
    if (sha256Digest(content) !== entry.digest) {
      fail('a tracked file changed between seed resolution and materialization');
    }
    await mkdir(dirname(target), { recursive: true });
    // Exclusive create, owner-only at first: the workspace was verified
    // empty, so an existing entry at `target` — planted between the check
    // and this write — fails the materialization instead of being followed
    // or overwritten, and nothing else can observe the file before chmod.
    const targetHandle = await open(target, 'wx', 0o600);
    try {
      await targetHandle.writeFile(content);
    } finally {
      await targetHandle.close();
    }
    await chmod(target, entry.mode & 0o777);
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
  const files = Object.create(null) as SeedManifest;
  async function walk(relativeDir: string): Promise<void> {
    const entries = await readdir(join(dir, relativeDir), {
      withFileTypes: true,
      encoding: 'buffer',
    });
    for (const entry of entries) {
      // Raw-byte names, decoded strictly: a name that is not valid UTF-8
      // cannot match the manifest (and could not be recorded if it did), so
      // it is a verification failure like any other unexpected entry. A
      // literal U+FFFD decodes fine and keeps its real name.
      const name = decodeUtf8Strict(entry.name);
      if (name === null) {
        fail('unexpected entry in the seeded workspace');
      }
      const rel = relativeDir === '' ? name : `${relativeDir}/${name}`;
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
        fail('unexpected non-regular entry in the seeded workspace');
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
    // The declared source-project identity (#214): stable across cells
    // prepared from the same source, never derived from the cell path.
    source_project: {
      id: seed.sourceProject.id,
      kind: seed.sourceProject.kind,
      ...(seed.sourceProject.remote !== undefined ? { remote: seed.sourceProject.remote } : {}),
    },
    requested_digest: seed.digest,
    materialized_digest: materializedDigest,
    files: seed.files,
  };
}
