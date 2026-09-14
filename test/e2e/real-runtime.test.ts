import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupFixtures,
  createFixtureProject,
  digestOf,
  runAndReadTrace,
} from '../harness/cli-fixture.js';

/**
 * The real-runtime connector. It drives the same harness as the fixture suite
 * with no shim, so the adapter launches the runtime actually installed on PATH.
 *
 * Skipped unless `YUUREI_E2E_REAL=1`, because CI has neither the runtimes nor
 * their credentials yet. This is the invocation mechanism and the fixtures; the
 * v0.5.0 milestone (#143, #144, #145) connects it to pinned runtime versions and
 * splits nightly from release-candidate runs. Waiting to design it until then
 * would have caused rework.
 */
const enabled = process.env['YUUREI_E2E_REAL'] === '1';

describe.skipIf(!enabled)('contract verification: real runtimes', () => {
  afterEach(cleanupFixtures);

  it.each([
    { runtime: 'claude-code', command: 'claude' },
    { runtime: 'codex', command: 'codex' },
    { runtime: 'opencode', command: 'opencode' },
  ])('runs $runtime end to end and records the requested-cell digest', async (runtime) => {
    const project = await createFixtureProject(runtime);

    const trace = await runAndReadTrace(project);

    expect(digestOf(trace)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(trace['schema_version']).toBe('0.3');
  });
});
