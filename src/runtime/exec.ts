import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { RuntimeResult } from './types.js';

export interface ExecOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
}

/** Spawns a process, captures stdout/stderr to files, and normalizes the result. */
export function execCapture(options: ExecOptions): Promise<RuntimeResult> {
  return new Promise((resolvePromise, reject) => {
    const startedAt = new Date().toISOString();
    const stdoutStream = createWriteStream(options.stdoutPath);
    const stderrStream = createWriteStream(options.stderrPath);

    const child = spawn(options.command, options.args, {
      env: options.env,
      cwd: options.cwd,
    });

    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : null;

    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      if (timeout) clearTimeout(timeout);
      resolvePromise({
        exitCode,
        signal,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdoutPath: options.stdoutPath,
        stderrPath: options.stderrPath,
        timedOut,
      });
    });
  });
}
