import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/cli/doctor.js';

describe('yuurei doctor', () => {
  it('reports a detection entry for every registered runtime', async () => {
    const report = await runDoctor();

    const runtimeIds = report.runtimes.map((runtime) => runtime.runtimeId);
    expect(runtimeIds).toEqual(expect.arrayContaining(['claude-code', 'codex']));
    for (const runtime of report.runtimes) {
      expect(typeof runtime.installed).toBe('boolean');
    }
  });

  it('checks whether the output directory is writable', async () => {
    const report = await runDoctor();
    expect(typeof report.canWriteOutputDir).toBe('boolean');
  });
});
