import { copyFile, writeFile } from 'node:fs/promises';
import { NoopCostModel } from '../cost/noop.js';
import { resolveCell, type CellResolutionInput } from '../cell/resolver.js';
import type { ResolvedCell } from '../cell/types.js';
import { collectArtifacts, writeArtifactManifest } from '../artifact/collector.js';
import { createIsolation, createVerifiedIsolation } from '../isolation/index.js';
import { getRuntime } from '../runtime/registry.js';
import { writeTrace } from '../trace/writer.js';
import type { Trace } from '../trace/schema.js';
import { TRACE_SCHEMA_VERSION } from '../trace/schema.js';
import { createRunLayout } from './layout.js';
import { generateRunId } from './id.js';

export interface RunPipelineInput extends CellResolutionInput {
  yuureiDir: string;
  isolationStrategy: 'level0' | 'level1';
  keep: boolean;
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

  try {
    const runtime = getRuntime(cell.runtimeId);
    const prepared = await runtime.prepare(cell, context);
    const result = await runtime.execute(prepared);
    const fragment = await runtime.normalize(result);

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
    // copy them into the durable run directory before isolation.dispose()
    // deletes that rootDir (design doc §10: .yuurei/runs/<run-id>/*.log).
    await copyFile(result.stdoutPath, layout.stdoutPath);
    await copyFile(result.stderrPath, layout.stderrPath);

    const manifest = await collectArtifacts(layout.runDir, ['stdout.log', 'stderr.log']);
    await writeArtifactManifest(layout.runDir, manifest);

    return { runId, runDir: layout.runDir, cell, trace };
  } finally {
    await isolation.dispose(context);
  }
}
