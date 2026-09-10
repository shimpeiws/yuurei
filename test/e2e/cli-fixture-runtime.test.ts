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
    {
      cwd,
      env,
    },
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

async function createFixtureProject() {
  const root = await mkdtemp(join(tmpdir(), 'yuurei-e2e-'));
  runs.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'claude'),
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({result:"fixture response",usage:{input_tokens:3,output_tokens:2}}));\n',
    'utf8',
  );
  await chmod(join(bin, 'claude'), 0o755);
  await mkdir(join(root, '.yuurei'), { recursive: true });
  await writeFile(
    join(root, '.yuurei', 'yuurei.yaml'),
    'version: 1\nprofiles:\n  fixture:\n    runtime: claude-code\n    source: ./profiles/fixture\nruns:\n  smoke:\n    profile: fixture\n    task: ./tasks/smoke.md\n',
    'utf8',
  );
  await mkdir(join(root, '.yuurei', 'profiles', 'fixture', 'config'), { recursive: true });
  await writeFile(
    join(root, '.yuurei', 'profiles', 'fixture', 'profile.yaml'),
    'runtime: claude-code\n',
  );
  await mkdir(join(root, '.yuurei', 'tasks'), { recursive: true });
  await writeFile(join(root, '.yuurei', 'tasks', 'smoke.md'), 'Reply using the fixture.\n');
  return { root, bin };
}

async function envFor(root: string, bin: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    ANTHROPIC_API_KEY: 'fixture-secret-value',
    HOME: root,
  };
}

afterEach(async () => {
  await Promise.all(runs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('CLI end-to-end with a fixture runtime', () => {
  it('runs through the public CLI and persists the observable artifacts', async () => {
    const fixture = await createFixtureProject();
    const result = await runCli(
      ['run', 'smoke'],
      await envFor(fixture.root, fixture.bin),
      fixture.root,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/run .* finished/);

    const match = result.stdout.match(/run ([^ ]+) finished/);
    if (!match) throw new Error(`run id missing: ${result.stdout}`);
    const runDir = join(fixture.root, '.yuurei', 'runs', match[1]);
    const trace = JSON.parse(await readFile(join(runDir, 'trace.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(trace['isolation']).toMatchObject({ verified: true });
    expect(trace['execution']).toMatchObject({ exit_code: 0, timed_out: false });
    expect(await readFile(join(runDir, 'stdout.log'), 'utf8')).toContain('fixture response');
    expect(await readdir(runDir)).toEqual(
      expect.arrayContaining(['stderr.log', 'resolved-profile.json', 'artifacts.json']),
    );
  });

  it('rejects invalid runs without starting the fixture', async () => {
    const fixture = await createFixtureProject();
    const result = await runCli(
      ['run', 'missing'],
      await envFor(fixture.root, fixture.bin),
      fixture.root,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown run: missing');
  });
});
