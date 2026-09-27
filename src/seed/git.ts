import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import { decodeUtf8Strict } from '../util/fs.js';

const execFileAsync = promisify(execFile);

/**
 * `git ls-files` output can be large on a big repository — bounded well above
 * the documented file-count limit so the listing itself does not hit the cap.
 */
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Git resolves repository identity from `GIT_DIR`/`GIT_INDEX_FILE`/
 * `GIT_WORK_TREE` before it looks at `-C`. A caller that inherited those
 * variables — a git hook is the ordinary case — would make every seed check
 * run against the *caller's* repository instead of the selected one. Strip
 * every `GIT_*` variable so the seed sees only what `-C` names.
 * `GIT_OPTIONAL_LOCKS=0` stops `git status`/`ls-files` from opportunistically
 * refreshing `.git/index` (stat cache, fsmonitor data) — the seed must never
 * write to the source repository.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** Runs `git` in `cwd`, returning raw stdout. Failures are configuration errors. */
async function runGit(cwd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitEnv(),
    });
    return stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new YuureiError(
        'git is required to seed a workspace but was not found on PATH',
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const detail = typeof stderr === 'string' ? stderr : stderr?.toString('utf8').trim();
    throw new YuureiError(
      `git ${args[0] ?? ''} failed in ${cwd}${detail ? `: ${detail}` : ''}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
}

/**
 * The repository root containing `dir`, as git resolves it, or null when
 * `dir` is not inside a work tree.
 */
export async function gitShowToplevel(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitEnv(),
    });
    return stdout.trim();
  } catch (error) {
    // ENOENT is a missing git binary, not "not a repository".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new YuureiError(
        'git is required to seed a workspace but was not found on PATH',
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    return null;
  }
}

/** The repository's HEAD commit, or null when it has none (unborn HEAD). */
export async function gitHead(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitEnv(),
    });
    return stdout.trim();
  } catch (error) {
    // ENOENT is a missing git binary, not an unborn HEAD.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new YuureiError(
        'git is required to seed a workspace but was not found on PATH',
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    return null;
  }
}

/**
 * `git status --porcelain=v1 -uno`: one line per tracked path whose index or
 * worktree state differs from HEAD (staged, unstaged, deleted, unmerged).
 * Untracked and ignored files are absent by construction, so a clean
 * tracked state is exactly the empty output.
 */
export async function gitStatusPorcelain(dir: string): Promise<string> {
  const out = await runGit(dir, ['status', '--porcelain=v1', '-uno']);
  return out.toString('utf8');
}

export interface GitIndexEntry {
  /** Git file mode, e.g. `100644`, `100755`, `120000` (symlink), `160000` (gitlink). */
  mode: string;
  /** Index object id (git blob sha1) for the path. */
  oid: string;
  stage: string;
  /** Worktree-relative path, forward slashes. */
  path: string;
}

/**
 * `git ls-files -s -z`: every index entry with its mode, object id and stage.
 * `-z` gives raw, unquoted NUL-separated records; a record is
 * `<mode> SP <oid> SP <stage> TAB <path>`.
 *
 * The output is decoded strictly: the canonical manifest records paths as
 * JSON strings, so a tracked path that is not valid UTF-8 cannot be
 * represented faithfully and the seed fails rather than silently recording
 * a different name. Decoding strictly — not lossily — is also what keeps a
 * legitimate U+FFFD in a filename from being rejected later.
 */
export async function gitLsFiles(dir: string): Promise<GitIndexEntry[]> {
  const out = await runGit(dir, ['ls-files', '-s', '-z']);
  const text = decodeUtf8Strict(out);
  if (text === null) {
    throw new YuureiError(
      'a tracked path is not valid UTF-8 and cannot be seeded',
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  const entries: GitIndexEntry[] = [];
  for (const record of text.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) {
      throw new YuureiError(
        `unexpected git ls-files record while seeding ${dir}`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    const [mode = '', oid = '', stage = ''] = record.slice(0, tab).split(' ');
    entries.push({ mode, oid, stage, path: record.slice(tab + 1) });
  }
  return entries;
}
