import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../../../src/run/pipeline.js';
import type { ResolvedCell } from '../../../src/cell/types.js';
import type { IsolationContext } from '../../../src/isolation/types.js';
import type { PreparedRun, Runtime } from '../../../src/runtime/types.js';

/**
 * Companion to `signal-hang.ts`, which covers a signal arriving during
 * `execute()`. Here the signal arrives while `prepare()` is still in flight:
 * the credential file is already on disk, but `prepare()` has not returned,
 * so the pipeline holds no `PreparedRun` yet.
 *
 * The real Codex adapter has exactly this window. It writes the bridged
 * auth.json, then reads it back and spawns `codex --version` before
 * returning, so an operator pressing Ctrl-C during run startup lands here.
 *
 * `keep` is true because that is what makes the residue observable: without
 * it, `dispose()` removes the whole isolation root and takes the credential
 * with it. Design doc §9.2 requires `--keep` to preserve config and logs but
 * never credential material.
 */
const workDir = await mkdtemp(join(tmpdir(), 'yuurei-prepare-fixture-'));
const taskPath = join(workDir, 'task.md');
await writeFile(taskPath, '# Task\n', 'utf8');

const markerPath = process.env['YUUREI_SIGNAL_MARKER'];
if (!markerPath) throw new Error('YUUREI_SIGNAL_MARKER env var is required');

const fake: Runtime = {
  id: () => 'fake-prepare-runtime',
  detect: async () => ({
    installed: true,
    version: null,
    executablePath: null,
    authUsable: null,
  }),
  prepare: async (_cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> => {
    const credentialPath = join(isolation.rootDir, 'bridged-credential.txt');
    await writeFile(credentialPath, 'secret\n', 'utf8');
    // The credential is on disk and the pipeline's signal handler is already
    // installed. This write is the test's cue that it is safe to signal.
    await writeFile(markerPath, `${credentialPath}\n`, 'utf8');
    // Stand in for the adapter work that follows the credential write
    // (reading the file back, spawning the runtime to detect its version).
    // prepare() never returns, so the signal lands with no PreparedRun.
    return new Promise<PreparedRun>(() => {});
  },
  execute: async () => {
    throw new Error('execute() must not be reached: the signal lands during prepare()');
  },
  normalize: async () => ({
    runtime: { id: 'fake-prepare-runtime', version: null },
    model: { requested: '', resolved: null },
    execution: { exitCode: 0, durationMs: 0 },
    usage: {},
  }),
};

setTimeout(() => {
  void runPipeline({
    runtimeId: 'fake-prepare-runtime',
    requestedModel: '',
    profile: {
      name: 'fake-prepare',
      runtime: 'fake-prepare-runtime',
      content: { profileYaml: { runtime: 'fake-prepare-runtime' }, configFiles: {} },
      digest: 'sha256:0000',
    },
    taskPath,
    yuureiVersion: '0.0.1',
    yuureiDir: workDir,
    isolationStrategy: 'level1',
    keep: true,
    resolveRuntime: () => fake,
  });
}, 0);

// Keeps the process alive until the test's signal lands; see signal-hang.ts.
setTimeout(() => {}, 60_000);
