import { readFile, rm, writeFile } from 'node:fs/promises';
import { NoopCostModel } from '../cost/noop.js';
import { resolveCell, type CellResolutionInput } from '../cell/resolver.js';
import type { ResolvedCell } from '../cell/types.js';
import { collectArtifacts, writeArtifactManifest } from '../artifact/collector.js';
import { createIsolation, createVerifiedIsolation } from '../isolation/index.js';
import { getRuntime } from '../runtime/registry.js';
import type { PreparedRun, Runtime } from '../runtime/types.js';
import { writeTrace } from '../trace/writer.js';
import { redactKnownValues, redactSecrets } from '../trace/redact.js';
import type { Trace } from '../trace/schema.js';
import { TRACE_SCHEMA_VERSION } from '../trace/schema.js';
import { createRunLayout } from './layout.js';
import { generateRunId } from './id.js';

export interface RunPipelineInput extends CellResolutionInput {
  yuureiDir: string;
  isolationStrategy: 'level0' | 'level1';
  keep: boolean;
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
  const runId = generateRunId();
  const layout = await createRunLayout(input.yuureiDir, runId);

  const isolation = createIsolation(input.isolationStrategy);
  const context = await createVerifiedIsolation(isolation, cell);
  context.keep = input.keep;

  let prepared: PreparedRun | undefined;
  const warn = (message: string) => input.onWarning?.(message);
  try {
    const runtime = (input.resolveRuntime ?? getRuntime)(cell.runtimeId);
    prepared = await runtime.prepare(cell, context);
    const result = await runtime.execute(prepared);
    const fragment = await runtime.normalize(result, { runtimeVersion: prepared.runtimeVersion });
    for (const w of fragment.warnings ?? []) warn(w);

    const costModel = new NoopCostModel();
    const costEstimate = await costModel.estimate({
      runtimeId: cell.runtimeId,
      model: cell.requestedModel,
      tokensIn: null,
      tokensOut: null,
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
    const redact = (text: string) => redactSecrets(redactKnownValues(text, knownCredentialValues));
    const readLog = async (path: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          warn(
            `failed to read log file (${err instanceof Error ? err.message : String(err)}): ${path}`,
          );
        }
        return '';
      }
    };
    const [stdoutRaw, stderrRaw] = await Promise.all([
      readLog(result.stdoutPath),
      readLog(result.stderrPath),
    ]);
    await Promise.all([
      writeFile(layout.stdoutPath, redact(stdoutRaw), 'utf8'),
      writeFile(layout.stderrPath, redact(stderrRaw), 'utf8'),
    ]);

    const manifest = await collectArtifacts(layout.runDir, ['stdout.log', 'stderr.log']);
    await writeArtifactManifest(layout.runDir, manifest);

    return { runId, runDir: layout.runDir, cell, trace };
  } finally {
    // Credential material should never survive a run, even under `--keep` —
    // `--keep` preserves config/logs for debugging, never bridged auth
    // material. Best-effort, not a guarantee: a failed deletion is reported
    // via onWarning (naming the residual path) rather than silently
    // swallowed — and reported here, in finally, specifically because this
    // is the only place a warning can still reach the caller when an
    // earlier step (execute/normalize/trace write/artifact collection)
    // threw and no RunPipelineResult will ever be returned. A killing
    // signal can still bypass this async finally entirely (tracked
    // separately in #16). Scrub before dispose() so this runs regardless of
    // which branch above threw.
    if (prepared) {
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
    }
    await isolation.dispose(context);
  }
}
