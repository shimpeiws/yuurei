import type { RunStatusSnapshot } from '../run/status.js';
import { DEFAULT_PROGRESS_INTERVAL_MS } from '../run/status.js';
import { MAX_TIMEOUT_MS } from '../runtime/exec.js';
import { ERROR_CODES, EXIT_CODES, YuureiError } from './exit-codes.js';

/**
 * The stderr progress line for `yuurei run` (#258): gating, interval
 * validation, and rendering. Nothing here ever writes to stdout.
 */

export interface ProgressResolution {
  /** Whether the stderr progress line is emitted at all. */
  enabled: boolean;
  intervalMs: number;
}

/**
 * Resolves the `--progress` flag: undefined means auto (on only when stderr
 * is a terminal and --json is absent), false means off (--no-progress),
 * true means on at the default interval, and a number or numeric string is
 * the interval in seconds. The interval bounds the status.json rewrite
 * cadence too, so it gets the same validation as --timeout — a value Node
 * would clamp must not silently fire every millisecond.
 */
export function resolveProgress(
  flag: boolean | number | string | undefined,
  context: { json: boolean; stderrIsTTY: boolean },
): ProgressResolution {
  let enabled: boolean;
  let intervalMs = DEFAULT_PROGRESS_INTERVAL_MS;
  if (flag === undefined) {
    enabled = context.stderrIsTTY && !context.json;
  } else if (flag === false) {
    enabled = false;
  } else if (flag === true) {
    enabled = true;
  } else {
    const seconds = typeof flag === 'number' ? flag : Number(flag);
    intervalMs = seconds * 1000;
    if (
      !(
        Number.isFinite(seconds) &&
        seconds > 0 &&
        Number.isFinite(intervalMs) &&
        intervalMs <= MAX_TIMEOUT_MS
      )
    ) {
      throw new YuureiError(
        `--progress interval must be a positive number of seconds (got ${String(flag)})`,
        EXIT_CODES.CONFIG_ERROR,
        ERROR_CODES.INVALID_INPUT,
      );
    }
    enabled = true;
  }
  return { enabled, intervalMs };
}

/** `724` → `12m04s`, `45` → `45s`, `3723` → `1h02m03s`. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0)
    return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

const FINAL_STATE_TEXT: Record<Exclude<RunStatusSnapshot['state'], 'running'>, string> = {
  finished: 'finished',
  timed_out: 'timed out',
  interrupted: 'interrupted',
};

function renderHumanLine(snapshot: RunStatusSnapshot): string {
  if (snapshot.state === 'running') {
    const ago =
      snapshot.last_activity_at === null
        ? 'unknown'
        : `${formatElapsed((Date.now() - Date.parse(snapshot.last_activity_at)) / 1000)} ago`;
    return `[yuurei] ${snapshot.run_id} running ${formatElapsed(snapshot.elapsed_s)}, last activity ${ago}`;
  }
  return `[yuurei] ${snapshot.run_id} ${FINAL_STATE_TEXT[snapshot.state]} after ${formatElapsed(snapshot.elapsed_s)}`;
}

export interface ProgressSinkOptions {
  json: boolean;
  /** Whether `stream` is a terminal (enables in-place rewrite). */
  tty: boolean;
  /** Injectable for tests; production passes process.stderr. */
  stream: {
    write(chunk: string): unknown;
    /** Optional Node stream surface used to catch async EPIPE ('error'). */
    on?(event: string, listener: (error: Error) => void): unknown;
  };
}

/**
 * Renders each monitor snapshot to stderr. On a terminal the running line is
 * rewritten in place (`\r` + erase-to-EOL); anywhere else each tick appends
 * a line. With `--json` each tick is a JSON line carrying the same fields
 * as status.json. A broken stream (closed pipe) disables the sink rather
 * than crashing the run — a liveness aid must never kill the pipeline.
 */
export function createProgressSink(
  options: ProgressSinkOptions,
): (snapshot: RunStatusSnapshot) => void {
  // A closed reader surfaces asynchronously as a stream 'error' event
  // (EPIPE), not a synchronous throw — without a listener it would
  // terminate the process mid-run, before cleanup can scrub credentials.
  let broken = false;
  options.stream.on?.('error', () => {
    broken = true;
  });
  const write = (chunk: string) => {
    if (broken) return;
    try {
      options.stream.write(chunk);
    } catch {
      broken = true;
    }
  };
  return (snapshot) => {
    if (options.json) {
      write(`${JSON.stringify(snapshot)}\n`);
      return;
    }
    const line = renderHumanLine(snapshot);
    if (options.tty) {
      write(`\r\x1b[K${line}${snapshot.state === 'running' ? '' : '\n'}`);
    } else {
      write(`${line}\n`);
    }
  };
}
