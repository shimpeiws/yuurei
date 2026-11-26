import { createGhostBehavior } from './ghost-behavior.js';
import { renderGhost } from './ghost.js';
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
  animate?: boolean;
  automatic?: boolean;
  /** Injectable for tests; production passes process.stderr. */
  stream: {
    write(chunk: string): unknown;
    readonly columns?: number;
    readonly rows?: number;
    readonly writableNeedDrain?: boolean;
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
): ((snapshot: RunStatusSnapshot) => void) & { clear(): void; stop(): void; loseTerminal(): void } {
  let snapshot: RunStatusSnapshot | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let visible = false;
  let tty = options.tty;
  const seed = Math.floor(Math.random() * 0xffffffff);
  const start = performance.now();
  const behavior = createGhostBehavior(seed);
  const clearRows = '\r\x1b[2K\n\r\x1b[2K\n\r\x1b[2K\x1b[2A';
  const stopTimer = () => {
    clearInterval(timer);
    timer = undefined;
  };
  // A closed reader surfaces asynchronously as a stream 'error' event
  // (EPIPE), not a synchronous throw — without a listener it would
  // terminate the process mid-run, before cleanup can scrub credentials.
  let broken = false;
  options.stream.on?.('error', () => {
    broken = true;
    stopTimer();
  });
  const write = (chunk: string) => {
    if (broken) return;
    try {
      options.stream.write(chunk);
    } catch {
      broken = true;
      stopTimer();
    }
  };
  const clear = () => {
    if (!visible) return;
    visible = false;
    write(clearRows);
  };
  const terminalLine = (snapshot: RunStatusSnapshot) => {
    const width =
      options.stream.columns === undefined ? Infinity : Math.max(0, options.stream.columns - 1);
    const full = renderHumanLine(snapshot);
    const age =
      snapshot.last_activity_at === null
        ? '?'
        : formatElapsed((Date.now() - Date.parse(snapshot.last_activity_at)) / 1000);
    if (full.length <= width) return full;
    if (snapshot.state !== 'running') return full.slice(0, width);
    return `${formatElapsed(snapshot.elapsed_s)} running / idle ${age}`.slice(0, width);
  };
  const draw = () => {
    if (!snapshot || broken || options.stream.writableNeedDrain) return;
    const columns = options.stream.columns ?? 0;
    const width = Math.min(columns - 1, 160);
    if (width < 30 || (options.stream.rows ?? 0) < 4) {
      if (visible) {
        clear();
        write(`\r\x1b[K${terminalLine(snapshot)}`);
      }
      return;
    }
    const time = performance.now() - start;
    const [top, bottom] = renderGhost({ seed, width, time, beat: behavior.sample(time) });
    const line = terminalLine(snapshot);
    visible = true;
    write(`\r\x1b[2K${line.slice(0, width)}\n\r\x1b[2K${top}\n\r\x1b[2K${bottom}\x1b[2A\r`);
  };
  const update = (next: RunStatusSnapshot) => {
    if (options.automatic && !tty) return;
    snapshot = next;
    if (options.animate && tty && !options.json && next.state === 'running' && !broken) {
      if (!timer) {
        timer = setInterval(draw, 100);
        timer.unref();
      }
      if ((options.stream.columns ?? 0) >= 31 && (options.stream.rows ?? 0) >= 4) {
        draw();
        return;
      }
      clear();
    } else {
      stopTimer();
      clear();
    }
    if (options.json) {
      write(`${JSON.stringify(snapshot)}\n`);
      return;
    }
    const line = renderHumanLine(snapshot);
    if (tty) {
      write(`\r\x1b[K${terminalLine(snapshot)}${snapshot.state === 'running' ? '' : '\n'}`);
    } else {
      write(`${line}\n`);
    }
  };
  return Object.assign(update, {
    clear,
    loseTerminal() {
      stopTimer();
      visible = false;
      tty = false;
    },
    stop() {
      stopTimer();
      clear();
    },
  });
}
