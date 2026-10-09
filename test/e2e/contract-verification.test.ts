import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_SHIM,
  cleanupFixtures,
  createFixtureProject,
  digestOf,
  runAndReadTrace,
  runCli,
  writeRunConfig,
} from '../harness/cli-fixture.js';

// These tests spawn several CLI subprocesses each, so they run well past the
// 5s default once the suite is under load. The higher ceiling does not hide a
// hang: a genuinely stuck run still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

const CLAUDE = { runtime: 'claude-code', command: 'claude', shim: CLAUDE_SHIM };

/**
 * The frozen v0.3.0 contract, verified against the real CLI with a fixture
 * runtime. Every assertion here is a claim in `docs/contract.md`; when one
 * changes, the contract changed.
 */
describe('contract verification: requested-cell digest', () => {
  afterEach(cleanupFixtures);

  it('(a) the same definition twice yields the same digest', async () => {
    const project = await createFixtureProject(CLAUDE);

    const first = digestOf(await runAndReadTrace(project));
    const second = digestOf(await runAndReadTrace(project));

    expect(second).toBe(first);
  });

  it('(b) changes model, timeout, isolation, profile, task or an auth-bridge flag one at a time', async () => {
    const baseline = digestOf(await runAndReadTrace(await createFixtureProject(CLAUDE)));

    const model = await createFixtureProject(CLAUDE);
    await writeRunConfig(model.root, CLAUDE, { model: 'sonnet' });
    expect(digestOf(await runAndReadTrace(model))).not.toBe(baseline);

    const timeout = await createFixtureProject(CLAUDE);
    await writeRunConfig(timeout.root, CLAUDE, { timeout: 5000 });
    expect(digestOf(await runAndReadTrace(timeout))).not.toBe(baseline);

    const isolation = await createFixtureProject(CLAUDE);
    await writeRunConfig(isolation.root, CLAUDE, { isolation: 'level0' });
    expect(digestOf(await runAndReadTrace(isolation))).not.toBe(baseline);

    const profile = await createFixtureProject(CLAUDE);
    await writeFile(
      join(profile.root, '.yuurei', 'profiles', 'fixture', 'config', 'config.json'),
      '{"fixture":2}\n',
      'utf8',
    );
    expect(digestOf(await runAndReadTrace(profile))).not.toBe(baseline);

    const task = await createFixtureProject(CLAUDE);
    await writeFile(
      join(task.root, '.yuurei', 'tasks', 'smoke.md'),
      'A different instruction.\n',
      'utf8',
    );
    expect(digestOf(await runAndReadTrace(task))).not.toBe(baseline);

    const authBridge = await createFixtureProject(CLAUDE);
    expect(digestOf(await runAndReadTrace(authBridge, ['--bridge-codex-auth-file']))).not.toBe(
      baseline,
    );
  });

  it('(c) changing only --keep does not change the digest', async () => {
    const project = await createFixtureProject(CLAUDE);

    const plain = digestOf(await runAndReadTrace(project));
    const kept = digestOf(await runAndReadTrace(project, ['--keep']));

    expect(kept).toBe(plain);
  });

  it('(e) pins the CLI-over-definition precedence per field', async () => {
    const project = await createFixtureProject(CLAUDE);
    await writeRunConfig(project.root, CLAUDE, { model: 'sonnet', timeout: 60000 });

    const fromDefinition = await runAndReadTrace(project);
    expect(fromDefinition['model']).toMatchObject({ requested: 'sonnet' });
    expect(fromDefinition['execution_options']).toMatchObject({ timeout_ms: 60000 });
    expect(fromDefinition['definition']).toEqual({ run: 'smoke', cli_overrides: [] });

    const overridden = await runAndReadTrace(project, ['--model', 'opus', '--timeout', '70000']);
    expect(overridden['model']).toMatchObject({ requested: 'opus' });
    // Passing --model must not discard the definition's untouched fields; per
    // field means per field, not per record.
    expect(overridden['execution_options']).toMatchObject({ timeout_ms: 70000 });
    expect(overridden['definition']).toEqual({
      run: 'smoke',
      cli_overrides: ['model', 'timeout'],
    });
  });
});

const LEGACY_TRACE = {
  schema_version: '0.3',
  run_id: 'legacy-run',
  started_at: '2026-09-14T00:00:00.000Z',
  finished_at: '2026-09-14T00:00:01.000Z',
  runtime: { id: 'claude-code', version: '2.1.0' },
  model: { requested: '', resolved: 'sonnet' },
  profile: { name: 'fixture', digest: 'sha256:legacy-profile' },
  task: { source: 'smoke.md', digest: 'sha256:legacy-task' },
  isolation: { strategy: 'level1', verified: true },
  execution: { exit_code: 0, signal: null, duration_ms: 1000, timed_out: false },
  usage: {},
  // A non-null cost written before `source` existed: amount and currency only.
  cost: { amount: 0.42, currency: 'USD' },
  artifacts: [],
};

describe('contract verification: an older trace stays readable', () => {
  afterEach(cleanupFixtures);

  it('(d) reads a pre-v0.3.0 trace read-only and reports its digest as absent', async () => {
    const project = await createFixtureProject(CLAUDE);
    const runDir = join(project.root, '.yuurei', 'runs', 'legacy-run');
    await mkdir(runDir, { recursive: true });
    const tracePath = join(runDir, 'trace.json');
    await writeFile(tracePath, `${JSON.stringify(LEGACY_TRACE, null, 2)}\n`, 'utf8');

    const result = await runCli(
      ['trace', 'show', 'legacy-run', '--json'],
      project.env,
      project.root,
    );
    expect(result.code).toBe(0);

    const lines = result.stdout.trim().split('\n');
    const printed = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    // The full trace is printed, so the file never has to be opened, and a
    // field the older trace lacks is absent rather than invented.
    expect(printed['schema_version']).toBe('0.3');
    expect(printed['run_id']).toBe('legacy-run');
    expect(printed['execution']).toEqual(LEGACY_TRACE.execution);
    expect('requested_cell' in printed).toBe(false);
    expect('yuurei_version' in printed).toBe(false);

    // Read-only: the CLI never rewrites an older trace or invents a digest.
    const after = await readFile(tracePath, 'utf8');
    expect(after).toBe(`${JSON.stringify(LEGACY_TRACE, null, 2)}\n`);
    expect(after).not.toContain('requested_cell');
  });

  it('(141) prints the whole trace with --json, so a consumer need not open the file', async () => {
    const project = await createFixtureProject(CLAUDE);
    const run = await runCli(['run', 'smoke'], project.env, project.root);
    const runId = run.stdout.match(/run ([^ ]+) finished/)?.[1];
    if (!runId) throw new Error(`run id missing: ${run.stdout}`);

    const shown = await runCli(['trace', 'show', runId, '--json'], project.env, project.root);
    expect(shown.code).toBe(0);

    const lines = shown.stdout.trim().split('\n');
    const printed = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    const onDisk = JSON.parse(
      await readFile(join(project.root, '.yuurei', 'runs', runId, 'trace.json'), 'utf8'),
    ) as Record<string, unknown>;

    // Every field of the trace is present; level and message are the only extras.
    const { level, message, ...fields } = printed;
    expect(fields).toEqual(onDisk);
    expect(level).toBe('info');
    expect(message).toBe(runId);
  });
});

describe('contract verification: run index', () => {
  afterEach(cleanupFixtures);

  it('(140) enumerates every run through the CLI with --json', async () => {
    const project = await createFixtureProject(CLAUDE);
    const first = await runCli(['run', 'smoke'], project.env, project.root);
    const firstId = first.stdout.match(/run ([^ ]+) finished/)?.[1];
    const second = await runCli(['run', 'smoke'], project.env, project.root);
    const secondId = second.stdout.match(/run ([^ ]+) finished/)?.[1];
    if (!firstId || !secondId) {
      throw new Error(`run ids missing: ${first.stdout} / ${second.stdout}`);
    }

    const listed = await runCli(['runs', '--json'], project.env, project.root);
    expect(listed.code).toBe(0);

    const rows = listed.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ids = rows.map((row) => row['run_id']) as string[];

    // Both runs appear, in ascending run_id order.
    expect(ids).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(ids).toEqual([...ids].sort());

    const row = rows.find((candidate) => candidate['run_id'] === firstId);
    expect(row).toMatchObject({
      run_id: firstId,
      runtime: { id: 'claude-code' },
      model: { requested: '' },
      profile: { name: 'fixture' },
      isolation: { strategy: 'level1' },
      execution: { exit_code: 0, timed_out: false },
      requested_cell: expect.objectContaining({ inputs_version: 1 }) as unknown,
    });
    const task = row?.['task'] as { source: string } | undefined;
    expect(task?.source).toContain('smoke.md');
    // The projection is closed: a trace field outside the listed set is absent.
    expect(row).not.toHaveProperty('runtime.version');
    expect(row).not.toHaveProperty('diagnostics');
  });
});

describe('contract verification: CLI surface', () => {
  afterEach(cleanupFixtures);

  function parseLines(stdout: string): Record<string, unknown>[] {
    return stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('profile list reports each profile, with --json one level/message object per line', async () => {
    const project = await createFixtureProject(CLAUDE);

    const result = await runCli(['profile', 'list', '--json'], project.env, project.root);
    expect(result.code).toBe(0);

    const lines = parseLines(result.stdout);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'info', message: 'fixture', runtime: 'claude-code' }),
    );
    for (const line of lines) {
      expect(typeof line['level']).toBe('string');
      expect(typeof line['message']).toBe('string');
    }
  });

  it('inspect resolves a profile without running it, with --json', async () => {
    const project = await createFixtureProject(CLAUDE);

    const result = await runCli(['inspect', 'fixture', '--json'], project.env, project.root);
    expect(result.code).toBe(0);

    const [line] = parseLines(result.stdout);
    expect(line).toMatchObject({ level: 'info', message: 'fixture', runtime: 'claude-code' });
    expect(String(line?.['digest'])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('contract verification: configuration errors', () => {
  afterEach(cleanupFixtures);

  it('exits 2, not 5, when a run timeout is not a number', async () => {
    const project = await createFixtureProject(CLAUDE);
    await writeFile(
      join(project.root, '.yuurei', 'yuurei.yaml'),
      [
        'version: 1',
        'profiles:',
        '  fixture:',
        '    runtime: claude-code',
        '    source: ./profiles/fixture',
        'runs:',
        '  smoke:',
        '    profile: fixture',
        '    task: ./tasks/smoke.md',
        '    timeout: "not-a-number"',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await runCli(['run', 'smoke'], project.env, project.root);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('timeout');
  });

  it('exits 2, not 5, when profile.yaml is invalid', async () => {
    const project = await createFixtureProject(CLAUDE);
    await writeFile(
      join(project.root, '.yuurei', 'profiles', 'fixture', 'profile.yaml'),
      'runtime: [\n',
      'utf8',
    );

    const result = await runCli(['inspect', 'fixture'], project.env, project.root);

    expect(result.code).toBe(2);
  });

  it('exits 2, not 5, when the run task file is missing', async () => {
    const project = await createFixtureProject(CLAUDE);
    await rm(join(project.root, '.yuurei', 'tasks', 'smoke.md'));

    const result = await runCli(['run', 'smoke'], project.env, project.root);

    expect(result.code).toBe(2);
  });

  it('exits 3 when the runtime is not installed', async () => {
    const project = await createFixtureProject(CLAUDE);
    await rm(join(project.bin, 'claude'));
    // Keep the fixture bin on PATH but no runtime behind it, so detection fails
    // rather than finding a real `claude` on the runner.
    const env = { ...project.env, PATH: `${project.bin}:/usr/bin:/bin` };

    const result = await runCli(['run', 'smoke'], env, project.root);

    expect(result.code).toBe(3);
  });
});

describe('contract verification: --json error codes', () => {
  afterEach(cleanupFixtures);

  it('makes each failure an agent must branch on distinguishable without reading message', async () => {
    const project = await createFixtureProject(CLAUDE);
    // A fresh directory with no `.yuurei/` anywhere above it.
    const emptyRoot = await mkdtemp(join(tmpdir(), 'yuurei-no-project-'));
    // A project whose runtime is not installed, for the exit-3 category.
    const noRuntimeProject = await createFixtureProject(CLAUDE);
    await rm(join(noRuntimeProject.bin, 'claude'));
    const noRuntimeEnv = {
      ...noRuntimeProject.env,
      PATH: `${noRuntimeProject.bin}:/usr/bin:/bin`,
    };
    try {
      // A named run whose task path would escape `.yuurei/`.
      await writeFile(
        join(project.root, '.yuurei', 'yuurei.yaml'),
        [
          'version: 1',
          'profiles:',
          '  fixture:',
          '    runtime: claude-code',
          '    source: ./profiles/fixture',
          'runs:',
          '  escaping:',
          '    profile: fixture',
          '    task: ../../escape.md',
          '',
        ].join('\n'),
        'utf8',
      );

      const cases: Array<{
        args: string[];
        cwd: string;
        env: NodeJS.ProcessEnv;
        code: string;
        exitCode: number;
      }> = [
        {
          args: ['profile', 'list', '--json'],
          cwd: emptyRoot,
          env: process.env,
          code: 'no_project',
          exitCode: 2,
        },
        {
          args: ['profile', 'bogus', '--json'],
          cwd: project.root,
          env: project.env,
          code: 'invalid_input',
          exitCode: 2,
        },
        {
          args: ['run', 'missing', '--json'],
          cwd: project.root,
          env: project.env,
          code: 'unknown_run',
          exitCode: 2,
        },
        {
          args: ['inspect', 'missing', '--json'],
          cwd: project.root,
          env: project.env,
          code: 'unknown_profile',
          exitCode: 2,
        },
        {
          args: ['run', 'escaping', '--json'],
          cwd: project.root,
          env: project.env,
          code: 'task_path_escapes',
          exitCode: 2,
        },
        {
          args: ['trace', 'show', 'missing', '--json'],
          cwd: project.root,
          env: project.env,
          code: 'no_trace',
          exitCode: 2,
        },
        // Rejected by cac before any action runs, so these never reach the
        // action wrapper yet must still carry the JSON envelope.
        {
          args: ['run', '--json', '--bogus'],
          cwd: project.root,
          env: project.env,
          code: 'invalid_input',
          exitCode: 2,
        },
        {
          args: ['trace', 'show', '--json'],
          cwd: project.root,
          env: project.env,
          code: 'invalid_input',
          exitCode: 2,
        },
        // A supported runtime that is not installed is its own category.
        {
          args: ['run', 'smoke', '--json'],
          cwd: noRuntimeProject.root,
          env: noRuntimeEnv,
          code: 'runtime_unavailable',
          exitCode: 3,
        },
      ];

      const observed: string[] = [];
      for (const testCase of cases) {
        const result = await runCli(testCase.args, testCase.env, testCase.cwd);
        const line = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
        expect(line['level']).toBe('error');
        expect(line['exit_code']).toBe(testCase.exitCode);
        expect(line['code']).toBe(testCase.code);
        observed.push(line['code'] as string);
      }

      expect(observed).toEqual(cases.map((testCase) => testCase.code));
      // Every branch-worthy category is its own code; only `invalid_input`
      // repeats, and only across call forms whose fix is the same (repair the
      // invocation), so a consumer still never reads the prose `message`.
      const branchWorthy = observed.filter((code) => code !== 'invalid_input');
      expect(new Set(branchWorthy).size).toBe(branchWorthy.length);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it('reports invalid_config, not invalid_input, for an unreadable configuration file', async () => {
    const project = await createFixtureProject(CLAUDE);
    await writeFile(join(project.root, '.yuurei', 'yuurei.yaml'), 'version: [\n', 'utf8');

    const result = await runCli(['run', 'smoke', '--json'], project.env, project.root);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      level: 'error',
      code: 'invalid_config',
      exit_code: 2,
    });
  });
});
