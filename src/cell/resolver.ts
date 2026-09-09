import { readFile } from 'node:fs/promises';
import { sha256Digest } from '../util/hash.js';
import type { ResolvedProfile } from '../profile/types.js';
import type { IsolationStrategy } from '../isolation/types.js';
import { computeCellDigest } from './digest.js';
import type { ResolvedCell, ResolvedTaskRef } from './types.js';

export interface CellResolutionInput {
  runtimeId: string;
  requestedModel: string;
  profile: ResolvedProfile;
  taskPath: string;
  yuureiVersion: string;
  executionOptions?: Record<string, unknown>;
  isolationStrategy: IsolationStrategy;
}

/** Resolves a task file into its content plus a content digest. */
async function resolveTask(taskPath: string): Promise<ResolvedTaskRef> {
  const content = await readFile(taskPath, 'utf8');
  return { source: taskPath, content, digest: sha256Digest(content) };
}

/**
 * Cell Resolver: combines runtime + model + resolved profile + resolved
 * task into one identified execution cell (design doc §7.3).
 */
export async function resolveCell(input: CellResolutionInput): Promise<ResolvedCell> {
  const resolvedTask = await resolveTask(input.taskPath);
  const resolvedProfile = {
    name: input.profile.name,
    content: input.profile.content,
    digest: input.profile.digest,
  };
  const executionOptions = input.executionOptions ?? {};

  const cellDigest = computeCellDigest({
    runtimeId: input.runtimeId,
    requestedModel: input.requestedModel,
    resolvedProfile,
    resolvedTask,
    yuureiVersion: input.yuureiVersion,
    executionOptions,
    isolationStrategy: input.isolationStrategy,
  });

  return {
    runtimeId: input.runtimeId,
    requestedModel: input.requestedModel,
    resolvedProfile,
    resolvedTask,
    yuureiVersion: input.yuureiVersion,
    executionOptions,
    isolationStrategy: input.isolationStrategy,
    cellDigest,
  };
}
