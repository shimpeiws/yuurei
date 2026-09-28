import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { createIsolation } from '../../src/isolation/index.js';
import { SOURCE_PROJECT_FILE_ENV, SOURCE_PROJECT_ID_ENV } from '../../src/observer/index.js';
import type { Isolation, IsolationReport } from '../../src/isolation/types.js';
import { pathExists } from '../../src/util/fs.js';
import { runPipeline } from '../../src/run/pipeline.js';
import type { ResolvedCell } from '../../src/cell/types.js';
import type { ResolvedProfile } from '../../src/profile/types.js';
import type {
  NormalizationContext,
  PreparedRun,
  RegisterCredentialPath,
  Runtime,
} from '../../src/runtime/types.js';

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

async function initSeedRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yuurei-srcid-repo-'));
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

/** One line the stub pfl (or the test's own seams) appends to the capture log. */
interface Capture {
  cmd: string;
  cwd?: string;
  sourceProjectId?: string | null;
  contract?: {
    version: number;
    issuer: string;
    cell_id: string;
    source_project: { id: string; kind: string; remote?: string; source: string; head: string };
  } | null;
  workspace?: string[];
}

/**
 * A real stub `pfl` executable — a Node script the pipeline spawns as a
 * separate process, exactly like the real observer. It appends one JSON
 * capture per invocation (cmd, cwd, the declared source-project env var and
 * contract file contents, the workspace listing) to `logPath`, then answers
 * `inspect`/`export` with valid envelopes. `inspectExit` lets a test make
 * inspect fail.
 */
function stubPflScript(logPath: string, inspectExit: number = 0): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cmd = args[0];
const arg = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const LOG = ${JSON.stringify(logPath)};
const contractPath = process.env[${JSON.stringify(SOURCE_PROJECT_FILE_ENV)}] ?? null;
fs.appendFileSync(LOG, JSON.stringify({
  cmd,
  cwd: process.cwd(),
  sourceProjectId: process.env[${JSON.stringify(SOURCE_PROJECT_ID_ENV)}] ?? null,
  contract:
    contractPath !== null && fs.existsSync(contractPath)
      ? JSON.parse(fs.readFileSync(contractPath, 'utf8'))
      : null,
  workspace: fs.readdirSync(process.cwd()).sort(),
}) + '\\n');
if (cmd === 'inspect') {
  if (${inspectExit} !== 0) process.exit(${inspectExit});
  process.stdout.write(JSON.stringify({
    pflVersion: '9.9.9-stub',
    command: 'inspect',
    ok: true,
    completeness: 'complete',
    diagnostics: [],
    data: {
      runtime: 'fake-srcid-runtime',
      runtimeVersion: null,
      runtimeCompatibility: 'unverified',
      project: 'stub',
      store: '/tmp/.pfl',
      observed: {
        snapshotId: 'obs_stub',
        elements: 0,
        opaqueLayers: 0,
        completeness: 'complete',
        cellId: arg('--cell-id'),
      },
      resolved: {
        snapshotId: 'res_stub',
        effective: 0,
        conditional: 0,
        shadowed: 0,
        confidence: 'high',
      },
    },
  }));
  process.exit(0);
}
if (cmd === 'export') {
  const out = arg('--out');
  const bundle = arg('--bundle');
  const snap = arg('--snapshot');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, snap + '.json'), '{"stub":true}');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'harness.json'), '{}');
  fs.writeFileSync(path.join(bundle, 'manifest.json'), '{}');
  process.stdout.write(JSON.stringify({
    pflVersion: '9.9.9-stub',
    command: 'export',
    ok: true,
    completeness: 'complete',
    diagnostics: [],
    data: {},
  }));
  process.exit(0);
}
process.exit(2);
`;
}

/**
 * A fake runtime whose execute() appends an `execute` marker to the capture
 * log — its position after the observer's entries proves the ordering.
 */
function makeRuntime(id: string, logPath: string): Runtime {
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
      isolation,
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
      const { appendFile, writeFile: wf } = await import('node:fs/promises');
      await appendFile(logPath, JSON.stringify({ cmd: 'execute' }) + '\n');
      const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
      const stderrPath = join(run.isolation.rootDir, 'stderr.log');
      await wf(stdoutPath, '', 'utf8');
      await wf(stderrPath, '', 'utf8');
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

/** Wraps the real level1 isolation to append a `verify` marker for ordering. */
function verifyingIsolation(logPath: string, fail: boolean): () => Isolation {
  return () => {
    const inner = createIsolation('level1');
    return {
      create: (cell) => inner.create(cell),
      verify: async (context): Promise<IsolationReport> => {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(logPath, JSON.stringify({ cmd: 'verify' }) + '\n');
        if (fail) {
          return {
            verified: false,
            strategy: context.strategy,
            checkedAt: new Date().toISOString(),
            findings: ['deliberate verify failure for the ordering test'],
          };
        }
        return inner.verify(context);
      },
      dispose: (context) => inner.dispose(context),
    };
  };
}

const profile: ResolvedProfile = {
  name: 'srcid-test',
  runtime: 'fake-srcid-runtime',
  content: { profileYaml: { runtime: 'fake-srcid-runtime' }, configFiles: {} },
  digest: 'sha256:0000',
};

describe('source-project identity hand-off (#214)', () => {
  let workDir: string;
  let taskPath: string;
  let logPath: string;
  let stubPath: string;
  const repos: string[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-srcid-test-'));
    taskPath = join(workDir, 'task.md');
    await writeFile(taskPath, '# Task\n\nChange things.\n', 'utf8');
    logPath = join(workDir, 'pfl-capture.jsonl');
    stubPath = join(workDir, 'pfl-stub.cjs');
  });

  afterEach(async () => {
    for (const repo of repos.splice(0)) await rm(repo, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  async function freshRepo(files: Record<string, string>): Promise<string> {
    const repo = await initSeedRepo(files);
    repos.push(repo);
    return repo;
  }

  async function writeStub(inspectExit = 0): Promise<void> {
    await writeFile(stubPath, stubPflScript(logPath, inspectExit), 'utf8');
    await chmod(stubPath, 0o755);
    await writeFile(
      join(workDir, 'yuurei.yaml'),
      `version: 1\nprofiles: {}\nruns: {}\nobserver:\n  pfl_path: ${JSON.stringify(stubPath)}\n`,
      'utf8',
    );
  }

  async function readCaptures(): Promise<Capture[]> {
    const text = await readFile(logPath, 'utf8');
    return text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Capture);
  }

  function baseInput(seedRepo: string | undefined, failVerify: boolean) {
    return {
      runtimeId: profile.runtime,
      requestedModel: '',
      profile,
      taskPath,
      yuureiVersion: '0.0.1',
      yuureiDir: workDir,
      isolationStrategy: 'level1' as const,
      keep: false,
      observe: true,
      ...(seedRepo !== undefined ? { seedRepo } : {}),
      resolveRuntime: () => makeRuntime('fake-srcid-runtime', logPath),
      createIsolation: verifyingIsolation(logPath, failVerify),
    };
  }

  it('declares the same source-project identity to two cells of one source, with distinct cell_id', async () => {
    const seedRepo = await freshRepo({ 'seeded.txt': 'seed\n' });
    await writeStub();

    const first = await runPipeline(baseInput(seedRepo, false));
    const second = await runPipeline(baseInput(seedRepo, false));

    expect(first.trace.seed?.source_project).toBeDefined();
    expect(second.trace.seed?.source_project?.id).toBe(first.trace.seed?.source_project?.id);
    expect(first.trace.cell_id).not.toBe(second.trace.cell_id);

    // The observer actually received the declared identity inside each cell,
    // before runtime execution: both inspect calls carry the env var and a
    // contract file bound to that cell's own cell_id.
    const captures = await readCaptures();
    const inspects = captures.filter((c) => c.cmd === 'inspect');
    expect(inspects).toHaveLength(2);
    for (const [index, run] of [first, second].entries()) {
      const inspect = inspects[index];
      expect(inspect?.sourceProjectId).toBe(run.trace.seed?.source_project?.id);
      expect(inspect?.contract?.version).toBe(1);
      expect(inspect?.contract?.issuer).toBe('yuurei');
      expect(inspect?.contract?.cell_id).toBe(run.trace.cell_id);
      expect(inspect?.contract?.source_project.id).toBe(run.trace.seed?.source_project?.id);
      // The observer saw the materialized workspace, not the contract file.
      expect(inspect?.workspace).toEqual(['seeded.txt']);
    }

    // Ordering, per run: verify → inspect → export → execute.
    const cmds = captures.map((c) => c.cmd);
    const firstRun = cmds.slice(0, 4);
    const secondRun = cmds.slice(4, 8);
    expect(firstRun).toEqual(['verify', 'inspect', 'export', 'execute']);
    expect(secondRun).toEqual(['verify', 'inspect', 'export', 'execute']);

    // The observation was retained and recorded.
    expect(first.trace.observation?.status).toBe('recorded');
    expect(await pathExists(join(first.runDir, 'observation', 'export.json'))).toBe(true);

    // The declaration is also in the durable baseline manifest.
    const manifest = JSON.parse(
      await readFile(join(first.runDir, 'baseline-manifest.json'), 'utf8'),
    ) as { source_project?: { id: string } };
    expect(manifest.source_project?.id).toBe(first.trace.seed?.source_project?.id);
  });

  it('keeps different source projects distinguishable', async () => {
    const repoA = await freshRepo({ 'a.txt': 'a\n' });
    const repoB = await freshRepo({ 'b.txt': 'b\n' });
    await writeStub();

    const runA = await runPipeline(baseInput(repoA, false));
    const runB = await runPipeline(baseInput(repoB, false));

    expect(runA.trace.seed?.source_project?.id).toBeDefined();
    expect(runB.trace.seed?.source_project?.id).toBeDefined();
    expect(runA.trace.seed?.source_project?.id).not.toBe(runB.trace.seed?.source_project?.id);
  });

  it('declares nothing on an unseeded run — no env var, no contract, no trace field', async () => {
    await writeStub();

    const { trace } = await runPipeline(baseInput(undefined, false));

    expect(trace.seed).toBeUndefined();
    const inspects = (await readCaptures()).filter((c) => c.cmd === 'inspect');
    expect(inspects).toHaveLength(1);
    expect(inspects[0]?.sourceProjectId).toBeNull();
    expect(inspects[0]?.contract).toBeNull();
    // Empty workspace: the observer saw nothing materialized.
    expect(inspects[0]?.workspace).toEqual([]);
    expect(trace.observation?.status).toBe('recorded');
  });

  it('records observer failure as unavailable without blocking execution', async () => {
    const seedRepo = await freshRepo({ 'seeded.txt': 'seed\n' });
    await writeStub(7);

    const { trace } = await runPipeline(baseInput(seedRepo, false));

    expect(trace.observation?.status).toBe('unavailable');
    expect(trace.observation?.reason).toBe('inspect-failed');
    // Observer failure ≠ isolation failure: the runtime still ran.
    expect(trace.execution.exit_code).toBe(0);
  });

  it('never runs the observer when isolation verification fails', async () => {
    const seedRepo = await freshRepo({ 'seeded.txt': 'seed\n' });
    await writeStub();

    await expect(runPipeline(baseInput(seedRepo, true))).rejects.toMatchObject({
      exitCode: EXIT_CODES.ISOLATION_VERIFICATION_FAILED,
    });
    // The stub was never spawned: the capture log holds only the verify
    // marker the wrapped isolation wrote, and the pipeline threw before any
    // trace existed to read.
    const captures = await readCaptures();
    expect(captures.map((c) => c.cmd)).toEqual(['verify']);
    const entries = await import('node:fs/promises').then((fs) =>
      fs.readdir(join(workDir, 'runs')).catch(() => [] as string[]),
    );
    expect(entries).toEqual([]);
  });
});
