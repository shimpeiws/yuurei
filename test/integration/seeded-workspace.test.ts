import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { runPipeline } from '../../src/run/pipeline.js';
import { pathExists } from '../../src/util/fs.js';
import { sha256Digest } from '../../src/util/hash.js';
import type { ResolvedProfile } from '../../src/profile/types.js';
import type { IsolationContext } from '../../src/isolation/types.js';
import type {
  NormalizationContext,
  PreparedRun,
  RegisterCredentialPath,
  Runtime,
} from '../../src/runtime/types.js';
import type { ResolvedCell } from '../../src/cell/types.js';

const git = promisify(execFile);

/**
 * Git inherits repository identity from `GIT_DIR`/`GIT_INDEX_FILE`/
 * `GIT_WORK_TREE`, which a parent git hook (e.g. lefthook running this
 * suite) sets on the environment. Strip every `GIT_*`/`LEFTHOOK*` variable
 * so fixture commands address the fixture repository, never the caller's.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && !key.startsWith('LEFTHOOK'),
    ),
  );
}

async function gitIn(dir: string, args: string[]): Promise<string> {
  const { stdout } = await git('git', ['-C', dir, ...args], { env: cleanGitEnv() });
  return stdout.toString();
}

/** A local Git repository fixture — the only thing a seed may select. */
async function initSeedRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yuurei-e2e-seedrepo-'));
  await git('git', ['init', '-q'], { cwd: dir, env: cleanGitEnv() });
  await git('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    env: cleanGitEnv(),
  });
  await git('git', ['config', 'user.name', 'Test'], { cwd: dir, env: cleanGitEnv() });
  await git('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, env: cleanGitEnv() });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await git('git', ['add', '-A'], { cwd: dir, env: cleanGitEnv() });
  await git('git', ['commit', '-qm', 'initial'], { cwd: dir, env: cleanGitEnv() });
  return dir;
}

/**
 * A fake runtime whose execute() replays `mutate` against the cell
 * workspace — the only side effect a seeded run's result record observes.
 */
function makeWorkspaceRuntime(
  id: string,
  mutate?: (workspaceDir: string) => Promise<void>,
): Runtime {
  return {
    id: () => id,
    detect: async () => ({
      installed: true,
      version: null,
      executablePath: null,
      authUsable: null,
    }),
    prepare: async (
      cell: ResolvedCell,
      isolation: IsolationContext,
      _registerCredentialPath: RegisterCredentialPath,
    ): Promise<PreparedRun> => ({
      runtimeId: id,
      command: 'true',
      args: [],
      env: {},
      cwd: isolation.workspaceDir,
      isolation,
      cell,
      runtimeVersion: null,
      credentialValuesToRedact: [],
    }),
    execute: async (run: PreparedRun) => {
      if (mutate) await mutate(run.isolation.workspaceDir);
      const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
      const stderrPath = join(run.isolation.rootDir, 'stderr.log');
      await writeFile(stdoutPath, '', 'utf8');
      await writeFile(stderrPath, '', 'utf8');
      return {
        exitCode: 0,
        signal: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        stdoutPath,
        stderrPath,
        timedOut: false,
      };
    },
    normalize: async (_result, _context: NormalizationContext) => ({
      runtime: { id, version: null },
      model: { requested: '', resolved: null },
      execution: { exitCode: 0, signal: null, durationMs: 0 },
      usage: {},
    }),
  };
}

const profile: ResolvedProfile = {
  name: 'seeded-test',
  runtime: 'fake-seeded-runtime',
  content: { profileYaml: { runtime: 'fake-seeded-runtime' }, configFiles: {} },
  digest: 'sha256:0000',
};

describe('seeded workspace runs (#202)', () => {
  let workDir: string;
  let taskPath: string;
  let repo: string;
  const dirs: string[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-seeded-test-'));
    taskPath = join(workDir, 'task.md');
    await writeFile(taskPath, '# Task\n\nChange things.\n', 'utf8');
  });

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  async function freshRepo(files: Record<string, string>): Promise<string> {
    repo = await initSeedRepo(files);
    return repo;
  }

  it('records one addition, one modification, and one deletion against the baseline', async () => {
    const seedRepo = await freshRepo({
      'keep.txt': 'same\n',
      'mod.txt': 'old one\nold two\n',
      'gone.txt': 'bye\n',
    });
    const runtime = makeWorkspaceRuntime('fake-seeded-runtime', async (workspaceDir) => {
      await writeFile(join(workspaceDir, 'mod.txt'), 'new one\n');
      await rm(join(workspaceDir, 'gone.txt'));
      await writeFile(join(workspaceDir, 'new.txt'), 'added\n');
    });

    const { runDir, trace } = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      seedRepo,
      resolveRuntime: () => runtime,
    });

    // Trace: requested and materialized baseline identities agree; the
    // change counts and provenance are recorded; the patch is a complete
    // seeded diff.
    expect(trace.seed?.policy).toBe('git-tracked-files');
    expect(trace.seed?.head).toBe((await gitIn(seedRepo, ['rev-parse', 'HEAD'])).trim());
    expect(trace.seed?.baseline.requested_digest).toBe(trace.seed?.baseline.materialized_digest);
    expect(trace.seed?.baseline.files).toBe(3);
    expect(trace.seed?.changes).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(trace.patch).toEqual({ base: 'seeded', state: 'complete' });
    expect(trace.requested_cell.inputs_version).toBe(2);

    // changes.json carries the full change record, including the deletion
    // the retained workspace cannot express.
    const changes = JSON.parse(await readFile(join(runDir, 'changes.json'), 'utf8')) as {
      baseline_digest: string;
      added: string[];
      modified: string[];
      deleted: string[];
    };
    expect(changes.baseline_digest).toBe(trace.seed?.baseline.requested_digest);
    expect(changes.added).toEqual(['new.txt']);
    expect(changes.modified).toEqual(['mod.txt']);
    expect(changes.deleted).toEqual(['gone.txt']);

    // The durable workspace retains only changed/added files — unchanged
    // baseline content is not persisted.
    const retained = (await readdir(join(runDir, 'workspace'))).sort();
    expect(retained).toEqual(['mod.txt', 'new.txt']);
    expect(await readFile(join(runDir, 'workspace', 'mod.txt'), 'utf8')).toBe('new one\n');

    // baseline-manifest.json binds requested/materialized identities and
    // the canonical path-and-content manifest.
    const baselineManifest = JSON.parse(
      await readFile(join(runDir, 'baseline-manifest.json'), 'utf8'),
    ) as {
      policy: string;
      source: string;
      head: string;
      requested_digest: string;
      materialized_digest: string;
      files: Record<string, { digest: string }>;
    };
    expect(baselineManifest.policy).toBe('git-tracked-files');
    expect(baselineManifest.requested_digest).toBe(baselineManifest.materialized_digest);
    expect(baselineManifest.files['keep.txt']?.digest).toBe(sha256Digest(Buffer.from('same\n')));

    // The patch is relative to the baseline: an addition, a modification
    // with old and new lines, and a deletion.
    const patch = await readFile(join(runDir, 'patch.diff'), 'utf8');
    expect(patch).toContain('+++ /dev/null\n');
    expect(patch).toContain('--- /dev/null\n+++ new.txt\n');
    expect(patch).toContain('--- mod.txt\n+++ mod.txt\n');
    expect(patch).toContain('-old one\n-old two\n');
    expect(patch).toContain('+new one\n');
    expect(patch).toContain('--- gone.txt\n+++ /dev/null\n');
    expect(patch).toContain('-bye\n');

    // The source repository is untouched.
    expect(await gitIn(seedRepo, ['status', '--porcelain'])).toBe('');
    expect(await readFile(join(seedRepo, 'mod.txt'), 'utf8')).toBe('old one\nold two\n');
  });

  it('records a complete empty diff for a no-change seeded run', async () => {
    const seedRepo = await freshRepo({ 'a.txt': 'same\n' });
    const runtime = makeWorkspaceRuntime('fake-seeded-runtime');

    const { runDir, trace } = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      seedRepo,
      resolveRuntime: () => runtime,
    });

    // A successful no-change run is unambiguous: patch.diff exists, is
    // empty, and is marked complete — distinct from an absent patch.
    expect(await readFile(join(runDir, 'patch.diff'), 'utf8')).toBe('');
    expect(trace.patch).toEqual({ base: 'seeded', state: 'complete' });
    expect(trace.seed?.changes).toEqual({ added: 0, modified: 0, deleted: 0 });
    const changes = JSON.parse(await readFile(join(runDir, 'changes.json'), 'utf8')) as {
      added: string[];
      modified: string[];
      deleted: string[];
    };
    expect(changes.added).toEqual([]);
    expect(changes.modified).toEqual([]);
    expect(changes.deleted).toEqual([]);
    expect(await readdir(join(runDir, 'workspace'))).toEqual([]);
  });

  it('fails before the runtime starts when the seed repository is dirty', async () => {
    const seedRepo = await freshRepo({ 'a.txt': 'same\n' });
    await writeFile(join(seedRepo, 'a.txt'), 'local edit\n');
    let prepared = false;
    const runtime = makeWorkspaceRuntime('fake-seeded-runtime');
    const originalPrepare = runtime.prepare;
    runtime.prepare = async (...args) => {
      prepared = true;
      return originalPrepare(...args);
    };

    await expect(
      runPipeline({
        runtimeId: profile.runtime,
        requestedModel: '',
        profile,
        taskPath,
        yuureiVersion: '0.0.1',
        yuureiDir: workDir,
        isolationStrategy: 'level1',
        keep: false,
        seedRepo,
        resolveRuntime: () => runtime,
      }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    expect(prepared).toBe(false);
  });

  it('does not seed untracked or ignored files', async () => {
    const seedRepo = await freshRepo({ 'a.txt': 'same\n', '.gitignore': 'ignored.txt\n' });
    await writeFile(join(seedRepo, 'untracked.txt'), 'u\n');
    await writeFile(join(seedRepo, 'ignored.txt'), 'i\n');
    let observed: string[] = [];
    const runtime = makeWorkspaceRuntime('fake-seeded-runtime', async (workspaceDir) => {
      observed = await readdir(workspaceDir);
    });

    await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      seedRepo,
      resolveRuntime: () => runtime,
    });

    expect(observed.sort()).toEqual(['.gitignore', 'a.txt']);
  });

  it('keeps empty-workspace runs unchanged: inputs_version 1, empty-base patch', async () => {
    const runtime = makeWorkspaceRuntime('fake-seeded-runtime', async (workspaceDir) => {
      await writeFile(join(workspaceDir, 'made.txt'), 'made\n');
    });

    const { runDir, trace } = await runPipeline({
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1',
      keep: false,
      resolveRuntime: () => runtime,
    });

    expect(trace.requested_cell.inputs_version).toBe(1);
    expect(trace.seed).toBeUndefined();
    expect(trace.patch).toEqual({ base: 'empty', state: 'complete' });
    expect(await pathExists(join(runDir, 'baseline-manifest.json'))).toBe(false);
    expect(await pathExists(join(runDir, 'changes.json'))).toBe(false);
    const patch = await readFile(join(runDir, 'patch.diff'), 'utf8');
    expect(patch).toContain('--- /dev/null\n+++ made.txt\n');
  });
});
