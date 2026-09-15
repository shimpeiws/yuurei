import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupFixtures,
  createFixtureProject,
  digestOf,
  runAndReadTrace,
  writeRunConfig,
} from '../harness/cli-fixture.js';
import type { FixtureProject, TraceRecord } from '../harness/cli-fixture.js';

// A real model call takes far longer than the 5s default; give each case room
// for a cold-start CLI plus a short completion.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

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

/**
 * Runs a real runtime and returns its trace, failing with the run's stderr,
 * resolved model and diagnostics when the runtime exited non-zero. Without
 * this, a failing real run only shows `exit_code: 1` and the cause (in the
 * run's stderr.log, which cleanup removes) is lost.
 */
async function runReal(project: FixtureProject, runtime: RuntimeCase): Promise<TraceRecord> {
  const trace = await runAndReadTrace(project);
  const execution = trace['execution'] as { exit_code?: number | null } | undefined;
  if (execution?.exit_code !== 0) {
    const stderr = await readFile(
      join(project.root, '.yuurei', 'runs', String(trace['run_id']), 'stderr.log'),
      'utf8',
    ).catch(() => '(no stderr.log)');
    throw new Error(
      `${runtime.runtime} exited ${String(execution?.exit_code)}; ` +
        `model=${JSON.stringify(trace['model'])}; ` +
        `diagnostics=${JSON.stringify(trace['diagnostics'])}; stderr:\n${stderr}`,
    );
  }
  return trace;
}

describe.skipIf(!enabled)('contract verification: real runtimes', () => {
  afterEach(cleanupFixtures);

  it.each(RUNTIMES)('runs $runtime end to end and records the run', async (runtime) => {
    const project = await createFixtureProject(runtime);
    if (runtime.model) await writeRunConfig(project.root, runtime, { model: runtime.model });

    const trace = await runReal(project, runtime);

    expect(trace['runtime']).toMatchObject({ id: runtime.runtime });
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
