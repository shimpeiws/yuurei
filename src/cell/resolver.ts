import { readFile } from 'node:fs/promises';
import { sha256Digest } from '../util/hash.js';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import type { ResolvedProfile } from '../profile/types.js';
import type { IsolationStrategy } from '../isolation/types.js';
import { computeRequestedCellDigest } from './digest.js';
import type { ExecutionOptions, ResolvedCell, ResolvedTaskRef } from './types.js';

export interface CellResolutionInput {
  runtimeId: string;
  requestedModel: string;
  profile: ResolvedProfile;
  taskPath: string;
  yuureiVersion: string;
  /**
   * Adapter-owned execution contracts, before normalization. Adapters read
   * these from the resolved cell under `executionOptions.runtime`.
   */
  executionOptions?: Record<string, unknown>;
  /** Milliseconds before the runtime is sent SIGTERM. null/undefined = no timeout. */
  timeoutMs?: number | null;
  isolationStrategy: IsolationStrategy;
}

/** Resolves a task file into its content plus a content digest. */
async function resolveTask(taskPath: string): Promise<ResolvedTaskRef> {
  let content: string;
  try {
    content = await readFile(taskPath, 'utf8');
  } catch (error) {
    throw new YuureiError(
      `cannot read task file ${taskPath}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  return { source: taskPath, content, digest: sha256Digest(content) };
}

/**
 * Rejects execution-option values that JSON would silently drop or rewrite,
 * which would make two distinct execution contracts digest identically:
 * `undefined`, functions, `NaN`, `Infinity`, `-0`, non-plain objects (`Map`,
 * `Set`, `Date`, `Buffer`, a class with `toJSON`) and cycles. Only JSON values
 * are allowed — null, booleans, finite numbers, strings, arrays, and plain
 * objects.
 */
function assertJsonSafeExecutionOptions(options: Record<string, unknown>): void {
  const check = (value: unknown, path: string, ancestors: Set<object>): void => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (Number.isFinite(value) && !Object.is(value, -0)) return;
      throw new YuureiError(
        `execution option '${path}' is not a finite number`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }

    const isArray = Array.isArray(value);
    const isPlainObject =
      typeof value === 'object' &&
      value !== null &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    if (!isArray && !isPlainObject) {
      throw new YuureiError(
        `execution option '${path}' is not a JSON value`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }

    if (ancestors.has(value as object)) {
      throw new YuureiError(`execution option '${path}' contains a cycle`, EXIT_CODES.CONFIG_ERROR);
    }
    ancestors.add(value as object);
    if (isArray) {
      (value as unknown[]).forEach((item, index) => check(item, `${path}[${index}]`, ancestors));
    } else {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        check(item, `${path}.${key}`, ancestors);
      }
    }
    ancestors.delete(value as object);
  };
  // A fresh `Set` per top-level key: two siblings share no DFS path, so a
  // shared (non-cyclic) reference is not a cycle and must not be rejected.
  for (const [key, value] of Object.entries(options)) check(value, key, new Set());
}

/**
 * Cell Resolver: combines runtime + model + resolved profile + resolved
 * task into one identified execution cell (design doc §7.3).
 *
 * `null`, "unspecified" and the default timeout are normalized to a single
 * representation here, so the same intent never produces two digests.
 */
export async function resolveCell(input: CellResolutionInput): Promise<ResolvedCell> {
  const resolvedTask = await resolveTask(input.taskPath);
  const resolvedProfile = {
    name: input.profile.name,
    content: input.profile.content,
    digest: input.profile.digest,
  };
  const runtimeExecutionOptions = input.executionOptions ?? {};
  assertJsonSafeExecutionOptions(runtimeExecutionOptions);
  const executionOptions: ExecutionOptions = {
    timeout_ms: input.timeoutMs ?? null,
    runtime: runtimeExecutionOptions,
  };

  const requestedCellDigest = computeRequestedCellDigest({
    runtimeId: input.runtimeId,
    requestedModel: input.requestedModel,
    isolationStrategy: input.isolationStrategy,
    executionOptions,
    profileContentDigest: resolvedProfile.digest,
    taskContentDigest: resolvedTask.digest,
  });

  return {
    runtimeId: input.runtimeId,
    requestedModel: input.requestedModel,
    resolvedProfile,
    resolvedTask,
    isolationStrategy: input.isolationStrategy,
    executionOptions,
    yuureiVersion: input.yuureiVersion,
    requestedCellDigest,
  };
}
