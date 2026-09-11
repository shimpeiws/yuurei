import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../../../src/run/pipeline.js';
import type { ResolvedCell } from '../../../src/cell/types.js';
import type { IsolationContext } from '../../../src/isolation/types.js';
import type { PreparedRun, Runtime } from '../../../src/runtime/types.js';

/**
 * Fixture for the signal-cleanup integration test: runs the real pipeline
 * with a fake runtime whose execute() never resolves (so the process stays
 * alive until the test sends it a signal). prepare() writes the isolation
 * root directory into the marker file named by $YUUREI_SIGNAL_MARKER right
 * after the pipeline has installed its signal handler and written the
 * credential file — a synchronous file write, so by the time the test sees
 * the marker, the handler is guaranteed to be installed and the test can
 * safely send its signal.
 *
 * The pipeline is started from a setTimeout rather than a top-level await:
 * an unresolved top-level await makes Node treat the process as stuck and
 * kill it (exit 13) before a signal can reach the handler, which would mask
 * the exact cleanup-under-signal behavior this fixture exists to exercise.
 */
const workDir = await mkdtemp(join(tmpdir(), 'yuurei-signal-fixture-'));
const taskPath = join(workDir, 'task.md');
await writeFile(taskPath, '# Task\n', 'utf8');

const markerPath = process.env['YUUREI_SIGNAL_MARKER'];
if (!markerPath) throw new Error('YUUREI_SIGNAL_MARKER env var is required');

let fake: Runtime = undefined as unknown as Runtime;

fake = {
  id: () => 'fake-signal-runtime',
  detect: async () => ({
    installed: true,
    version: null,
    executablePath: null,
    authUsable: null,
  }),
  prepare: async (cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => {
    const rootDir = isolation.rootDir;
    const credentialPath = join(rootDir, 'bridged-credential.txt');
    await writeFile(credentialPath, 'secret\n', 'utf8');
    // Signal handler is installed by the pipeline before prepare() runs; the
    // credential file now exists on disk. This synchronous write is the
    // test's cue that it is safe to send the signal.
    await writeFile(
      markerPath,
      JSON.stringify({ rootDir, runsDir: join(workDir, 'runs') }),
      'utf8',
    );
    return {
      runtimeId: 'fake-signal-runtime',
      command: 'true',
      args: [],
      env: {},
      cwd: rootDir,
      isolation,
      cell,
      runtimeVersion: null,
      credentialFilePaths: [credentialPath],
      credentialValuesToRedact: [],
    };
  },
  execute: async () => new Promise(() => {}),
  normalize: async () => ({
    runtime: { id: 'fake-signal-runtime', version: null },
    model: { requested: '', resolved: null },
    execution: { exitCode: 0, signal: null, durationMs: 0 },
    usage: {},
  }),
};

setTimeout(() => {
  // Signal arrives during execute(), after prepare() has already written the
  // credential file — the exact window the signal handler exists to cover.
  void runPipeline({
    runtimeId: 'fake-signal-runtime',
    requestedModel: '',
    profile: {
      name: 'fake-signal',
      runtime: 'fake-signal-runtime',
      content: { profileYaml: { runtime: 'fake-signal-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    },
    taskPath,
    yuureiVersion: '0.0.1',
    yuureiDir: workDir,
    isolationStrategy: 'level1',
    keep: false,
    resolveRuntime: () => fake,
  });
}, 0);

// A never-resolving promise does not keep the process alive on its own —
// Node's idle detection sees no pending timer/I/O once the setTimeout
// callback returns and would exit 0 before the signal arrives. A long timer
// keeps the process up until the test's signal lands.
setTimeout(() => {}, 60_000);
