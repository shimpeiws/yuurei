import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Digest } from '../util/hash.js';
import type { SourceProjectIdentity } from './types.js';

/**
 * How much of the content hash a project id carries — the same truncation
 * pfl applies (`git-<16 hex>` / `path-<16 hex>`), so a yuurei-declared
 * identity and a pfl-observed one agree for the same project (#214).
 */
const ID_HEX_CHARS = 16;

function projectId(prefix: 'git' | 'path', key: string): string {
  return `${prefix}-${sha256Digest(key).slice('sha256:'.length, 'sha256:'.length + ID_HEX_CHARS)}`;
}

/**
 * Reduces the equivalent spellings of one remote to a single canonical
 * string: `ssh://git@github.com/o/r.git`, `git@github.com:o/r.git` and
 * `https://github.com/o/r` all become `github.com/o/r`. Deliberately mirrors
 * pfl's `normalizeRemoteUrl` (src/discovery/project-identity.ts) — the
 * declared identity only means something if both sides derive it the same
 * way.
 */
export function normalizeRemoteUrl(remote: string): string {
  const trimmed = remote.trim().replace(/[?#].*$/, '');
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  let hostPath: string;
  if (withoutScheme !== trimmed) {
    hostPath = withoutScheme.replace(/^[^@/]*@/, '');
  } else if (/^[^/@]+@[^/:]+:/.test(trimmed)) {
    hostPath = trimmed.replace(/^[^@/]*@/, '').replace(':', '/');
  } else {
    // No scheme and no scp-like `host:` — still strip a leading
    // `user[:pass]@` so a credential embedded in a scheme-less remote can
    // never reach the recorded identity (the normalized string is persisted
    // verbatim in the trace and the observer-facing contract).
    hostPath = trimmed.replace(/^[^@/]*@/, '');
  }

  const segments = hostPath.split('/');
  const host = segments[0];
  if (host && segments.length > 1) {
    segments[0] = host.replace(/:\d+$/, '');
  }

  return segments
    .filter((segment, index) => index === 0 || segment !== '')
    .join('/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/**
 * Bound on the `.git/config` read for remote extraction — the file is
 * normally a few hundred bytes; a pathological config is not a remote
 * source worth claiming an identity from.
 */
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;

/**
 * Selects the remote URL for identity from raw `.git/config` text: `origin`
 * if configured, else the first remote in file order. Mirrors pfl's
 * `parseRemoteUrl` (src/discovery/project-identity.ts) — same line-level
 * grammar (`[remote "name"]` sections, `url =` keys, `#`/`;` comments) so
 * both sides read the same value from the same bytes.
 */
function parseRemoteUrl(configText: string): string | null {
  let section: string | null = null;
  let originUrl: string | null = null;
  let firstRemoteUrl: string | null = null;

  for (const rawLine of configText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      continue;
    }
    if (section === null) continue;
    const remoteMatch = /^remote\s+"([^"]*)"$/.exec(section);
    if (!remoteMatch) continue;
    const urlMatch = /^url\s*=\s*(.+)$/.exec(line);
    const url = urlMatch?.[1]?.trim();
    if (!url) continue;
    if (remoteMatch[1] === 'origin' && originUrl === null) originUrl = url;
    if (firstRemoteUrl === null) firstRemoteUrl = url;
  }

  return originUrl ?? firstRemoteUrl;
}

/**
 * The remote URL recorded in the repository's own `.git/config`, or null
 * when there is no repository-local config to read. The file is read
 * directly — never through `git config` — for the same reasons pfl does:
 * no dependence on the installed Git version or its scope merging (global,
 * system, `include.path`/`includeIf` can never leak a remote into the
 * declared identity), and no spawned process on the provenance path.
 *
 * `.git` is checked with `lstat`: anything that is not a real directory —
 * the gitdir pointer file of a linked worktree or submodule, or a symlink —
 * is never followed, matching pfl's consent-gated refusal to chase external
 * gitdirs. `config` is opened with `O_NOFOLLOW` so a symlinked config is
 * refused atomically rather than allowed to resolve outside the repository,
 * and the descriptor is fstat'ed before reading so the bytes hashed are the
 * bytes the stat described — the same discipline as the seed file reads.
 * Any failure degrades to null — the caller falls back to a path-derived
 * identity rather than aborting a run over provenance it does not strictly
 * need.
 */
async function readLocalRemoteUrl(sourceDir: string): Promise<string | null> {
  const dotGit = join(sourceDir, '.git');
  if (!(await lstat(dotGit).catch(() => null))?.isDirectory()) {
    return null;
  }
  const handle = await open(
    join(dotGit, 'config'),
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (handle === null) {
    return null;
  }
  try {
    const stat = await handle.stat().catch(() => null);
    if (stat === null || !stat.isFile() || stat.size > MAX_GIT_CONFIG_BYTES) {
      return null;
    }
    const content = await handle.readFile().catch(() => null);
    return content === null ? null : parseRemoteUrl(content.toString('utf8'));
  } finally {
    // Every descriptor-level failure degrades to the path-derived identity;
    // provenance collection must never abort a run.
    await handle.close().catch(() => {});
  }
}

/**
 * Derives the stable source-project identity of the selected repository
 * (#214): from its preferred remote URL (`origin`, else the first configured
 * remote), or — when the repository has no remote — from the canonical
 * source root path.
 *
 * Reading the remote is provenance collection on a repository the operator
 * explicitly selected for seeding; the observer is never asked to read the
 * operator's host Git metadata to reconstruct it. The read is confined to
 * the repository-local `.git/config` — a `.git` gitdir pointer (linked
 * worktree, submodule) is never followed — matching pfl's consent-gated
 * derivation so host-side inspection and cell observation agree. A remote
 * read failure degrades to the path-derived identity rather than failing
 * the run: the fallback is still stable across cells from the same source
 * and distinct across different sources.
 */
export async function resolveSourceProjectIdentity(
  sourceDir: string,
  head: string,
): Promise<SourceProjectIdentity> {
  const remote = await readLocalRemoteUrl(sourceDir);
  if (remote !== null) {
    const normalized = normalizeRemoteUrl(remote);
    if (normalized !== '') {
      return {
        id: projectId('git', normalized),
        kind: 'git-remote',
        remote: normalized,
        source: sourceDir,
        head,
      };
    }
  }
  return { id: projectId('path', sourceDir), kind: 'local-path', source: sourceDir, head };
}
