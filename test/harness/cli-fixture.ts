import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Invokes the public CLI in a child process, the way a user (and CI) does. */
export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string = repoRoot,
): Promise<CliResult> {
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
  return new Promise<CliResult>((resolve, reject) => {
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

export interface RealRuntime {
  /** Runtime id the run is configured for, e.g. `claude-code`. */
  runtime: string;
  /** Executable the adapter looks up on PATH, e.g. `claude`. */
  command: string;
}

export interface FixtureRuntime extends RealRuntime {
  /**
   * Node script written as `bin/<command>`. Omit to use a real runtime already
   * on PATH; that is the connector the real-runtime harness (v0.5.0) uses.
   */
  shim?: string;
}

export interface FixtureProject {
  root: string;
  bin: string;
  env: NodeJS.ProcessEnv;
}

/** What a run's `runs` entry declares, so a test can vary one field at a time. */
export interface RunDefinitionInput {
  model?: string;
  timeout?: number;
  isolation?: string;
}

const roots: string[] = [];

/**
 * Builds a temp project with a profile, a task, and a `smoke` run, plus a
 * fixture runtime on PATH when a shim is given. Cleans up on `cleanupFixtures`.
 */
export async function createFixtureProject(runtime: FixtureRuntime): Promise<FixtureProject> {
  const root = await mkdtemp(join(tmpdir(), 'yuurei-harness-'));
  roots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  if (runtime.shim !== undefined) {
    await writeFile(join(bin, runtime.command), runtime.shim, 'utf8');
    await chmod(join(bin, runtime.command), 0o755);
  }
  await mkdir(join(root, '.yuurei', 'profiles', 'fixture', 'config'), { recursive: true });
  await writeFile(
    join(root, '.yuurei', 'profiles', 'fixture', 'profile.yaml'),
    `runtime: ${runtime.runtime}\n`,
    'utf8',
  );
  await writeFile(
    join(root, '.yuurei', 'profiles', 'fixture', 'config', 'config.json'),
    '{"fixture":1}\n',
    'utf8',
  );
  await mkdir(join(root, '.yuurei', 'tasks'), { recursive: true });
  await writeFile(join(root, '.yuurei', 'tasks', 'smoke.md'), 'Reply using the fixture.\n', 'utf8');
  await writeRunConfig(root, runtime, {});
  return { root, bin, env: envFor(root, bin) };
}

function envFor(root: string, bin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    HOME: root,
  };
}

/** Rewrites `.yuurei/yuurei.yaml` so a test can vary the run's definition. */
export async function writeRunConfig(
  root: string,
  runtime: RealRuntime,
  run: RunDefinitionInput,
): Promise<void> {
  const lines = [
    'version: 1',
    'profiles:',
    '  fixture:',
    `    runtime: ${runtime.runtime}`,
    '    source: ./profiles/fixture',
    'runs:',
    '  smoke:',
    '    profile: fixture',
    '    task: ./tasks/smoke.md',
    ...(run.model !== undefined ? [`    model: ${run.model}`] : []),
    ...(run.timeout !== undefined ? [`    timeout: ${run.timeout}`] : []),
    ...(run.isolation !== undefined ? [`    isolation: ${run.isolation}`] : []),
    '',
  ];
  await writeFile(join(root, '.yuurei', 'yuurei.yaml'), lines.join('\n'), 'utf8');
}

export async function cleanupFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

function runIdFrom(stdout: string): string {
  const id = stdout.match(/run ([^ ]+) finished/)?.[1];
  if (!id) throw new Error(`run id missing in output: ${stdout}`);
  return id;
}

export interface TraceRecord extends Record<string, unknown> {
  requested_cell?: { digest: string; inputs_version: number };
}

async function readTrace(root: string, runId: string): Promise<TraceRecord> {
  return JSON.parse(
    await readFile(join(root, '.yuurei', 'runs', runId, 'trace.json'), 'utf8'),
  ) as TraceRecord;
}

/** Runs `yuurei run smoke`, returning the parsed trace. */
export async function runAndReadTrace(
  project: FixtureProject,
  extraArgs: string[] = [],
): Promise<TraceRecord> {
  const result = await runCli(['run', 'smoke', ...extraArgs], project.env, project.root);
  if (result.code !== 0) {
    throw new Error(`run failed (code ${result.code}): ${result.stderr || result.stdout}`);
  }
  return readTrace(project.root, runIdFrom(result.stdout));
}

export function digestOf(trace: TraceRecord): string {
  const digest = trace.requested_cell?.digest;
  if (digest === undefined) throw new Error('trace has no requested_cell.digest');
  return digest;
}

/** A deterministic `claude` shim: supported version, a JSON result, exit 0. */
export const CLAUDE_SHIM = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.0\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ result: 'fixture response', usage: { input_tokens: 3, output_tokens: 2 } }));
`;
