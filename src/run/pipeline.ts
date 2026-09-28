import { rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import { NoopCostModel } from '../cost/noop.js';
import { installSignalCleanup } from './signals.js';
import { resolveCell, type CellResolutionInput } from '../cell/resolver.js';
import type { ResolvedCell } from '../cell/types.js';
import { materializeSeed, toBaselineManifest } from '../seed/index.js';
import { SEED_POLICY } from '../seed/types.js';
import type { WorkspaceChanges } from '../seed/types.js';
import { buildPatch, copyWorkspace } from './workspace.js';
import { buildSeededPatch, collectSeededWorkspace, toChangesManifest } from './seeded.js';
import {
  collectArtifacts,
  DEFAULT_ARTIFACT_MAX_BYTES,
  writeArtifactManifest,
} from '../artifact/collector.js';
import { createIsolation, assertVerifiedIsolation } from '../isolation/index.js';
import type { Isolation, IsolationContext, IsolationStrategy } from '../isolation/types.js';
import { toProfileManifest } from '../profile/manifest.js';
import { getRuntime } from '../runtime/registry.js';
import type { PreparedRun, Runtime } from '../runtime/types.js';
import { writeTrace } from '../trace/writer.js';
import { redactFile, redactText } from '../trace/redact.js';
import type { RunDefinition, Trace } from '../trace/schema.js';
import { TRACE_SCHEMA_VERSION } from '../trace/schema.js';
import { createUniqueRunLayout } from './layout.js';
import { resolvePflBinary, runObserver } from '../observer/index.js';
import type { ObservationRecord } from '../observer/index.js';
import { loadYuureiConfig } from '../config/yuurei-config.js';

export interface RunPipelineInput extends CellResolutionInput {
  yuureiDir: string;
  isolationStrategy: 'level0' | 'level1';
  keep: boolean;
  /** How the run was specified (ADR-0013); omitted by callers with no definition. */
  definition?: RunDefinition;
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
   * Opt-in, experimental (#210): enable the pre-run observation phase.
   * When enabled, the observer stage runs after isolation verification
   * and before runtime execution. Without it, observation is absent from
   * the trace.
   */
  observe?: boolean;
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
 * resolve → isolate create → materialise → verify (fail-closed) →
 * observe → execute → normalize → write trace → collect artifacts.
 * No other module should re-implement this ordering
 * (design doc §12.2 fail-closed principle, ADR-0022).
 */
export async function runPipeline(input: RunPipelineInput): Promise<RunPipelineResult> {
  let cell = await resolveCell(input);
  // A runtime that is not installed, or is below its declared minimum, is a
  // configuration error, not an execution failure (contract, Exit codes: 3).
  // Checked before any run directory or temp cell is created.
  const runtime = (input.resolveRuntime ?? getRuntime)(cell.runtimeId);
  const detection = await runtime.detect();
  if (!detection.installed) {
    throw new YuureiError(`runtime not found: ${cell.runtimeId}`, EXIT_CODES.RUNTIME_UNSUPPORTED);
  }
  if (detection.versionSupported === false) {
    throw new YuureiError(
      `runtime ${cell.runtimeId} version ${detection.version ?? 'unknown'} is below the supported minimum`,
      EXIT_CODES.RUNTIME_UNSUPPORTED,
    );
  }

  const { runId, cellId, layout } = await createUniqueRunLayout(input.yuureiDir);

  // Assign the cell_id to the resolved cell for downstream use (ADR-0021).
  cell = { ...cell, cellId };

  const isolation = (input.createIsolation ?? createIsolation)(input.isolationStrategy);
  // ADR-0022: create the isolation context early (sets up dirs + env), but
  // defer verification until after materialisation so the observer sees the
  // materialised profile. Verification remains fail-closed: a failure
  // disposes the context and the finally block removes the run dir.
  let context: IsolationContext;
  try {
    context = await isolation.create(cell);
  } catch (error) {
    // Isolation creation failed before the cleanup lifecycle was set up.
    // Remove the run directory manually (no trace will be written).
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
    // A failure to persist a required output is a trace/artifact save failure
    // (exit 6), whether it happens before or after the runtime runs
    // (contract, Exit codes). The best-effort workspace copy and patch are
    // handled separately and do not reach here.
    const save = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof YuureiError) throw error;
        throw new YuureiError(
          `failed to save the run outputs: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_CODES.TRACE_OR_ARTIFACT_SAVE_FAILED,
        );
      }
    };
    const maxArtifactBytes = input.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;

    // Seed the cell workspace before the runtime starts (#202): the
    // materialized baseline is verified against the requested one, then the
    // canonical input manifest is persisted as a required output. A seed
    // failure aborts the run before the runtime executes, as a
    // configuration error (fail closed).
    let seedMaterializedDigest: string | undefined;
    if (cell.seed !== undefined) {
      const seed = cell.seed;
      const materialized = await materializeSeed(seed, context.workspaceDir);
      seedMaterializedDigest = materialized.digest;
      await save(() =>
        writeFile(
          layout.baselineManifestPath,
          JSON.stringify(toBaselineManifest(seed, materialized.digest), null, 2),
          'utf8',
        ),
      );
    }

    prepared = await runtime.prepare(cell, context, (path) => registeredCredentialPaths.add(path));

    // ADR-0022: verify isolation after materialisation. The observer must see
    // the materialised profile; a verification failure still blocks execution.
    await assertVerifiedIsolation(isolation, context);

    // Pre-run observation phase (ADR-0022): runs after isolation verification
    // and after materialization, before runtime execution.
    let observation: ObservationRecord | undefined;
    if (input.observe) {
      const config = await loadYuureiConfig(input.yuureiDir);
      const observer = await resolvePflBinary(config);

      // Check if level0 - observation not supported in v1
      if (context.strategy === 'level0') {
        observation = {
          observer: { id: 'pfl', version: null },
          status: 'unavailable',
          reason: 'isolation-level0-unsupported',
          completeness: null,
          snapshot_ids: null,
          artifacts: [],
        };
      } else if (!observer.binPath) {
        observation = {
          observer: { id: 'pfl', version: null },
          status: 'unavailable',
          reason: observer.reason as 'observer-not-found',
          completeness: null,
          snapshot_ids: null,
          artifacts: [],
        };
      } else {
        // Run the observer: inspect → export → normalize → residue removal
        const observationResult = await runObserver(
          observer,
          context,
          cell.cellId ?? '',
          cell.runtimeId,
          layout.runDir,
        );
        // hardFailure: the observer process could not be confirmed dead.
        // Abort the run — continuing would risk residue in the cell.
        if (observationResult.hardFailure) {
          throw new YuureiError(
            'observer process could not be confirmed terminated; aborting to prevent residue in the cell',
            EXIT_CODES.ISOLATION_VERIFICATION_FAILED,
          );
        }
        observation = observationResult.record;
      }
    }

    // Redact observation artifacts before execution (ADR-0022): apply the
    // same credential/secret-pattern pass as logs. The files are pfl-produced
    // (already sanitized) but the contract requires a yuurei redaction pass.
    // Write to a temp file first, then rename for atomicity. If redaction
    // fails, remove the original to prevent unredacted content from being
    // published by collectArtifacts.
    const observationTruncatedPaths: string[] = [];
    let observationRedactFailed = false;
    if (observation?.artifacts && observation.artifacts.length > 0) {
      const credentialValues = prepared?.credentialValuesToRedact ?? [];
      for (const artifact of observation.artifacts) {
        const inputPath = join(layout.runDir, artifact.path);
        const tempPath = `${inputPath}.redact-${randomUUID()}`;
        try {
          const { truncated } = await redactFile(
            inputPath,
            tempPath,
            credentialValues,
            maxArtifactBytes,
          );
          await rename(tempPath, inputPath);
          if (truncated) observationTruncatedPaths.push(artifact.path);
        } catch {
          // Redaction failed — remove original to prevent unredacted content
          // from being published. This is a defect, not a trade-off.
          await rm(inputPath, { force: true }).catch(() => {});
          await rm(tempPath, { force: true }).catch(() => {});
          observationRedactFailed = true;
        }
      }
      // If redaction removed all artifacts, downgrade the observation status
      if (observationRedactFailed) {
        observation.artifacts = [];
        observation.status = 'unavailable';
        observation.reason = 'export-failed';
        observation.completeness = null;
        observation.snapshot_ids = null;
      }
    }

    const result = await runtime.execute(prepared, cell.executionOptions.timeout_ms);
    const fragment = await runtime.normalize(result, { runtimeVersion: prepared.runtimeVersion });
    for (const w of fragment.warnings ?? []) warn(w);

    // A cost the runtime itself reported wins over estimation: it is the
    // provider's own figure for this run, not a derived one. The CostModel
    // runs only when the adapter observed none, and its id is recorded as the
    // source so a recomputation knows what produced the number.
    const observedCost = fragment.cost ?? null;
    const costModel = new NoopCostModel();
    const costEstimate =
      observedCost === null
        ? await costModel.estimate({
            runtimeId: cell.runtimeId,
            model: cell.requestedModel,
            tokensIn: fragment.usage['input_tokens'] ?? null,
            tokensOut: fragment.usage['output_tokens'] ?? null,
            cacheReadTokensIn: fragment.usage['cache_read_input_tokens'] ?? null,
            cacheWriteTokensIn: fragment.usage['cache_write_input_tokens'] ?? null,
            reasoningTokensOut: fragment.usage['reasoning_output_tokens'] ?? null,
          })
        : null;
    const cost: Trace['cost'] =
      observedCost !== null
        ? { ...observedCost, source: 'runtime' }
        : costEstimate !== null && costEstimate.amount !== null
          ? {
              amount: costEstimate.amount,
              currency: costEstimate.currency ?? 'USD',
              source: costModel.id(),
            }
          : null;

    const knownCredentialValues = prepared.credentialValuesToRedact;
    const redactLog = async (inputPath: string, outputPath: string): Promise<boolean> => {
      try {
        const { truncated } = await redactFile(
          inputPath,
          outputPath,
          knownCredentialValues,
          maxArtifactBytes,
        );
        return truncated;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          await writeFile(outputPath, '', 'utf8');
          return false;
        }
        throw err;
      }
    };
    const [stdoutTruncated, stderrTruncated] = await Promise.all([
      save(() => redactLog(result.stdoutPath, layout.stdoutPath)),
      save(() => redactLog(result.stderrPath, layout.stderrPath)),
    ]);

    // Copy the cell workspace into the run and record it as a patch (ADR-0016).
    // Both are best-effort: a failure leaves the patch absent and is recorded as
    // a fixed diagnostic, without failing the run. A partial copy yields no
    // patch, because a patch of a partial tree is a wrong record rather than a
    // partial one. On a seeded run the copy retains only the files that differ
    // from the materialized baseline and classifies the change set (#202); an
    // incomplete collection records neither the changes nor the patch.
    let workspaceDiagnostics: string[] = [];
    let workspaceComplete = false;
    let changes: WorkspaceChanges | undefined;
    try {
      if (cell.seed !== undefined) {
        const collected = await collectSeededWorkspace(
          context.workspaceDir,
          layout.workspaceDir,
          cell.seed.files,
        );
        workspaceDiagnostics = collected.diagnostics;
        workspaceComplete = collected.complete;
        if (collected.complete) changes = collected.changes;
      } else {
        const copy = await copyWorkspace(context.workspaceDir, layout.workspaceDir);
        workspaceDiagnostics = copy.diagnostics;
        workspaceComplete = copy.complete;
      }
    } catch {
      workspaceDiagnostics = ['workspace: copy failed; durable workspace may be incomplete'];
    }
    // changes.json carries the run's added/modified/deleted record — including
    // the deletion information the retained workspace cannot hold. It is a
    // required output once the change set exists; an incomplete collection
    // leaves it absent with a fixed diagnostic, never a partial record.
    const changesDiagnostics: string[] = [];
    if (cell.seed !== undefined) {
      const seed = cell.seed;
      if (changes === undefined) {
        changesDiagnostics.push('changes: collection failed; changes.json not recorded');
      } else {
        await save(() =>
          writeFile(
            layout.changesPath,
            JSON.stringify(toChangesManifest(seed.digest, changes), null, 2),
            'utf8',
          ),
        );
      }
    }
    let patchDiagnostics: string[] = [];
    let patchTruncated = false;
    let patchRedacted = false;
    let patchPublished = false;
    // A seeded run patches only when the change set exists — falling back to
    // the empty-base patch over a partial durable tree would record an
    // all-additions diff that misrepresents the baseline.
    const canPatch = workspaceComplete && (cell.seed === undefined || changes !== undefined);
    if (canPatch) {
      // Redact and cap the diff in memory — the patch already exists as a
      // string, so staging it to disk would only write an unredacted copy
      // the cap is about to discard — then publish via a temp file + rename
      // so a failed write never leaves a partial or unredacted patch.diff in
      // place.
      const tempOutput = join(layout.runDir, `.patch.out.tmp-${randomUUID()}`);
      try {
        const patch =
          cell.seed !== undefined && changes !== undefined
            ? await buildSeededPatch(
                changes,
                {
                  workspaceDir: layout.workspaceDir,
                  sourceDir: cell.seed.sourceDir,
                  baseline: cell.seed.files,
                },
                maxArtifactBytes,
              )
            : await buildPatch(layout.workspaceDir, maxArtifactBytes);
        patchDiagnostics = patch.diagnostics;
        const redaction = redactText(patch.diff, knownCredentialValues, maxArtifactBytes);
        patchTruncated = redaction.truncated;
        patchRedacted = redaction.redacted;
        await writeFile(tempOutput, redaction.text, 'utf8');
        await rename(tempOutput, layout.patchPath);
        patchPublished = true;
      } catch {
        // Reached only before the rename, so patch.diff was not published and
        // the "generation failed" note is accurate.
        patchDiagnostics.push('patch: generation failed; patch.diff not recorded');
      } finally {
        // A stranded output temp is already redacted; no path through this
        // block writes unredacted content to disk (ADR-0016).
        await rm(tempOutput, { force: true }).catch(() => {});
      }
    } else {
      patchDiagnostics.push('patch: generation failed; patch.diff not recorded');
    }

    // The runtime's final message is a durable output like patch.diff —
    // best-effort, redacted and capped in memory (it already exists as a
    // string, so no unredacted copy ever reaches disk), published through the
    // same temp-file + rename path, and never inlined into trace.json
    // (runtime output is untrusted; §10.2). A missing text is recorded with
    // the reason the adapter reported so a consumer can tell "nothing was
    // emitted" from "extraction failed".
    const runResult = fragment.result;
    let resultTruncated = false;
    const resultDiagnostics: string[] = [];
    if (typeof runResult?.text === 'string') {
      const tempOutput = join(layout.runDir, `.result.out.tmp-${randomUUID()}`);
      try {
        const redacted = redactText(runResult.text, knownCredentialValues, maxArtifactBytes);
        resultTruncated = redacted.truncated;
        await writeFile(tempOutput, redacted.text, 'utf8');
        await rename(tempOutput, layout.resultPath);
      } catch {
        resultDiagnostics.push('result: save failed; result.txt not recorded');
      } finally {
        await rm(tempOutput, { force: true }).catch(() => {});
      }
    } else if (runResult?.reason === 'parse_failed') {
      resultDiagnostics.push('result: final message could not be parsed');
    } else if (runResult?.reason === 'unobserved') {
      resultDiagnostics.push('result: no final message emitted');
    }
    const diagnostics = [
      ...(fragment.diagnostics ?? []),
      ...(cell.seed?.diagnostics ?? []),
      ...workspaceDiagnostics,
      ...changesDiagnostics,
      ...patchDiagnostics,
      ...resultDiagnostics,
    ];

    // Collect artifacts and persist every durable output BEFORE the trace is
    // written. trace.json is the completion marker: it is written last, so a
    // failure in any step above leaves a run directory with no trace.json,
    // which cleanup removes and `yuurei trace show` cannot consume. The
    // artifact list in the trace is derived from the manifest, so the two can
    // never disagree (#111).
    const observationArtifactPaths = observation?.artifacts.map((a) => a.path) ?? [];
    const manifest = await save(() =>
      collectArtifacts(
        layout.runDir,
        [
          'stdout.log',
          'stderr.log',
          'patch.diff',
          'result.txt',
          ...(cell.seed !== undefined ? ['baseline-manifest.json', 'changes.json'] : []),
          ...observationArtifactPaths,
        ],
        {
          maxBytes: maxArtifactBytes,
          truncatedPaths: [
            ...(stdoutTruncated ? ['stdout.log'] : []),
            ...(stderrTruncated ? ['stderr.log'] : []),
            ...(patchTruncated ? ['patch.diff'] : []),
            ...(resultTruncated ? ['result.txt'] : []),
            ...observationTruncatedPaths,
          ],
          // The seeded run's manifests are required outputs: truncating
          // them in place would leave corrupt JSON. Their size is bounded
          // by the seed limits, so they are digested whole instead.
          noTruncatePaths:
            cell.seed !== undefined ? ['baseline-manifest.json', 'changes.json'] : [],
        },
      ),
    );
    await save(() => writeArtifactManifest(layout.runDir, manifest));
    // Identity, not content: §10.1 records a digest of the profile content,
    // and §10.2 keeps a profile's own secrets out of the durable run dir.
    await save(() =>
      writeFile(
        layout.resolvedProfilePath,
        JSON.stringify(toProfileManifest(cell.resolvedProfile), null, 2),
        'utf8',
      ),
    );

    const trace: Trace = {
      schema_version: TRACE_SCHEMA_VERSION,
      yuurei_version: cell.yuureiVersion,
      run_id: runId,
      ...(cell.cellId !== undefined ? { cell_id: cell.cellId } : {}),
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
      requested_cell: {
        digest: cell.requestedCellDigest,
        inputs_version: cell.requestedCellInputsVersion,
      },
      // A seeded run binds the requested and materialized baseline
      // identities, the change set, and the stored artifacts it is described
      // by (#202). `changes` is absent when the collection did not complete.
      ...(cell.seed !== undefined && seedMaterializedDigest !== undefined
        ? {
            seed: {
              policy: SEED_POLICY,
              source: cell.seed.sourceDir,
              head: cell.seed.head,
              baseline: {
                requested_digest: cell.seed.digest,
                materialized_digest: seedMaterializedDigest,
                files: cell.seed.fileCount,
                bytes: cell.seed.totalBytes,
              },
              ...(changes !== undefined
                ? {
                    changes: {
                      added: changes.added.length,
                      modified: changes.modified.length,
                      deleted: changes.deleted.length,
                    },
                  }
                : {}),
            },
          }
        : {}),
      // An absent patch is distinct from a complete empty one; `partial`
      // covers every way the stored diff stops short of a faithful record —
      // omitted files, redaction, truncation.
      patch: {
        base: cell.seed !== undefined ? ('seeded' as const) : ('empty' as const),
        state: !patchPublished
          ? ('absent' as const)
          : patchDiagnostics.length > 0 || patchTruncated || patchRedacted
            ? ('partial' as const)
            : ('complete' as const),
      },
      isolation: { strategy: context.strategy, verified: true },
      execution_options: cell.executionOptions,
      ...(input.definition !== undefined ? { definition: input.definition } : {}),
      execution: {
        exit_code: fragment.execution.exitCode,
        signal: fragment.execution.signal,
        duration_ms: fragment.execution.durationMs,
        timed_out: result.timedOut,
      },
      usage: fragment.usage,
      cost,
      // The actual artifacts just collected — mirrors artifacts.json rather
      // than a placeholder empty list.
      artifacts: manifest.artifacts.map(({ path, kind }) => ({ path, kind })),
      // Durable non-fatal notes. Omitted when empty so traces without
      // diagnostics keep their previous shape.
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      // Pre-run observation record (ADR-0022). Absent when observation was not
      // opted in; present even on failure (never interpreted as "no change").
      ...(observation !== undefined ? { observation } : {}),
    };

    await save(() => writeTrace(layout.runDir, trace));
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
