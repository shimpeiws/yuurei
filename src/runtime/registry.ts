import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import { ClaudeCodeRuntime } from './claude-code/index.js';
import { CodexRuntime } from './codex/index.js';
import { OpenCodeRuntime } from './opencode/index.js';
import type { Runtime } from './types.js';

/**
 * The only module allowed to import concrete Runtime adapters. Everything
 * else must go through `getRuntime(id)` so the core stays adapter-agnostic
 * (design doc §6.1).
 */
const RUNTIMES: Record<string, () => Runtime> = {
  'claude-code': () => new ClaudeCodeRuntime(),
  codex: () => new CodexRuntime(),
  opencode: () => new OpenCodeRuntime(),
};

export function getRuntime(id: string): Runtime {
  const factory = RUNTIMES[id];
  if (!factory) {
    throw new YuureiError(`unknown runtime: ${id}`, EXIT_CODES.RUNTIME_UNSUPPORTED);
  }
  return factory();
}

export function listRuntimeIds(): string[] {
  return Object.keys(RUNTIMES);
}
