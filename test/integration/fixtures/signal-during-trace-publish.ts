import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../../../src/run/pipeline.js';
import type { ResolvedCell } from '../../../src/cell/types.js';
import type { IsolationContext } from '../../../src/isolation/types.js';
import type { PreparedRun, Runtime } from '../../../src/runtime/types.js';

/**
 * Barrier fixture for the published-trace-during-interruption race (#258,
 * Devin Review): the run completes, and the trace publication is held open
 * inside the pipeline's tracked publish op — the exact moment a signal
 * could otherwise interleave trace.json's rename with the interrupted
 * prune and leave a "complete" marker over deleted outputs.
 *
 * The test waits for the hold-entered marker (proving the publish op is in
 * flight), sends its signal, confirms the child stays alive (the cleanup's
 * drain is waiting on the held op), then releases the barrier. The retained
 * directory must then be the complete record, never a pruned one.
 */
function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
}

const workDir = await mkdtemp(join(tmpdir(), 'yuurei-trace-publish-fixture-'));
const taskPath = join(workDir, 'task.md');
await writeFile(taskPath, '# Task\n', 'utf8');

const markerPath = requireEnvVar('YUUREI_SIGNAL_MARKER');
const holdEnteredPath = requireEnvVar('YUUREI_TRACE_HOLD_ENTERED');
const releasePath = requireEnvVar('YUUREI_TRACE_HOLD_RELEASE');

const NOW = new Date().toISOString();

const fake: Runtime = {
  id: () => 'fake-trace-publish-runtime',
  detect: async () => ({
    installed: true,
    version: null,
    executablePath: null,
    authUsable: null,
  }),
  prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => {
    // The signal handler is installed before prepare() runs; the marker is
    // the test's cue that a signal can be sent safely.
    await writeFile(markerPath, JSON.stringify({ runsDir: join(workDir, 'runs') }), 'utf8');
    return {
      runtimeId: 'fake-trace-publish-runtime',
      command: 'true',
      args: [],
      env: {},
      cwd: isolation.rootDir,
      isolation,
      cell,
      runtimeVersion: null,
      credentialValuesToRedact: [],
    };
  },
  execute: async (run: PreparedRun) => {
    const stdoutPath = join(run.isolation.rootDir, 'stdout.log');
    const stderrPath = join(run.isolation.rootDir, 'stderr.log');
    await writeFile(stdoutPath, 'out\n', 'utf8');
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
    runtime: { id: 'fake-trace-publish-runtime', version: null },
    model: { requested: '', resolved: null },
    execution: { exitCode: 0, signal: null, durationMs: 0 },
    usage: {},
  }),
};

setTimeout(() => {
  void runPipeline({
    runtimeId: 'fake-trace-publish-runtime',
    requestedModel: '',
    profile: {
      name: 'fake-trace-publish',
      runtime: 'fake-trace-publish-runtime',
      content: { profileYaml: { runtime: 'fake-trace-publish-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    },
    taskPath,
    yuureiVersion: '0.0.1',
    yuureiDir: workDir,
    isolationStrategy: 'level1',
    keep: false,
    resolveRuntime: () => fake,
    holdTracePublish: async () => {
      // The publish op is now in flight and tracked — holding here is the
      // window where an interrupted prune could interleave with the trace
      // rename. The drain must wait for this op before pruning.
      await writeFile(holdEnteredPath, 'entered', 'utf8');
      for (;;) {
        try {
          await access(releasePath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    },
  });
}, 0);

// A never-resolving promise does not keep the process alive on its own; a
// long timer keeps the process up until the test's signal lands.
setTimeout(() => {}, 60_000);
