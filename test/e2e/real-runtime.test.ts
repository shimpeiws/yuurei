import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupFixtures,
  createFixtureProject,
  digestOf,
  runAndReadTrace,
  writeRunConfig,
} from '../harness/cli-fixture.js';

/**
 * The real-runtime connector. It drives the same harness as the fixture suite
 * with no shim, so the adapter launches the runtime actually installed on PATH.
 *
 * Skipped unless `YUUREI_E2E_REAL=1`. The nightly and release-candidate
 * workflows set it and install pinned runtime versions (ADR-0017); a pull
 * request leaves it unset and runs the fake suite only.
 *
 * Models are pinned cheap so a run costs a fraction of a cent, and are
 * overridable per workflow so the exercised set can move without editing this
 * file. The assertions stay on what the runtime must produce regardless of its
 * output text: identity, exit, and the requested-cell digest.
 */
const enabled = process.env['YUUREI_E2E_REAL'] === '1';

interface RuntimeCase {
  runtime: string;
  command: string;
  model: string;
}

const RUNTIMES: RuntimeCase[] = [
  {
    runtime: 'claude-code',
    command: 'claude',
    model: process.env['YUUREI_E2E_CLAUDE_MODEL'] ?? 'haiku',
  },
  {
    runtime: 'codex',
    command: 'codex',
    model: process.env['YUUREI_E2E_CODEX_MODEL'] ?? 'gpt-5.4-mini',
  },
  {
    runtime: 'opencode',
    command: 'opencode',
    model: process.env['YUUREI_E2E_OPENCODE_MODEL'] ?? 'openai/gpt-5.4-mini',
  },
];

describe.skipIf(!enabled)('contract verification: real runtimes', () => {
  afterEach(cleanupFixtures);

  it.each(RUNTIMES)('runs $runtime end to end and records the run', async (runtime) => {
    const project = await createFixtureProject(runtime);
    if (runtime.model) await writeRunConfig(project.root, runtime, { model: runtime.model });

    const trace = await runAndReadTrace(project);

    expect(trace['runtime']).toMatchObject({ id: runtime.runtime });
    expect(trace['execution']).toMatchObject({ exit_code: 0, timed_out: false });
    expect(trace['requested_cell']).toMatchObject({ inputs_version: 1 });
    expect(digestOf(trace)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(trace['schema_version']).toBe('0.3');
  });

  it.each(RUNTIMES)('leaves patch.diff and workspace/ for $runtime', async (runtime) => {
    const project = await createFixtureProject(runtime);
    if (runtime.model) await writeRunConfig(project.root, runtime, { model: runtime.model });

    const trace = await runAndReadTrace(project);

    // The run produces a patch (empty when the agent wrote nothing) and the
    // artifact manifest lists it; this exercises the v0.4.0 seam against a real
    // runtime rather than a fixture.
    expect(trace['artifacts']).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'patch.diff', kind: 'patch' })]),
    );
  });
});
