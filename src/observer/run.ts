import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolationContext } from '../isolation/types.js';
import type { ResolvedObserver } from './resolve.js';

/** Credential key names to strip from the environment before spawning pfl. */
const CREDENTIAL_KEY_NAMES = [
  // claude-code
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // codex
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  // opencode - provider key allowlist
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];

/** Unique values only */
const UNIQUE_CREDENTIAL_KEYS = [...new Set(CREDENTIAL_KEY_NAMES)];

/** Observation record status */
export type ObservationStatus = 'recorded' | 'partial' | 'unavailable';

/** Observation record reason codes */
export type ObservationReason =
  | 'observer-not-found'
  | 'spawn-failed'
  | 'timeout'
  | 'consent-required'
  | 'inspect-failed'
  | 'export-failed'
  | 'isolation-level0-unsupported'
  | 'residue-removal-failed';

/** Observation record from trace.json */
export interface ObservationRecord {
  observer: {
    id: string;
    version: string | null;
  };
  status: ObservationStatus;
  reason: ObservationReason | null;
  completeness: string | null;
  snapshot_ids: {
    observed: string;
    resolved: string;
  } | null;
  artifacts: Array<{
    path: string;
    kind: string;
  }>;
}

/** Observation execution result */
export interface ObservationResult {
  /** The observation record to include in trace.json */
  record: ObservationRecord;
  /** Directory containing observation artifacts */
  observationDir: string;
  /** Exit code from pfl */
  exitCode: number;
  /** stdout from pfl */
  stdout: string;
  /** stderr from pfl */
  stderr: string;
}

/** Strip credentials from environment */
export function stripCredentials(env: Record<string, string>): Record<string, string> {
  const stripped = { ...env };
  for (const key of UNIQUE_CREDENTIAL_KEYS) {
    delete stripped[key];
  }
  return stripped;
}

/**
 * Common envelope shape returned by all pfl --json commands.
 */
interface PflEnvelope<T> {
  pflVersion: string;
  command: string;
  ok: boolean;
  completeness: string;
  diagnostics: Array<{ message: string; code?: string }>;
  data: T;
}

interface InspectData {
  runtime: string;
  runtimeVersion: string | null;
  runtimeCompatibility: 'verified' | 'unverified';
  project: string;
  store: string;
  observed: {
    snapshotId: string;
    elements: number;
    opaqueLayers: number;
    completeness: string;
    cellId: string | null;
  };
  resolved: {
    snapshotId: string;
    effective: number;
    conditional: number;
    shadowed: number;
    confidence: string;
  };
}

/**
 * Spawn a pfl command and collect stdout/stderr. On timeout, sends SIGTERM
 * to the process group (including descendants that inherit pipes), then
 * SIGKILL after a grace period. A fallback timer ensures the promise
 * resolves even if `close` never fires (e.g. a descendant holds stdout).
 *
 * When `timedOut` is true, the exit code is forced to nonzero regardless
 * of what the process returned — a process that exits 0 after SIGTERM
 * must not be treated as successful.
 */
function pflSpawn(
  binPath: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(binPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const finalize = (code: number | null) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(fallbackTimer);
        // Force nonzero on timeout regardless of actual exit code
        const finalCode = timedOut ? (code ?? 1) || 1 : code;
        const suffix = timedOut ? '\ntimeout: pfl execution timed out' : '';
        resolve({ code: finalCode, stdout, stderr: stderr + suffix });
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the entire process group (wrapper + descendants)
      if (child.pid !== undefined && child.pid > 0) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      } else {
        child.kill('SIGTERM');
      }
      // Escalate to SIGKILL after 3 seconds
      killTimer = setTimeout(() => {
        if (child.pid !== undefined && child.pid > 0) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else {
          child.kill('SIGKILL');
        }
      }, 3000);
      // Fallback: if close never fires (descendant holds pipe), force resolve
      fallbackTimer = setTimeout(() => {
        finalize(1);
      }, 10000);
    }, options.timeoutMs);
    let killTimer: ReturnType<typeof setTimeout>;
    let fallbackTimer: ReturnType<typeof setTimeout>;

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (error: Error) => {
      if (!resolved) {
        stderr += `\nspawn error: ${error.message}`;
        finalize(1);
      }
    });

    child.on('close', (code) => {
      finalize(code);
    });
  });
}

/**
 * Parse a pfl JSON envelope. Returns null if parsing fails.
 */
export function parseEnvelope<T>(stdout: string): PflEnvelope<T> | null {
  try {
    return JSON.parse(stdout) as PflEnvelope<T>;
  } catch {
    return null;
  }
}

/**
 * Normalize the observation directory after pfl export.
 * pfl --out writes `<snapshot-id>.json`; we rename to `export.json`.
 * Returns the list of relative artifact paths (relative to runDir).
 * Returns an empty array if no export file was produced.
 */
export async function normalizeObservationDir(observationDir: string): Promise<string[]> {
  const entries = await readdir(observationDir, { withFileTypes: true });
  const artifacts: string[] = [];
  const bundleDir = join(observationDir, 'bundle');

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const srcPath = join(observationDir, entry.name);
      const destPath = join(observationDir, 'export.json');
      if (entry.name !== 'export.json') {
        await rename(srcPath, destPath);
      }
      artifacts.push('observation/export.json');
    }
  }

  // Bundle files (harness.json + manifest.json)
  try {
    const bundleEntries = await readdir(bundleDir, { withFileTypes: true });
    for (const entry of bundleEntries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        artifacts.push(`observation/bundle/${entry.name}`);
      }
    }
  } catch {
    // No bundle directory — that's fine
  }

  return artifacts;
}

/**
 * Remove pfl residue (~/.pfl) from the cell home.
 * Best-effort: if the directory doesn't exist, no error.
 */
async function removePflResidue(homeDir: string | null): Promise<void> {
  if (!homeDir) return;
  const pflDir = join(homeDir, '.pfl');
  await rm(pflDir, { recursive: true, force: true });
}

/**
 * Run the pfl observer: inspect → export → normalize → residue removal.
 *
 * Residue cleanup runs on every exit path (success or failure) to ensure
 * the runtime never inherits pfl's snapshot store (ADR-0022).
 *
 * @param observer - Resolved observer binary info
 * @param context - Isolation context
 * @param cellId - Cell ID for the --cell-id flag
 * @param runtimeId - Runtime identifier (e.g. 'claude-code')
 * @param runDir - Run directory for output
 * @param timeoutMs - Timeout per pfl command in milliseconds
 * @returns Observation result
 */
export async function runObserver(
  observer: ResolvedObserver,
  context: IsolationContext,
  cellId: string,
  runtimeId: string,
  runDir: string,
  timeoutMs: number = 30000,
): Promise<ObservationResult> {
  const observationDir = join(runDir, 'observation');
  await import('node:fs/promises').then((fs) => fs.mkdir(observationDir, { recursive: true }));

  // If observer not found, return unavailable (no residue possible)
  if (!observer.binPath) {
    return {
      record: {
        observer: { id: 'pfl', version: null },
        status: 'unavailable',
        reason: observer.reason as ObservationReason,
        completeness: null,
        snapshot_ids: null,
        artifacts: [],
      },
      observationDir,
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  }

  const cleanEnv = stripCredentials(context.env);
  const binPath = observer.binPath;
  let inspectResult: { code: number | null; stdout: string; stderr: string } | undefined;

  /**
   * Map a pfl command result to an observation reason, distinguishing
   * timeout and spawn failures from generic non-zero exits.
   */
  function reasonForExit(result: { code: number | null; stderr: string }): ObservationReason {
    if (result.stderr.includes('timeout:')) return 'timeout';
    if (result.stderr.includes('spawn error:')) return 'spawn-failed';
    return 'inspect-failed';
  }

  try {
    // Phase 1: inspect — creates a snapshot in the cell's ~/.pfl store
    const inspectArgs = [
      'inspect',
      '--runtime',
      runtimeId,
      '--cell-id',
      cellId,
      '--allow-scope',
      `${runtimeId}:user`,
      '--json',
    ];

    inspectResult = await pflSpawn(binPath, inspectArgs, {
      cwd: context.workspaceDir,
      env: cleanEnv,
      timeoutMs,
    });

    // Map inspect failures to observation reasons
    if (inspectResult.code === 5) {
      return unavailableRecord('consent-required', inspectResult, observationDir);
    }
    if (inspectResult.code !== 0) {
      return unavailableRecord(reasonForExit(inspectResult), inspectResult, observationDir);
    }

    const inspectEnvelope = parseEnvelope<InspectData>(inspectResult.stdout);
    if (!inspectEnvelope || !inspectEnvelope.ok) {
      return unavailableRecord('inspect-failed', inspectResult, observationDir);
    }

    const observedSnapshotId = inspectEnvelope.data.observed.snapshotId;
    const resolvedSnapshotId = inspectEnvelope.data.resolved.snapshotId;
    const pflVersion = inspectEnvelope.pflVersion;
    const completeness = inspectEnvelope.completeness ?? inspectEnvelope.data.observed.completeness;

    // Phase 2: export — produces observation artifacts
    const exportArgs = [
      'export',
      '--snapshot',
      observedSnapshotId,
      '--cell-id',
      cellId,
      '--out',
      observationDir,
      '--bundle',
      join(observationDir, 'bundle'),
      '--json',
    ];

    const exportResult = await pflSpawn(binPath, exportArgs, {
      cwd: context.workspaceDir,
      env: cleanEnv,
      timeoutMs,
    });

    if (exportResult.code === 5) {
      return unavailableRecord('consent-required', exportResult, observationDir);
    }
    if (exportResult.code !== 0) {
      const reason = exportResult.stderr.includes('timeout:')
        ? 'timeout'
        : exportResult.stderr.includes('spawn error:')
          ? 'spawn-failed'
          : 'export-failed';
      return unavailableRecord(reason, exportResult, observationDir);
    }

    // Phase 3: normalize filenames and collect artifact paths
    let artifactPaths: string[];
    try {
      artifactPaths = await normalizeObservationDir(observationDir);
    } catch {
      return unavailableRecord('export-failed', exportResult, observationDir);
    }

    // Empty export: inspect succeeded but export produced no files
    if (artifactPaths.length === 0) {
      return unavailableRecord('export-failed', exportResult, observationDir);
    }

    // Determine observation status from completeness
    const status: ObservationStatus = completeness === 'complete' ? 'recorded' : 'partial';

    const record: ObservationRecord = {
      observer: { id: 'pfl', version: pflVersion ?? null },
      status,
      reason: null,
      completeness,
      snapshot_ids: {
        observed: observedSnapshotId,
        resolved: resolvedSnapshotId,
      },
      artifacts: artifactPaths.map((path) => ({ path, kind: 'observation' })),
    };

    return {
      record,
      observationDir,
      exitCode: 0,
      stdout: inspectResult.stdout + '\n' + exportResult.stdout,
      stderr: inspectResult.stderr + '\n' + exportResult.stderr,
    };
  } finally {
    // ADR-0022: always remove pfl residue after observation, regardless of
    // outcome. Inspect may have created ~/.pfl even if export failed.
    await removePflResidue(context.homeDir).catch(() => {
      // Best-effort in finally; hard failure is recorded by the caller if needed
    });
  }
}

/**
 * Build an unavailable observation record from a failed pfl command.
 */
function unavailableRecord(
  reason: ObservationReason,
  result: { code: number | null; stdout: string; stderr: string },
  observationDir: string,
): ObservationResult {
  return {
    record: {
      observer: { id: 'pfl', version: null },
      status: 'unavailable',
      reason,
      completeness: null,
      snapshot_ids: null,
      artifacts: [],
    },
    observationDir,
    exitCode: result.code ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
