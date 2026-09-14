import { rm, writeFile } from 'node:fs/promises';
import { NoopCostModel } from '../cost/noop.js';
import { installSignalCleanup } from './signals.js';
import { resolveCell, type CellResolutionInput } from '../cell/resolver.js';
import type { ResolvedCell } from '../cell/types.js';
import {
  collectArtifacts,
  DEFAULT_ARTIFACT_MAX_BYTES,
  writeArtifactManifest,
} from '../artifact/collector.js';
import { createIsolation, createVerifiedIsolation } from '../isolation/index.js';
import type { Isolation, IsolationContext, IsolationStrategy } from '../isolation/types.js';
import { toProfileManifest } from '../profile/manifest.js';
import { getRuntime } from '../runtime/registry.js';
import type { PreparedRun, Runtime } from '../runtime/types.js';
import { writeTrace } from '../trace/writer.js';
import { redactFile } from '../trace/redact.js';
import type { Trace } from '../trace/schema.js';
import { TRACE_SCHEMA_VERSION } from '../trace/schema.js';
import { createUniqueRunLayout } from './layout.js';

export interface RunPipelineInput extends CellResolutionInput {
  yuureiDir: string;
  isolationStrategy: 'level0' | 'level1';
  keep: boolean;
  /** null/undefined = no timeout is enforced (current default behaviour). */
  timeoutMs?: number | null;
  /** Maximum bytes retained for each saved log and artifact. */
  maxArtifactBytes?: number;
  /** Test seam only. Defaults to the real registry; production callers omit it. */
  resolveRuntime?: (id: string) => Runtime;
  /**
   * Test seam only. Defaults to the real factory; production callers omit it.
   * Lets a test wrap the isolation to put a barrier inside `dispose()` and
   * prove the signal handler waits for the shared cleanup lifecycle.
   */
  createIsolation?: (strategy: IsolationStrategy) => Isolation;
  /**
   * Called synchronously for each non-fatal warning as it occurs (e.g. a
   * credential file that could not be scrubbed on cleanup). This is the
   * *only* way such a warning reaches the caller when a later step
   * (execute/normalize/trace write/artifact collection) throws, since no
   * RunPipelineResult is ever returned on that path — the throw propagates
   * and the caller never sees a return value to read warnings off.
   */
  onWarning?: (message: string) => void;
}

export interface RunPipelineResult {
  runId: string;
  runDir: string;
  cell: ResolvedCell;
  trace: Trace;
}

/**
 * The single place that orders a run's execution:
 * resolve → isolate → verify (fail-closed) → prepare → execute →
 * normalize → write trace → collect artifacts. No other module should
 * re-implement this ordering (design doc §12.2 fail-closed principle).
 */
export async function runPipeline(input: RunPipelineInput): Promise<RunPipelineResult> {
  const cell = await resolveCell(input);
  const { runId, layout } = await createUniqueRunLayout(input.yuureiDir);

  const isolation = (input.createIsolation ?? createIsolation)(input.isolationStrategy);
  let context: IsolationContext;
  try {
    context = await createVerifiedIsolation(isolation, cell);
  } catch (error) {
    // Isolation verification failed (§12.2 fail-closed). The run dir was
    // already created; remove it so no partial directory is left behind.
    await rm(layout.runDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  context.keep = input.keep;

  let prepared: PreparedRun | undefined;
  let scrubbed = false;
  let disposed = false;
  let traceWritten = false;
  let runDirRemoved = false;
  const warn = (message: string) => input.onWarning?.(message);

  /**
   * Every credential path an adapter writes during `prepare()` is registered
   * here at the moment of the write. The scrub reads from this sink rather
   * than from `prepared.credentialFilePaths`, which only exists once
   * prepare() has returned — so a signal or throw between the write and the
   * return no longer strands credential material (design doc §9.2, audit
   * Finding 1).
   */
  const registeredCredentialPaths = new Set<string>();

  const scrubCredentials = async () => {
    // Credential material should never survive a run, even under `--keep` —
    // `--keep` preserves config/logs for debugging, never bridged auth
    // material. Best-effort, not a guarantee: a failed deletion is reported
    // via onWarning (naming the residual path) rather than silently
    // swallowed. Shared by the finally block and the signal handler, guarded
    // so a signal arriving mid-cleanup can't double-scrub and double-report.
    if (scrubbed) return;
    scrubbed = true;
    await Promise.all(
      [...registeredCredentialPaths].map(async (path) => {
        try {
          await rm(path, { force: true });
        } catch (error) {
          warn(
            `failed to scrub credential file, it may still be present on disk: ${path} (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
        }
      }),
    );
  };

  /**
   * `discardKept` overrides the context's own `keep` for this disposal only.
   * Passed as a value rather than written back onto `context`, so the decision
   * is visible at the call site instead of as a side effect on shared state.
   */
  const disposeContext = async (discardKept = false) => {
    if (disposed) return;
    disposed = true;
    await isolation.dispose(discardKept ? { ...context, keep: false } : context);
  };

  const removeRunDir = async () => {
    if (runDirRemoved) return;
    runDirRemoved = true;
    try {
      await rm(layout.runDir, { recursive: true, force: true });
    } catch (error) {
      warn(
        `failed to remove partial run directory: ${layout.runDir} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  };

  /**
   * The actual cleanup lifecycle, run exactly once. `cleanup` below memoizes
   * this promise so that every caller — the finally block and the signal
   * handler — awaits the *same* in-flight lifecycle. Without the memoization,
   * a caller arriving while another caller's scrub/dispose is mid-await would
   * short-circuit through the boolean guards (`scrubbed`/`disposed` are set
   * before their awaits complete), return immediately, and let the signal
   * handler's `process.exit()` fire before the first caller's in-flight
   * rm/dispose had settled.
   */
  const runCleanup = async () => {
    // Scrub before dispose() so this runs regardless of which branch above
    // threw, and so a signal killing the process mid-dispose never leaves
    // credential material behind.
    await scrubCredentials();
    // `prepared` only exists once prepare() has returned. If the run ended
    // before that point AND the adapter registered no credential paths, we
    // cannot rule out an unregistered credential write — removing the whole
    // root is the only safe choice under `--keep` (§9.2). Once a path is
    // registered the scrub handled it above, so the rest of the root may be
    // kept for debugging.
    const startedRuntime = prepared !== undefined;
    const cannotIdentifyCredentials = !startedRuntime && registeredCredentialPaths.size === 0;
    if (cannotIdentifyCredentials && context.keep) {
      warn(
        `run ended before the runtime started; removing the isolation directory despite --keep, because credential material written during setup cannot be identified: ${context.rootDir}`,
      );
    }
    // If no trace was written (signal-interrupted or threw before writeTrace),
    // remove the partial run directory so no undocumented directory is left
    // that cannot be consumed by `yuurei trace show`. This must run even when
    // isolation.dispose() rejects: a disposal failure must not strand the run
    // directory as if the run were complete (review #116). disposeContext
    // itself never throws from here — its rejection propagates out of
    // runCleanup after the run directory has been handled.
    try {
      await disposeContext(cannotIdentifyCredentials);
    } finally {
      if (!traceWritten) {
        await removeRunDir();
      }
    }
  };

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= runCleanup();
    return cleanupPromise;
  };

  const signalCleanup = installSignalCleanup({ cleanup });
  let primaryError: unknown;
  try {
    const runtime = (input.resolveRuntime ?? getRuntime)(cell.runtimeId);
    prepared = await runtime.prepare(cell, context, (path) => registeredCredentialPaths.add(path));
    const result = await runtime.execute(prepared, input.timeoutMs ?? null);
    const fragment = await runtime.normalize(result, { runtimeVersion: prepared.runtimeVersion });
    for (const w of fragment.warnings ?? []) warn(w);

    const costModel = new NoopCostModel();
    const costEstimate = await costModel.estimate({
      runtimeId: cell.runtimeId,
      model: cell.requestedModel,
      tokensIn: fragment.usage['input_tokens'] ?? null,
      tokensOut: fragment.usage['output_tokens'] ?? null,
    });

    const knownCredentialValues = prepared.credentialValuesToRedact;
    const maxArtifactBytes = input.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
    const redactLog = async (inputPath: string, outputPath: string): Promise<boolean> => {
      try {
        return await redactFile(inputPath, outputPath, knownCredentialValues, maxArtifactBytes);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          await writeFile(outputPath, '', 'utf8');
          return false;
        }
        throw err;
      }
    };
    const [stdoutTruncated, stderrTruncated] = await Promise.all([
      redactLog(result.stdoutPath, layout.stdoutPath),
      redactLog(result.stderrPath, layout.stderrPath),
    ]);

    // Collect artifacts and persist every durable output BEFORE the trace is
    // written. trace.json is the completion marker: it is written last, so a
    // failure in any step above leaves a run directory with no trace.json,
    // which cleanup removes and `yuurei trace show` cannot consume. The
    // artifact list in the trace is derived from the manifest, so the two can
    // never disagree (#111).
    const manifest = await collectArtifacts(layout.runDir, ['stdout.log', 'stderr.log'], {
      maxBytes: maxArtifactBytes,
      truncatedPaths: [
        ...(stdoutTruncated ? ['stdout.log'] : []),
        ...(stderrTruncated ? ['stderr.log'] : []),
      ],
    });
    await writeArtifactManifest(layout.runDir, manifest);
    // Identity, not content: §10.1 records a digest of the profile content,
    // and §10.2 keeps a profile's own secrets out of the durable run dir.
    await writeFile(
      layout.resolvedProfilePath,
      JSON.stringify(toProfileManifest(cell.resolvedProfile), null, 2),
      'utf8',
    );

    const trace: Trace = {
      schema_version: TRACE_SCHEMA_VERSION,
      run_id: runId,
      started_at: result.startedAt,
      finished_at: result.finishedAt,
      runtime: fragment.runtime,
      model: {
        requested: cell.requestedModel,
        resolved: fragment.model.resolved,
        // Only emitted when the adapter supplies a reason, so traces from
        // adapters (and test runtimes) that do not report one are unchanged.
        ...(fragment.model.resolvedReason !== undefined
          ? { resolved_reason: fragment.model.resolvedReason }
          : {}),
      },
      profile: { name: cell.resolvedProfile.name, digest: cell.resolvedProfile.digest },
      task: { source: cell.resolvedTask.source, digest: cell.resolvedTask.digest },
      isolation: { strategy: context.strategy, verified: true },
      execution: {
        exit_code: fragment.execution.exitCode,
        signal: fragment.execution.signal,
        duration_ms: fragment.execution.durationMs,
        timed_out: result.timedOut,
      },
      usage: fragment.usage,
      cost:
        costEstimate.amount === null
          ? null
          : { amount: costEstimate.amount, currency: costEstimate.currency ?? 'USD' },
      // The actual artifacts just collected — mirrors artifacts.json rather
      // than a placeholder empty list.
      artifacts: manifest.artifacts.map(({ path, kind }) => ({ path, kind })),
      // Durable non-fatal notes. Omitted when empty so traces without
      // diagnostics keep their previous shape.
      ...(fragment.diagnostics && fragment.diagnostics.length > 0
        ? { diagnostics: fragment.diagnostics }
        : {}),
    };

    await writeTrace(layout.runDir, trace);
    traceWritten = true;

    return { runId, runDir: layout.runDir, cell, trace };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // The finally block and the signal handler share ONE memoized cleanup
    // promise (see `cleanup` above), so a signal arriving while this block is
    // mid-cleanup joins the in-flight lifecycle instead of starting a second
    // one: the handler's `await options.cleanup()` waits for the same
    // scrub/dispose this block is awaiting, and its `process.exit()` fires
    // only after both have settled. The handler stays installed until the
    // cleanup has finished so a signal in that window is caught rather than
    // taking the default disposition mid-rm; it is uninstalled last, closing
    // the tiny post-completion window where an unrelated signal would be a
    // no-op handler on an already-finished run.
    try {
      if (primaryError !== undefined) {
        // The run already failed; a cleanup failure must not mask the primary
        // error — report it via onWarning and let the original error propagate.
        await cleanup().catch((cleanupError) =>
          warn(
            `cleanup failed after the run failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          ),
        );
      } else {
        await cleanup();
      }
    } finally {
      signalCleanup.uninstall();
    }
  }
}
