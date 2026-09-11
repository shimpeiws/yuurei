import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import type { RuntimeResult } from './types.js';

export interface ExecOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
  /** Test seam only. Overrides SIGKILL_GRACE_PERIOD_MS; production callers must omit it. */
  killGracePeriodMsForTests?: number;
}

/**
 * How long to wait after SIGTERM before escalating to SIGKILL. A process
 * that ignores SIGTERM (or is wedged in a syscall it can't be interrupted
 * from) would otherwise leave the run hanging exactly as before a timeout
 * was ever fired. Not configurable in v0.3 — a fixed grace period is
 * simpler than a second timeout knob, and 10s is generous enough for
 * normal cleanup (flushing buffers, closing files) without materially
 * extending how long a stuck run blocks the caller.
 */
const SIGKILL_GRACE_PERIOD_MS = 10_000;

/**
 * Node's setTimeout silently clamps any delay outside [1, 2^31-1] to 1ms
 * (see the Node docs on timers) rather than erroring, so an out-of-range
 * timeoutMs would fire almost immediately instead of behaving like "a very
 * long timeout" — the opposite of what a caller passing e.g. `Infinity` or
 * a 13-digit typo would expect. Rejected explicitly here rather than left
 * to that silent clamp.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Spawns a process, captures stdout/stderr to files, and normalizes the result. */
export function execCapture(options: ExecOptions): Promise<RuntimeResult> {
  if (
    options.timeoutMs !== undefined &&
    !(
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0 &&
      options.timeoutMs <= MAX_TIMEOUT_MS
    )
  ) {
    return Promise.reject(
      new RangeError(
        `timeoutMs must be a finite number between 1 and ${MAX_TIMEOUT_MS}, got ${options.timeoutMs}`,
      ),
    );
  }

  return new Promise((resolvePromise, reject) => {
    const startedAt = new Date().toISOString();
    const stdoutStream = createWriteStream(options.stdoutPath);
    const stderrStream = createWriteStream(options.stderrPath);
    // Created — but not yet awaited — up front, before spawning: a bad
    // path, EACCES, or a full disk can make either stream emit 'error'
    // immediately, before the child even starts. finished() attaches its
    // own listener as soon as it's called, so calling it here (rather than
    // only later inside the 'close' handler) is what turns that into a
    // handled rejection instead of an unhandled 'error' event, which Node
    // treats as fatal and would crash the whole process.
    const stdoutFinished = finished(stdoutStream);
    const stderrFinished = finished(stderrStream);

    const child = spawn(options.command, options.args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    // Single place for anything that makes this run unrecoverable (spawn
    // failure, either write stream erroring out): stop the timers, force
    // the child to exit rather than leaving it running with nowhere for
    // its output to go, tear down whichever stream didn't already error on
    // its own, and reject exactly once — guarded so a second failure
    // (e.g. both streams erroring, or 'error' racing a stream failure)
    // can't double-kill or double-settle.
    const failOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.kill('SIGKILL');
      stdoutStream.destroy();
      stderrStream.destroy();
      reject(error);
    };

    stdoutFinished.catch(failOnce);
    stderrFinished.catch(failOnce);

    if (options.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // If the process ignores SIGTERM, force it after a grace period.
        // Cleared in the exit/close handlers below if it exits sooner.
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, options.killGracePeriodMsForTests ?? SIGKILL_GRACE_PERIOD_MS);
      }, options.timeoutMs);
    }

    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    child.on('error', failOnce);

    // 'close' waits for the child's stdio streams to finish closing, which
    // can lag behind the process actually exiting. Stopping the timers here
    // on 'exit' — as soon as the OS reports the process is gone — instead
    // of only on 'close' avoids sending a stale SIGTERM/SIGKILL to an
    // already-dead process and marking a run that finished within budget
    // as timed out just because 'close' arrived a beat late.
    child.on('exit', () => {
      clearTimers();
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      clearTimers();
      // 'close' only confirms the child's own stdio streams have ended —
      // not that our destination write streams have flushed their buffered
      // data to disk. pipe() calls .end() on them in response, but that
      // completes asynchronously; resolving before it does can hand the
      // caller a stdoutPath/stderrPath that's still being written to,
      // producing a truncated read for a run that actually finished fine.
      Promise.all([stdoutFinished, stderrFinished])
        .then(() => {
          if (settled) return;
          settled = true;
          resolvePromise({
            exitCode,
            signal,
            startedAt,
            finishedAt: new Date().toISOString(),
            stdoutPath: options.stdoutPath,
            stderrPath: options.stderrPath,
            timedOut,
          });
        })
        .catch(() => {
          // Already handled by failOnce via the per-stream .catch above.
        });
    });
  });
}
