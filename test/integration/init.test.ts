import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_PATH = join(process.cwd(), 'src/index.ts');

// The tsx loader resolves its own package relative to cwd, so a non-repo
// cwd breaks plain `--import tsx`. Drive tsx's CLI directly instead.
const TSX_CLI = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

async function runCli(cwd: string, args: string[]) {
  const child = spawn(process.execPath, [TSX_CLI, CLI_PATH, ...args], {
    cwd,
    env: process.env,
  });
  const chunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({
          code,
          stdout: Buffer.concat(chunks).toString(),
          stderr: Buffer.concat(errorChunks).toString(),
        }),
      );
    },
  );
  return result;
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

describe('yuurei init', () => {
  const workDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(workDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    workDirs.length = 0;
  });

  async function makeWorkDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'yuurei-init-test-'));
    workDirs.push(dir);
    return dir;
  }

  it('scaffolds a runnable default project', async () => {
    const dir = await makeWorkDir();
    const result = await runCli(dir, ['init']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const root = join(dir, '.yuurei');
    expect(await readdir(root)).toContain('yuurei.yaml');
    const task = await readText(join(root, 'tasks', 'hello.md'));
    expect(task).toContain('Hello from yuurei.');
    expect(task).toContain('Do not read or write any files or run commands.');
  });

  it('creates a codex project with custom names', async () => {
    const dir = await makeWorkDir();
    const result = await runCli(dir, [
      'init',
      '--runtime',
      'codex',
      '--profile',
      'codex-scaff',
      '--task',
      'ghost',
      '--run',
      'first-run',
    ]);

    expect(result.code).toBe(0);
    const root = join(dir, '.yuurei');
    const config = await readText(join(root, 'yuurei.yaml'));
    expect(config).toMatch(/runtime: codex/);
    expect(config).toMatch(/task: \.\/tasks\/ghost\.md/);
    expect(config).toMatch(/^  first-run:$/m);
    const profileYaml = await readText(join(root, 'profiles', 'codex-scaff', 'profile.yaml'));
    expect(profileYaml).toMatch(/runtime: codex/);
    expect(await readdir(join(root, 'tasks'))).toContain('ghost.md');
  });

  it('reports already-scaffolded on a matching second run', async () => {
    const dir = await makeWorkDir();
    await runCli(dir, ['init']);
    const second = await runCli(dir, ['init']);

    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/already scaffolded/);
  });

  it('emits a structured JSON report with --json', async () => {
    const dir = await makeWorkDir();
    const result = await runCli(dir, ['init', '--json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(report).toMatchObject({
      level: 'info',
      message: 'init',
      // cwd is canonicalized by the child process, so compare the normalized path.
      targetDir: await realpath(dir),
      created: true,
      profile: 'claude-basic',
      task: 'hello',
      run: 'hello',
    });
    expect(report['scaffoldPaths']).toEqual([
      '.yuurei/yuurei.yaml',
      '.yuurei/profiles/claude-basic/profile.yaml',
      '.yuurei/profiles/claude-basic/config/.gitkeep',
      '.yuurei/tasks/hello.md',
    ]);
  });

  it('reports created:false and custom fields in JSON on an idempotent re-run', async () => {
    const dir = await makeWorkDir();
    await runCli(dir, ['init', '--profile', 'sc-starter', '--task', 'hello', '--run', 'r1']);
    const second = await runCli(dir, [
      'init',
      '--profile',
      'sc-starter',
      '--task',
      'hello',
      '--run',
      'r1',
      '--json',
    ]);

    expect(second.code).toBe(0);
    const lines = second.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(report).toMatchObject({
      created: false,
      profile: 'sc-starter',
      run: 'r1',
    });
  });

  it('refuses to overwrite on a conflict and leaves files untouched', async () => {
    const dir = await makeWorkDir();
    await runCli(dir, ['init']);
    const taskPath = join(dir, '.yuurei', 'tasks', 'hello.md');
    await writeFile(taskPath, 'tampered\n', 'utf8');

    const rerun = await runCli(dir, ['init']);

    expect(rerun.code).toBe(2);
    expect(rerun.stderr).toMatch(/refusing to overwrite/);
    expect(await readText(taskPath)).toBe('tampered\n');
  });

  it('rejects invalid names before writing anything', async () => {
    const dir = await makeWorkDir();
    const result = await runCli(dir, ['init', '--task', '../escape']);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/invalid task name/);
    expect(await readdir(dir)).not.toContain('.yuurei');
  });

  it('rejects an unknown runtime before writing anything', async () => {
    const dir = await makeWorkDir();
    const result = await runCli(dir, ['init', '--runtime', 'nope']);

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/unknown runtime/);
    expect(await readdir(dir)).not.toContain('.yuurei');
  });

  it('does not generate credential or env files', async () => {
    const dir = await makeWorkDir();
    await runCli(dir, ['init']);

    const files: string[] = [];
    async function walk(current: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    }
    await walk(dir);

    expect(files.some((f) => /\.env$|auth\.json$|\.credentials\.json$/.test(f))).toBe(false);
  });

  it('produces a config that profile list and inspect accept', async () => {
    const dir = await makeWorkDir();
    await runCli(dir, ['init', '--profile', 'sc-starter']);

    const listed = await runCli(dir, ['profile', 'list']);

    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/sc-starter/);

    const inspected = await runCli(dir, ['inspect', 'sc-starter']);

    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toMatch(/claude-code/);
  });

  it('accepts a target directory argument', async () => {
    const dir = await makeWorkDir();
    const sub = join(dir, 'proj');
    const result = await runCli(dir, ['init', 'proj']);

    expect(result.code).toBe(0);
    expect(await readdir(join(sub, '.yuurei'))).toContain('yuurei.yaml');
  });
});
