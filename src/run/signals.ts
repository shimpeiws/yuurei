import process from 'node:process';

/**
 * Exit codes for dying to a caught signal, using the shell convention of
 * 128 + signal number (SIGINT is 2, SIGTERM is 15). A parent shell or CI
 * runner watching `yuurei run` sees the same code it would see for a
 * normally-killed child, rather than yuurei reporting its own error code for
 * an interruption it handled itself.
 */
export const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export interface SignalCleanupOptions {
  /**
   * Cleans up the active run (credential scrub + isolation dispose) and
   * reports any non-fatal failure via the same warning channel the normal
   * finally block uses. Must be safe to call more than once.
   */
  cleanup: () => Promise<void>;
}

export interface SignalCleanupHandle {
  /**
   * Removes both handlers so a signal arriving after the run completed
   * normally hits the default disposition instead of re-entering the
   * cleanup/exit path. The pipeline calls this from its finally block.
   */
  uninstall(): void;
}

/**
 * Node's `process` module keeps each signal's handler(s) in `_events`.
 * Removing the entry returns the signal to its default disposition, which
 * lets a *second* SIGINT/SIGTERM during cleanup actually kill the process
 * instead of being swallowed. There is no public API for removing a single
 * handler in the `node:process` module, so this reaches into the private
 * events table the same way Node's own tests do.
 */
function unsetSignalHandler(signal: string): void {
  // The process module's event table is private; cast through the events
  // accessor the way Node's own signal tests do.
  (process as unknown as { _events: Record<string, unknown> })._events[signal] = undefined;
}

/**
 * Installs best-effort cleanup on SIGINT/SIGTERM for the duration of the
 * active run. The handler runs the same guarded cleanup the pipeline's
 * finally block runs, then exits with the shell-convention code for the
 * received signal (130 for SIGINT, 143 for SIGTERM). This is what makes a
 * signal-killed run clean up credential material and the isolation temp dir
 * that an async try/finally alone would leave behind — the finally block
 * cannot be entered once the signal's default action fires.
 *
 * The pipeline's finally block awaits the same cleanup promise before it
 * returns, so the handler's `process.exit()` never preempts an in-flight
 * dispose — the exit fires only after the cleanup has run. The handler unsets
 * itself before cleaning up, so a second signal during cleanup genuinely
 * kills instead of being re-handled, and the finally block's `uninstall()`
 * removes both handlers after a normal completion so an unrelated signal
 * arriving after the run hits the default disposition.
 *
 * Deliberately not a guarantee: SIGKILL (and power loss / hard crash) still
 * bypasses this, which is tracked separately.
 */
export function installSignalCleanup(options: SignalCleanupOptions): SignalCleanupHandle {
  for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.on(signal, async () => {
      // First signal wins; a second signal during cleanup keeps the default
      // action (kills the process) rather than being re-entered.
      unsetSignalHandler(signal);
      await options.cleanup();
      process.exit(exitCode);
    });
  }

  return {
    uninstall: () => {
      unsetSignalHandler('SIGINT');
      unsetSignalHandler('SIGTERM');
    },
  };
}
