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

/**
 * Maps a signal name to the shell-convention exit code (128 + signal number).
 * Handles SIGINT (130) and SIGTERM (143) by the well-known table; falls back
 * to 128 for any other signal so the process never exits 0 for a killed run.
 */
export function exitCodeForSignal(signal: string): number {
  return SIGNAL_EXIT_CODES[signal] ?? 128;
}

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
 * dispose — the exit fires only after the cleanup has run. The first signal
 * to arrive removes both handlers before cleaning up, so a second signal
 * during cleanup keeps the default disposition (genuinely kills the process)
 * rather than racing a second `process.exit()`; the finally block's
 * `uninstall()` removes both handlers after a normal completion so an
 * unrelated signal arriving after the run hits the default disposition.
 *
 * Deliberately not a guarantee: SIGKILL (and power loss / hard crash) still
 * bypasses this, which is tracked separately.
 */
export function installSignalCleanup(options: SignalCleanupOptions): SignalCleanupHandle {
  const handlers = new Map<string, () => Promise<void>>();

  const uninstall = () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    handlers.clear();
  };

  for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
    const handler = async () => {
      // First signal wins: removing both handlers here means a second signal
      // during cleanup keeps the default action (kills the process) instead
      // of being re-entered or racing a second process.exit().
      uninstall();
      await options.cleanup();
      process.exit(exitCode);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return { uninstall };
}
