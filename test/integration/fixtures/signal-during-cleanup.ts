import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../../../src/run/pipeline.js';
import { Level1Isolation } from '../../../src/isolation/level1.js';
import type { ResolvedCell } from '../../../src/cell/types.js';
import type { Isolation, IsolationContext } from '../../../src/isolation/types.js';
import type { PreparedRun, Runtime } from '../../../src/runtime/types.js';

/**
 * Barrier fixture for the shared-cleanup regression test (#110): the run
 * completes normally, and the pipeline's finally block enters cleanup. The
 * isolation's dispose() then blocks on a barrier file owned by the test, so
 * the lifecycle is provably in flight when the test sends its signal. The
 * signal handler joins that same memoized lifecycle; the process must not
 * exit until the test releases the barrier.
 *
 * requireTempEnv() makes the fixture fail loudly (rather than exit 0) when a
 * required control-path env var is missing.
 */
function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
}

const workDir = await mkdtemp(join(tmpdir(), 'yuurei-cleanup-fixture-'));
const taskPath = join(workDir, 'task.md');
await writeFile(taskPath, '# Task\n', 'utf8');

const disposeEnteredPath = requireEnvVar('YUUREI_DISPOSE_ENTERED');
const disposeDonePath = requireEnvVar('YUUREI_DISPOSE_DONE');
const releasePath = requireEnvVar('YUUREI_CLEANUP_RELEASE');

const realIsolation = new Level1Isolation();
const instrumented: Isolation = {
  create: (cell) => realIsolation.create(cell),
  verify: (context) => realIsolation.verify(context),
  dispose: async (context: IsolationContext) => {
    // Signal that the lifecycle has reached the blocking dispose step. The
    // pipeline's finally block is awaiting us, and the signal handler is
    // still installed.
    await writeFile(disposeEnteredPath, 'entered', 'utf8');
    // Block until the test releases the barrier. This is what proves the
    // handler cannot preempt: process.exit() must wait here.
    for (;;) {
      try {
        await access(releasePath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await writeFile(disposeDonePath, 'done', 'utf8');
    await realIsolation.dispose(context);
  },
};

const NOW = new Date().toISOString();

const fake: Runtime = {
  id: () => 'fake-cleanup-runtime',
  detect: async () => ({
    installed: true,
    version: null,
    executablePath: null,
    authUsable: null,
  }),
  prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => ({
    runtimeId: 'fake-cleanup-runtime',
    command: 'true',
    args: [],
    env: {},
    cwd: isolation.rootDir,
    isolation,
    cell,
    runtimeVersion: null,
    credentialValuesToRedact: [],
  }),
  execute: async (run: PreparedRun) => {
    const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
    const stderrPath = join(run.isolation.rootDir, 'stderr.log');
    await writeFile(stdoutPath, '', 'utf8');
    await writeFile(stderrPath, '', 'utf8');
    return {
      exitCode: 0,
      signal: null,
      startedAt: NOW,
      finishedAt: NOW,
      stdoutPath,
      stderrPath,
      timedOut: false,
    };
  },
  normalize: async () => ({
    runtime: { id: 'fake-cleanup-runtime', version: null },
    model: { requested: '', resolved: null },
    execution: { exitCode: 0, signal: null, durationMs: 0 },
    usage: {},
  }),
};

setTimeout(() => {
  void runPipeline({
    runtimeId: 'fake-cleanup-runtime',
    requestedModel: '',
    profile: {
      name: 'fake-cleanup',
      runtime: 'fake-cleanup-runtime',
      content: { profileYaml: { runtime: 'fake-cleanup-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    },
    taskPath,
    yuureiVersion: '0.0.1',
    yuureiDir: workDir,
    isolationStrategy: 'level1',
    keep: false,
    resolveRuntime: () => fake,
    createIsolation: () => instrumented,
  });
}, 0);

// A never-resolving promise does not keep the process alive on its own; a
// long timer keeps the process up until the test's signal lands.
setTimeout(() => {}, 60_000);
