import { readFile } from 'node:fs/promises';
import { sha256Digest } from '../util/hash.js';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import type { ResolvedProfile } from '../profile/types.js';
import type { IsolationStrategy } from '../isolation/types.js';
import {
  computeRequestedCellDigest,
  REQUESTED_CELL_INPUTS_VERSION,
  REQUESTED_CELL_INPUTS_VERSION_SEEDED,
} from './digest.js';
import { resolveSeed } from '../seed/index.js';
import { SEED_POLICY } from '../seed/types.js';
import type { ExecutionOptions, ResolvedCell, ResolvedTaskRef } from './types.js';

export interface CellResolutionInput {
  runtimeId: string;
  requestedModel: string;
  profile: ResolvedProfile;
  /**
   * Path to a task file. Exactly one of `taskPath` and `taskContent` is
   * supplied: the `--task -` / inline form omits the path and provides the
   * content directly, so a caller holding a task as a string never has to
   * write a file before it can run.
   */
  taskPath?: string;
  /**
   * Inline task content for a task with no file. The digest is computed over
   * this content exactly as for a file, so identical bytes produce the same
   * `requested_cell.digest` either way.
   */
  taskContent?: string;
  /**
   * Provenance recorded as `task.source` when the task is inline (for example
   * `stdin`). A task path is its own provenance; inline content has none, so
   * this names where the bytes came from instead of inventing a path.
   */
  taskSource?: string;
  yuureiVersion: string;
  /**
   * Adapter-owned execution contracts, before normalization. Adapters read
   * these from the resolved cell under `executionOptions.runtime`.
   */
  executionOptions?: Record<string, unknown>;
  /** Milliseconds before the runtime is sent SIGTERM. null/undefined = no timeout. */
  timeoutMs?: number | null;
  isolationStrategy: IsolationStrategy;
  /**
   * Opt-in seeded workspace (#202): an explicitly selected local Git
   * repository root whose tracked files seed the cell workspace. Absent =
   * the empty-workspace run the contract has always described.
   */
  seedRepo?: string;
}

/**
 * Resolves a task into its content, a content digest, and the provenance
 * recorded as `task.source`. A task given as inline content has no path; its
 * source is the caller-declared origin (`stdin`), never a fabricated path, and
 * its digest covers the same bytes a file would hold.
 */
async function resolveTask(input: CellResolutionInput): Promise<ResolvedTaskRef> {
  if (input.taskContent !== undefined) {
    return {
      source: input.taskSource ?? 'inline',
      content: input.taskContent,
      digest: sha256Digest(input.taskContent),
    };
  }
  if (input.taskPath === undefined) {
    throw new YuureiError(
      'a task path or inline task content is required',
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  const taskPath = input.taskPath;
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
  const resolvedTask = await resolveTask(input);
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

  // A seeded run resolves its baseline here, at resolution time, so the
  // baseline's identity is part of the request before the cell exists.
  const seed = input.seedRepo !== undefined ? await resolveSeed(input.seedRepo) : undefined;
  const requestedCellInputsVersion =
    seed === undefined ? REQUESTED_CELL_INPUTS_VERSION : REQUESTED_CELL_INPUTS_VERSION_SEEDED;

  const requestedCellDigest = computeRequestedCellDigest({
    runtimeId: input.runtimeId,
    requestedModel: input.requestedModel,
    isolationStrategy: input.isolationStrategy,
    executionOptions,
    profileContentDigest: resolvedProfile.digest,
    taskContentDigest: resolvedTask.digest,
    ...(seed !== undefined ? { seed: { policy: SEED_POLICY, baselineDigest: seed.digest } } : {}),
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
    requestedCellInputsVersion,
    ...(seed !== undefined ? { seed } : {}),
  };
}
