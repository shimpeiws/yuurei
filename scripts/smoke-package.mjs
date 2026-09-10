#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let work = '';

try {
  work = await mkdtemp(join(tmpdir(), 'yuurei-smoke-'));
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  const pack = execFileSync(
    npmCmd,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', work],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const entry = JSON.parse(pack)[0];
  const tarball = join(work, entry.filename);
  const project = join(work, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"private":true}\n', 'utf8');
  execFileSync(npmCmd, ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bin =
    process.platform === 'win32'
      ? join(project, 'node_modules/.bin/yuurei.cmd')
      : join(project, 'node_modules/.bin/yuurei');
  const help = execFileSync(bin, ['--help'], {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const version = execFileSync(bin, ['--version'], {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!/yuurei/.test(help)) throw new Error(`--help did not print the CLI name: ${help}`);
  if (!version.includes(manifest.version)) {
    throw new Error(`--version printed ${version.trim()}, expected to include ${manifest.version}`);
  }
  console.error(`smoke ok: bin runs, --help and --version (${version.trim()})`);
} catch (error) {
  console.error('package smoke test failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
