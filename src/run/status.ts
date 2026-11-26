import { lstat, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Run-liveness reporting (#258): while a run is in progress, `status.json`
 * under the run directory is rewritten atomically on an interval so an
 * external poller can tell a live run from a vanished one, and an optional
 * sink renders the same snapshot as a progress line on stderr.
 */

export type RunState = 'running' | 'finished' | 'timed_out' | 'interrupted';

export interface RunStatusSnapshot {
  run_id: string;
  state: RunState;
  /** When the run began (pipeline start), not the runtime child's spawn time. */
  started_at: string;
  elapsed_s: number;
  /**
   * Newest modification time observed inside the cell — a liveness hint, not
   * a guarantee: a runtime that is alive but writing nothing looks idle.
   * null when nothing under the cell could be observed yet.
   */
  last_activity_at: string | null;
  /** The yuurei CLI process id, so a poller can check it is still alive. */
  pid: number;
  /** Present only on a final state. */
  finished_at?: string;
}

export const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;

/**
 * Bounds one tick's filesystem walk: a seeded workspace can hold tens of
 * thousands of entries, and the probe is only a liveness hint — hitting the
 * cap still yields a valid (possibly under-fresh) maximum rather than an
 * error or an unbounded scan.
 */
const ACTIVITY_SCAN_MAX_ENTRIES = 100_000;

/**
 * The newest mtime anywhere under `roots`, or null when nothing could be
 * observed. Reads metadata only — never file content — and uses lstat plus
 * dirent type checks so a symlink inside the cell can never lead the scan
 * outside it (files in the cell are untrusted and may be links to anywhere).
 * An entry that vanishes mid-scan or cannot be statted is skipped rather
 * than failing the tick.
 */
export async function lastActivityMs(
  roots: string[],
  maxEntries = ACTIVITY_SCAN_MAX_ENTRIES,
): Promise<number | null> {
  let newest = 0;
  let visited = 0;
  // Iterative DFS: a pathological nesting depth must not overflow the stack.
  const stack = [...roots];
  while (stack.length > 0 && visited < maxEntries) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      visited += 1;
      const path = join(dir, entry.name);
      try {
        const st = await lstat(path);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        continue;
      }
      // Dirent.isDirectory() is false for a symlink, so only real
      // directories are descended into — the scan cannot leave the cell.
      if (entry.isDirectory()) stack.push(path);
    }
  }
  return newest > 0 ? newest : null;
}

export interface RunStatusMonitorOptions {
  runId: string;
  statusPath: string;
  /** Milliseconds between status.json rewrites and progress ticks. */
  intervalMs: number;
  /**
   * Cell-internal directories scanned for the newest mtime each tick
   * (evaluated per tick so the probe always sees the current roots).
   * May return a promise — a test seam that lets a write be held in flight.
   */
  activityRoots: () => string[] | Promise<string[]>;
  pid?: number;
  /**
   * Called with each computed snapshot — the stderr progress-line hook.
   * Omitted when the terminal line is disabled; status.json is written
   * regardless.
   */
  onProgress?: (snapshot: RunStatusSnapshot) => void;
  onWarning?: (message: string) => void;
}

export interface RunStatusMonitor {
  /** Writes the first snapshot and starts the interval. Idempotent. */
  start(): void;
  /**
   * Writes the terminal state and stops the interval. The first call wins —
   * a second finish (e.g. a signal landing during post-run cleanup) is a
   * no-op so it cannot overwrite a real outcome with 'interrupted'.
   * Never rejects: a status-write failure is reported via onWarning.
   */
  finish(state: Exclude<RunState, 'running'>, finishedAt?: string): Promise<void>;
  /**
   * Stops the interval without writing a final state. Resolves once any
   * in-flight write has settled, so a caller removing the run directory
   * can be sure no status write follows.
   */
  stop(): Promise<void>;
}

export function createRunStatusMonitor(options: RunStatusMonitorOptions): RunStatusMonitor {
  const { runId, statusPath, intervalMs, activityRoots } = options;
  const pid = options.pid ?? process.pid;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let finalized = false;
  let warned = false;
  // The newest activity mtime ever observed: last_activity_at is a
  // monotonically non-decreasing hint, so a file that held the max being
  // deleted between ticks cannot move the reported value backwards.
  let newestActivityMs = 0;
  // Writes serialize through this chain so a scheduled tick and a finish()
  // can never write status.json concurrently or out of order.
  let chain: Promise<void> = Promise.resolve();

  const warnOnce = (message: string) => {
    if (warned) return;
    warned = true;
    options.onWarning?.(message);
  };

  const writeSnapshot = async (state: RunState, finishedAt?: string): Promise<void> => {
    const nowMs = Date.now();
    // The probe is a liveness hint: a throwing activityRoots or scan must
    // never reject the write chain — stop()/finish() promise to settle.
    let activityMs: number | null = null;
    try {
      activityMs = await lastActivityMs(await activityRoots());
    } catch {
      // Probe failed this tick; the snapshot is written without it.
    }
    if (activityMs !== null && activityMs > newestActivityMs) newestActivityMs = activityMs;
    const parsedFinishMs = finishedAt !== undefined ? Date.parse(finishedAt) : Number.NaN;
    const elapsedSourceMs = Number.isNaN(parsedFinishMs) ? nowMs : parsedFinishMs;
    const snapshot: RunStatusSnapshot = {
      run_id: runId,
      state,
      started_at: startedAt,
      elapsed_s: Math.max(0, Math.floor((elapsedSourceMs - startedAtMs) / 1000)),
      last_activity_at: newestActivityMs > 0 ? new Date(newestActivityMs).toISOString() : null,
      pid,
      ...(finishedAt !== undefined ? { finished_at: finishedAt } : {}),
    };
    // Atomic publication: a reader always sees either the previous file or
    // the complete new one, never a torn write. The temp name is unique per
    // write so a stranded temp can never be confused for the live file.
    const tempPath = `${statusPath}.tmp-${randomUUID()}`;
    try {
      await writeFile(tempPath, JSON.stringify(snapshot), 'utf8');
      await rename(tempPath, statusPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      // A liveness aid must never abort a run: the failure is reported once
      // and the monitor keeps ticking — the next write may succeed.
      warnOnce(
        `status: failed to write ${statusPath} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
    try {
      options.onProgress?.(snapshot);
    } catch {
      // A broken progress sink must not take the monitor down either.
    }
  };

  const enqueue = (state: RunState) => {
    chain = chain.then(() => writeSnapshot(state));
  };

  return {
    start() {
      if (started || finalized) return;
      started = true;
      enqueue('running');
      timer = setInterval(() => enqueue('running'), intervalMs);
      // The interval is a convenience, not a reason to keep the process
      // alive: unref so a leaked timer can never hang the CLI.
      timer.unref();
    },
    finish(state, finishedAt) {
      if (finalized) return chain;
      finalized = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      chain = chain.then(() => writeSnapshot(state, finishedAt));
      return chain;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return chain;
    },
  };
}
