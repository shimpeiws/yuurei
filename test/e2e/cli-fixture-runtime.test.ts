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

  it('surfaces auth guidance on failure when auth is unavailable, without exposing secrets', async () => {
    // Fixture claude that exits non-zero (simulates auth failure or any failure)
    const fixture = await createFixtureProject();
    // Replace the fixture claude with one that exits 0 for --version (so installed:true)
    // but exits 1 for a real run (simulating an auth or execution failure).
    await writeFile(
      join(fixture.bin, 'claude'),
      "#!/usr/bin/env node\nif (process.argv[2] === '--version') { process.stdout.write('2.1.0\\n'); process.exit(0); } process.exit(1);\n",
      'utf8',
    );
    await chmod(join(fixture.bin, 'claude'), 0o755);

    // Run without any ANTHROPIC_* credentials → authUsable: false → guidance should appear
    const env = await envFor(fixture.root, fixture.bin);
    delete env['ANTHROPIC_API_KEY'];
    delete env['ANTHROPIC_AUTH_TOKEN'];
    const result = await runCli(['run', 'smoke'], env, fixture.root);

    // run finishes (exit code may be 0 since yuurei itself succeeded, runtime just had non-zero exit)
    expect(result.stdout).toMatch(/run .* finished/);
    // Guidance must appear in stdout (warn level)
    expect(result.stdout).toContain('claude setup-token');
    expect(result.stdout).toContain('ANTHROPIC_AUTH_TOKEN');

    // Secrets must not appear in stdout/stderr output
    expect(result.stdout).not.toContain('sk-ant-api03-');
    expect(result.stdout).not.toContain('ANTHROPIC_AUTH_TOKEN=sk-ant-secret');
    expect(result.stderr).not.toContain('sk-ant-api03-');

    // Secrets must not appear in any persisted run files
    const match = result.stdout.match(/run ([^ ]+) finished/);
    if (!match) throw new Error(`run id missing: ${result.stdout}`);
    const runDir = join(fixture.root, '.yuurei', 'runs', match[1]);
    const { readdir: readdirFn } = await import('node:fs/promises');
    const files = await readdirFn(runDir);
    for (const file of files) {
      const content = await readFile(join(runDir, file), 'utf8').catch(() => '');
      expect(content).not.toContain('sk-ant-api03-');
      expect(content).not.toContain('ANTHROPIC_AUTH_TOKEN=sk-ant-secret');
    }
  });

  it('does not emit auth guidance when auth is present and run succeeds', async () => {
    const fixture = await createFixtureProject();
    // Fixture claude exits 0 and ANTHROPIC_API_KEY is set → authUsable: true
    const result = await runCli(
      ['run', 'smoke'],
      await envFor(fixture.root, fixture.bin),
      fixture.root,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/run .* finished/);
    // No auth guidance when auth is usable
    expect(result.stdout).not.toContain('authentication required');
    expect(result.stdout).not.toContain('claude setup-token');
  });
});
