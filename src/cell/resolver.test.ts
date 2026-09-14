import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../cli/exit-codes.js';
import { resolveCell, type CellResolutionInput } from './resolver.js';
import type { ResolvedProfile } from '../profile/types.js';

const RUNTIME = 'fake-runtime';
const CONTENT = { profileYaml: { runtime: RUNTIME }, configFiles: {} };

function makeProfile(name: string): ResolvedProfile {
  return { name, runtime: RUNTIME, content: CONTENT, digest: 'sha256:same-content' };
}

describe('resolveCell requested-cell identity', () => {
  let workDir: string;
  let taskA: string;
  let taskB: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-resolver-'));
    taskA = join(workDir, 'a.md');
    taskB = join(workDir, 'b.md');
    await writeFile(taskA, '# Task\n', 'utf8');
    await writeFile(taskB, '# Task\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function input(overrides: Partial<CellResolutionInput>): CellResolutionInput {
    return {
      runtimeId: RUNTIME,
      requestedModel: 'sonnet',
      profile: makeProfile('a'),
      taskPath: taskA,
      yuureiVersion: '0.0.1',
      isolationStrategy: 'level1',
      ...overrides,
    };
  }

  it('ignores the profile name and the task path, which are provenance not identity', async () => {
    const a = await resolveCell(input({ profile: makeProfile('a'), taskPath: taskA }));
    const b = await resolveCell(input({ profile: makeProfile('b'), taskPath: taskB }));

    expect(b.requestedCellDigest).toBe(a.requestedCellDigest);
    expect(a.resolvedProfile.name).toBe('a');
    expect(b.resolvedProfile.name).toBe('b');
    expect(a.resolvedTask.source).toBe(taskA);
    expect(b.resolvedTask.source).toBe(taskB);
  });

  it('changes the digest when the profile content digest changes', async () => {
    const a = await resolveCell(input({ profile: makeProfile('a') }));
    const b = await resolveCell(
      input({ profile: { ...makeProfile('a'), digest: 'sha256:different' } }),
    );

    expect(b.requestedCellDigest).not.toBe(a.requestedCellDigest);
  });

  it('changes the digest when the task content changes', async () => {
    await writeFile(taskB, '# A different task\n', 'utf8');

    const a = await resolveCell(input({ taskPath: taskA }));
    const b = await resolveCell(input({ taskPath: taskB }));

    expect(b.requestedCellDigest).not.toBe(a.requestedCellDigest);
  });

  it('rejects an execution option that JSON would silently rewrite', async () => {
    await expect(
      resolveCell(input({ executionOptions: { flag: undefined } })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    await expect(
      resolveCell(input({ executionOptions: { flag: Number.NaN } })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    await expect(
      resolveCell(input({ executionOptions: { flag: () => {} } })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('rejects execution options that are not plain JSON values', async () => {
    const rejected: unknown[] = [
      new Map([['a', 1]]),
      new Set([1]),
      new Date(),
      Buffer.from('x'),
      { toJSON: () => 1 },
      -0,
    ];
    for (const bad of rejected) {
      await expect(resolveCell(input({ executionOptions: { bad } }))).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFIG_ERROR,
      });
    }
  });

  it('rejects a cyclic execution option', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    await expect(resolveCell(input({ executionOptions: { cyclic } }))).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('rejects a missing task file as a configuration error', async () => {
    await expect(
      resolveCell(input({ taskPath: join(workDir, 'missing.md') })),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('accepts nested JSON-safe execution options', async () => {
    const a = await resolveCell(input({ executionOptions: { nested: { flag: true }, n: 1 } }));
    const b = await resolveCell(input({ executionOptions: { nested: { flag: true }, n: 1 } }));

    expect(b.requestedCellDigest).toBe(a.requestedCellDigest);
  });
});
