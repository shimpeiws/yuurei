import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
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
  'OPENAI_API_KEY', // already included above
  'ANTHROPIC_API_KEY', // already included above
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
  | 'export-failed'
  | 'isolation-level0-unsupported';

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
 * Run the pfl observer to export cell state.
 * @param observer - Resolved observer binary info
 * @param context - Isolation context
 * @param cellId - Cell ID for the --cell-id flag
 * @param runDir - Run directory for output
 * @param timeoutMs - Timeout in milliseconds
 * @returns Observation result
 */
export async function runObserver(
  observer: ResolvedObserver,
  context: IsolationContext,
  cellId: string,
  runDir: string,
  timeoutMs: number = 30000,
): Promise<ObservationResult> {
  const observationDir = join(runDir, 'observation');
  await mkdir(observationDir, { recursive: true });

  // If observer not found, return unavailable
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

  // Strip credentials from environment
  const cleanEnv = stripCredentials(context.env);

  // Build pfl command
  const args = ['export', '--cell-id', cellId, '--json', '--out', observationDir];

  return new Promise((resolve) => {
    const binPath = observer.binPath;
    if (!binPath) {
      resolve({
        record: {
          observer: { id: 'pfl', version: null },
          status: 'unavailable',
          reason: 'observer-not-found',
          completeness: null,
          snapshot_ids: null,
          artifacts: [],
        },
        observationDir,
        exitCode: 1,
        stdout: '',
        stderr: '',
      });
      return;
    }

    const child = spawn(binPath, args, {
      cwd: context.workspaceDir,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      resolve({
        record: {
          observer: { id: 'pfl', version: null },
          status: 'unavailable',
          reason: 'spawn-failed',
          completeness: null,
          snapshot_ids: null,
          artifacts: [],
        },
        observationDir,
        exitCode: 1,
        stdout,
        stderr: stderr + `\nspawn error: ${error.message}`,
      });
    });

    child.on('close', async (code) => {
      if (code === 5) {
        // CONSENT_REQUIRED
        resolve({
          record: {
            observer: { id: 'pfl', version: null },
            status: 'unavailable',
            reason: 'consent-required',
            completeness: null,
            snapshot_ids: null,
            artifacts: [],
          },
          observationDir,
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          record: {
            observer: { id: 'pfl', version: null },
            status: 'unavailable',
            reason: 'export-failed',
            completeness: null,
            snapshot_ids: null,
            artifacts: [],
          },
          observationDir,
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
        return;
      }

      // Parse JSON envelope from output file
      try {
        const exportPath = join(observationDir, 'export.json');
        const exportContent = await readFile(exportPath, 'utf8');
        const envelope = JSON.parse(exportContent);

        // Extract observation record from envelope
        const record: ObservationRecord = {
          observer: {
            id: 'pfl',
            version: envelope.version ?? null,
          },
          status: envelope.status ?? 'recorded',
          reason: null,
          completeness: envelope.completeness ?? null,
          snapshot_ids: envelope.snapshot_ids ?? null,
          artifacts: [{ path: 'observation/export.json', kind: 'observation' }],
        };

        resolve({
          record,
          observationDir,
          exitCode: 0,
          stdout,
          stderr,
        });
      } catch (error) {
        resolve({
          record: {
            observer: { id: 'pfl', version: null },
            status: 'unavailable',
            reason: 'export-failed',
            completeness: null,
            snapshot_ids: null,
            artifacts: [],
          },
          observationDir,
          exitCode: 0,
          stdout,
          stderr:
            stderr + `\nparse error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });

    // Handle timeout
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        record: {
          observer: { id: 'pfl', version: null },
          status: 'unavailable',
          reason: 'timeout',
          completeness: null,
          snapshot_ids: null,
          artifacts: [],
        },
        observationDir,
        exitCode: 1,
        stdout,
        stderr: stderr + '\ntimeout: pfl execution timed out',
      });
    }, timeoutMs);
  });
}
