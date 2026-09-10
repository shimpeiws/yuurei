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

  const isolation = createIsolation(input.isolationStrategy);
  const context = await createVerifiedIsolation(isolation, cell);
  context.keep = input.keep;

  let prepared: PreparedRun | undefined;
  let scrubbed = false;
  let disposed = false;
  const warn = (message: string) => input.onWarning?.(message);

  const scrubCredentials = async () => {
    // Credential material should never survive a run, even under `--keep` —
    // `--keep` preserves config/logs for debugging, never bridged auth
    // material. Best-effort, not a guarantee: a failed deletion is reported
    // via onWarning (naming the residual path) rather than silently
    // swallowed. Shared by the finally block and the signal handler, guarded
    // so a signal arriving mid-cleanup can't double-scrub and double-report.
    if (!prepared || scrubbed) return;
    scrubbed = true;
    await Promise.all(
      prepared.credentialFilePaths.map(async (path) => {
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

  const disposeContext = async () => {
    if (disposed) return;
    disposed = true;
    await isolation.dispose(context);
  };

  const cleanup = async () => {
    // Scrub before dispose() so this runs regardless of which branch above
    // threw, and so a signal killing the process mid-dispose never leaves
    // credential material behind.
    await scrubCredentials();
    // `prepared` only exists once prepare() has returned, so a run that ends
    // inside prepare() — a throw, or a signal arriving mid-flight — leaves no
    // credential manifest to scrub against, while an adapter may already have
    // written credential material into the isolation root (the Codex
    // auth-file bridge writes auth.json, then reads it back and spawns the
    // runtime to detect its version before returning). Nothing can identify
    // those files after the fact, so `--keep` must not preserve the root:
    // §9.2 places credential material outside what --keep may retain, and a
    // run that never started the runtime has no logs or trace worth keeping.
    // Deliberately fail closed here rather than have prepare() report each
    // path as it writes it, which would still leave the guarantee resting on
    // every adapter remembering to report.
    if (prepared === undefined && context.keep) {
      warn(
        `run ended before the runtime started; removing the isolation directory despite --keep, because credential material written during setup cannot be identified: ${context.rootDir}`,
      );
      context.keep = false;
    }
    await disposeContext();
  };

  const signalCleanup = installSignalCleanup({ cleanup });
  try {
    const runtime = (input.resolveRuntime ?? getRuntime)(cell.runtimeId);
    prepared = await runtime.prepare(cell, context);
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

    const trace: Trace = {
      schema_version: TRACE_SCHEMA_VERSION,
      run_id: runId,
      started_at: result.startedAt,
      finished_at: result.finishedAt,
      runtime: fragment.runtime,
      model: { requested: cell.requestedModel, resolved: fragment.model.resolved },
      profile: { name: cell.resolvedProfile.name, digest: cell.resolvedProfile.digest },
      task: { source: cell.resolvedTask.source, digest: cell.resolvedTask.digest },
      isolation: { strategy: context.strategy, verified: true },
      execution: {
        exit_code: fragment.execution.exitCode,
        duration_ms: fragment.execution.durationMs,
        timed_out: result.timedOut,
      },
      usage: fragment.usage,
      cost:
        costEstimate.amount === null
          ? null
          : { amount: costEstimate.amount, currency: costEstimate.currency ?? 'USD' },
      artifacts: [],
    };

    await writeTrace(layout.runDir, trace);
    await writeFile(
      layout.resolvedProfilePath,
      JSON.stringify(cell.resolvedProfile, null, 2),
      'utf8',
    );

    // The runtime writes its logs inside the ephemeral isolation rootDir;
    // read, redact, and persist them into the durable run directory before
    // isolation.dispose() deletes that rootDir (design doc §10: .yuurei/
    // runs/<run-id>/*.log). A full-file read+rewrite rather than copyFile:
    // design doc §9.2 requires stripping tokens/keys from logs, and a
    // trusted task can still accidentally print its own environment. Known
    // bridged credential values (exact match, reported directly by the
    // adapter via credentialValuesToRedact — not inferred from env var
    // names, which can't reach a secret embedded in file content like a
    // bridged auth.json's OAuth tokens) are stripped first, then the
    // generic shape-based patterns as a fallback for anything not
    // explicitly tracked. This means persisted logs are no longer a
    // byte-for-byte copy of what the runtime produced.
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

    const manifest = await collectArtifacts(layout.runDir, ['stdout.log', 'stderr.log'], {
      maxBytes: maxArtifactBytes,
      truncatedPaths: [
        ...(stdoutTruncated ? ['stdout.log'] : []),
        ...(stderrTruncated ? ['stderr.log'] : []),
      ],
    });
    await writeArtifactManifest(layout.runDir, manifest);

    return { runId, runDir: layout.runDir, cell, trace };
  } finally {
    // The finally block and the signal handler share the same guarded
    // cleanup, so the dispose can't run twice even when a signal arrives
    // while this block is mid-flight. The signal handler awaits the same
    // `cleanup` promise, so its `process.exit()` cannot preempt this block's
    // in-flight dispose — the exit fires only after both the finally block
    // and the handler's own cleanup have run. Uninstall before cleaning up:
    // a signal arriving after this run completed must not re-enter the
    // cleanup/exit path (the run already finished; the signal is unrelated).
    signalCleanup.uninstall();
    await cleanup();
  }
}
