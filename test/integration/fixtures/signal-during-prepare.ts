import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../../../src/run/pipeline.js';
import type { ResolvedCell } from '../../../src/cell/types.js';
import type { IsolationContext } from '../../../src/isolation/types.js';
import type { PreparedRun, RegisterCredentialPath, Runtime } from '../../../src/runtime/types.js';

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
 * The credential path is registered with the pipeline BEFORE the write (the
 * #55 fix: the scrub list is populated by the write, not prepare()'s return).
 * So on the signal the file is scrubbed precisely and the isolation root
 * survives under `--keep` for debugging — matching §9.2, which preserves
 * config and logs but never credential material.
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
  prepare: async (
    _cell: ResolvedCell,
    isolation: IsolationContext,
    registerCredentialPath: RegisterCredentialPath,
  ): Promise<PreparedRun> => {
    const credentialPath = join(isolation.rootDir, 'bridged-credential.txt');
    registerCredentialPath(credentialPath);
    await writeFile(credentialPath, 'secret\n', 'utf8');
    // The credential is on disk and the pipeline's signal handler is already
    // installed. This write is the test's cue that it is safe to signal. Both
    // paths are reported so the test never has to derive one from the other.
    await writeFile(
      markerPath,
      JSON.stringify({
        rootDir: isolation.rootDir,
        credentialPath,
        runsDir: join(workDir, 'runs'),
      }),
      'utf8',
    );
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
    execution: { exitCode: 0, signal: null, durationMs: 0 },
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
