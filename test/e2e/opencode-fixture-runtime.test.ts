import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const runs: string[] = [];

async function runCli(args: string[], env: NodeJS.ProcessEnv, cwd = repoRoot) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      join(repoRoot, 'node_modules/tsx/dist/loader.mjs'),
      join(repoRoot, 'src/index.ts'),
      ...args,
    ],
    { cwd, env },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
  });
}

// A deterministic `opencode` shim: reports a supported version for detection
// and emits the NDJSON contract for a run. It records the argv and env it saw
// next to itself, so the test can prove the actual launch contract and the
// root redirection without relying on an env var (the pipeline forwards only
// an allowlisted environment). A `mode` file beside the shim selects failure.
const OPENCODE_SHIM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('1.18.30\\n');
  process.exit(0);
}
fs.writeFileSync(path.join(dir, '..', 'shim-env.json'), JSON.stringify({
  args,
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  TMPDIR: process.env.TMPDIR,
  DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
  DISABLE_EXTERNAL_SKILLS: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS,
}));
const modePath = path.join(dir, 'mode');
const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, 'utf8').trim() : 'ok';
if (mode === 'fail') {
  process.stdout.write(JSON.stringify({ type: 'error', error: { name: 'AuthError', data: { message: 'sk-should-not-persist' } } }) + '\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 5, input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'fixture response' } }) + '\\n');
process.exit(0);
`;

async function createFixtureProject() {
  const root = await mkdtemp(join(tmpdir(), 'yuurei-oc-e2e-'));
  runs.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'opencode'), OPENCODE_SHIM, 'utf8');
  await chmod(join(bin, 'opencode'), 0o755);

  await mkdir(join(root, '.yuurei'), { recursive: true });
  await writeFile(
    join(root, '.yuurei', 'yuurei.yaml'),
    'version: 1\nprofiles:\n  fixture:\n    runtime: opencode\n    source: ./profiles/fixture\nruns:\n  smoke:\n    profile: fixture\n    task: ./tasks/smoke.md\n',
    'utf8',
  );
  await mkdir(join(root, '.yuurei', 'profiles', 'fixture', 'config'), { recursive: true });
  await writeFile(
    join(root, '.yuurei', 'profiles', 'fixture', 'profile.yaml'),
    'runtime: opencode\n',
  );
  await writeFile(
    join(root, '.yuurei', 'profiles', 'fixture', 'config', 'opencode.json'),
    '{"username":"fixture"}\n',
  );
  await mkdir(join(root, '.yuurei', 'tasks'), { recursive: true });
  await writeFile(join(root, '.yuurei', 'tasks', 'smoke.md'), 'Reply using the fixture.\n');
  return { root, bin };
}

function envFor(root: string, bin: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: root };
}

function runIdFrom(stdout: string): string {
  const id = stdout.match(/run ([^ ]+) finished/)?.[1];
  if (!id) throw new Error(`run id missing: ${stdout}`);
  return id;
}

async function readTrace(root: string, runId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(root, '.yuurei', 'runs', runId, 'trace.json'), 'utf8'),
  ) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(runs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('CLI end-to-end with a fixture OpenCode runtime', () => {
  it('runs through the public CLI and persists an OpenCode trace', async () => {
    const fixture = await createFixtureProject();
    const result = await runCli(['run', 'smoke'], envFor(fixture.root, fixture.bin), fixture.root);
    expect(result.code).toBe(0);

    const runId = runIdFrom(result.stdout);
    const trace = await readTrace(fixture.root, runId);
    expect(trace['runtime']).toMatchObject({ id: 'opencode', version: '1.18.30' });
    expect(trace['model']).toMatchObject({ resolved: null, resolved_reason: 'unobserved' });
    expect(trace['execution']).toMatchObject({ exit_code: 0, timed_out: false });
    expect(trace['usage']).toMatchObject({ input_tokens: 3, output_tokens: 2, cost_usd: 0 });
    expect(
      await readFile(join(fixture.root, '.yuurei', 'runs', runId, 'stdout.log'), 'utf8'),
    ).toContain('fixture response');
    expect(await readdir(join(fixture.root, '.yuurei', 'runs', runId))).toEqual(
      expect.arrayContaining(['stderr.log', 'resolved-profile.json', 'artifacts.json']),
    );
  });

  it('launches with the contract argv and redirects every OpenCode root into the cell', async () => {
    const fixture = await createFixtureProject();
    const result = await runCli(['run', 'smoke'], envFor(fixture.root, fixture.bin), fixture.root);
    expect(result.code).toBe(0);

    const seen = JSON.parse(await readFile(join(fixture.root, 'shim-env.json'), 'utf8')) as {
      args: string[];
      HOME: string;
      XDG_CONFIG_HOME: string;
      XDG_DATA_HOME: string;
      TMPDIR: string;
      DISABLE_PROJECT_CONFIG: string;
      DISABLE_EXTERNAL_SKILLS: string;
    };
    expect(seen.args).toEqual(['run', '--format', 'json', '--auto', 'Reply using the fixture.\n']);
    // The cell is a temp dir, not the fixture HOME.
    expect(seen.HOME).not.toBe(fixture.root);
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR'] as const) {
      expect(seen[key]).not.toBeUndefined();
    }
    expect(seen.DISABLE_PROJECT_CONFIG).toBe('1');
    expect(seen.DISABLE_EXTERNAL_SKILLS).toBe('1');
  });

  it('persists an auth failure as a trace with a fixed diagnostic, never runtime text', async () => {
    const fixture = await createFixtureProject();
    await writeFile(join(fixture.bin, 'mode'), 'fail', 'utf8');

    const result = await runCli(['run', 'smoke'], envFor(fixture.root, fixture.bin), fixture.root);
    expect(result.code).toBe(0);

    const runId = runIdFrom(result.stdout);
    const trace = await readTrace(fixture.root, runId);
    expect(trace['execution']).toMatchObject({ exit_code: 1 });
    expect(trace['diagnostics']).toEqual(
      expect.arrayContaining([expect.stringContaining('session error reported')]),
    );
    expect(JSON.stringify(trace)).not.toContain('sk-should-not-persist');
  });

  it('runs under level0 isolation with the real HOME untouched', async () => {
    const fixture = await createFixtureProject();
    const result = await runCli(
      ['run', 'smoke', '--isolation', 'level0'],
      envFor(fixture.root, fixture.bin),
      fixture.root,
    );
    expect(result.code).toBe(0);

    const runId = runIdFrom(result.stdout);
    const trace = await readTrace(fixture.root, runId);
    expect(trace['isolation']).toMatchObject({ strategy: 'level0', verified: true });
    expect(trace['execution']).toMatchObject({ exit_code: 0 });
  });
});
