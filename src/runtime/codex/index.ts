import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IsolationContext } from '../../isolation/types.js';
import { configRootOf } from '../../isolation/config-root.js';
import type { ResolvedCell } from '../../cell/types.js';
import { EXIT_CODES, YuureiError } from '../../cli/exit-codes.js';
import { detectViaVersionFlag, isVersionAtLeast } from '../detect.js';
import { execCapture } from '../exec.js';
import type {
  NormalizationContext,
  NormalizedTraceFragment,
  PreparedRun,
  RegisterCredentialPath,
  Runtime,
  RuntimeDetection,
  RuntimeResult,
} from '../types.js';
import { isPathWithin, pathExists, writeFileTree } from '../../util/fs.js';
import { assertNoReservedConfigPath } from '../reserved-paths.js';
import { buildCodexArgs } from './args.js';
import { codexConfigDir } from './paths.js';

const RUNTIME_ID = 'codex';
const COMMAND = 'codex';
const MIN_SUPPORTED_VERSION: [number, number, number] = [0, 100, 0];

/**
 * Root-level `auth.json` is reserved for the opt-in bridged credential (see
 * bridgeCodexAuthFile below). See `assertNoReservedConfigPath` for why this is
 * enforced even when the bridge is disabled.
 */
const CODEX_RESERVED_CONFIG_PATHS = ['auth.json'] as const;
const CODEX_STDIN_NOTICE = 'Reading additional input from stdin...';

/** Remove Codex's benign non-interactive stdin notice from durable stderr logs. */
export function stripCodexStdinNotice(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => line !== CODEX_STDIN_NOTICE && line !== `${CODEX_STDIN_NOTICE}\r`)
    .join('\n');
}

/**
 * Supported v0.3 method (design doc §9.2) for Codex: forward an explicitly-set
 * API key from the parent environment, exactly mirroring how the Claude Code
 * adapter forwards ANTHROPIC_API_KEY. Verified against the real `codex` CLI:
 * `codex exec` authenticates from OPENAI_API_KEY in the environment with no
 * ~/.codex/auth.json present at all, so this needs no file on disk and carries
 * no rotation risk — an API key doesn't rotate mid-run the way an OAuth
 * access/refresh token pair can. Returns the forwarded value (if any) so the
 * pipeline can redact it from persisted logs.
 */
function bridgeCodexApiKey(env: Record<string, string>): string[] {
  const value = process.env['OPENAI_API_KEY'];
  if (!value) return [];
  env['OPENAI_API_KEY'] = value;
  return [value];
}

function wantsCodexAuthFileBridge(executionOptions: Record<string, unknown>): boolean {
  return executionOptions['bridgeCodexAuthFile'] === true;
}

/**
 * Best-effort extraction of the actual secret values inside a bridged
 * auth.json (the API-key field, plus the OAuth token triple when present —
 * see the `auth_mode`/`tokens` shape Codex itself writes), so the pipeline
 * can redact them from persisted logs by exact value rather than by a
 * pattern that may not match an opaque token or JWT. Never throws: a file
 * we just copied ourselves failing to re-parse is treated the same as
 * finding nothing to redact, not as a reason to fail preparation.
 */
async function extractCodexAuthSecrets(path: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    const record = parsed as Record<string, unknown>;

    const values: string[] = [];
    const apiKey = record['OPENAI_API_KEY'];
    if (typeof apiKey === 'string') values.push(apiKey);

    const tokens = record['tokens'];
    if (typeof tokens === 'object' && tokens !== null) {
      const tokenRecord = tokens as Record<string, unknown>;
      for (const key of ['access_token', 'refresh_token', 'id_token']) {
        const value = tokenRecord[key];
        if (typeof value === 'string') values.push(value);
      }
    }
    return values;
  } catch {
    return [];
  }
}

/**
 * Experimental, opt-in method for reusing an interactive ChatGPT login: copy
 * exactly ~/.codex/auth.json into the isolated CODEX_HOME at mode 0600. Not
 * the supported v0.3 path — that's bridgeCodexApiKey above — because this
 * file can carry a rotating OAuth token pair. If `codex exec` refreshes the
 * token mid-run, only the isolated copy receives the new state; the real
 * ~/.codex/auth.json stays stale, and the valid rotated copy is then deleted
 * by the pipeline's credential scrub. Writing the rotated state back to the
 * real file would fix that but violates principle 1 (never modify the
 * user's existing global configuration), so this is left as a known,
 * documented limitation rather than "fixed" by breaking that guarantee —
 * callers who opt in accept it. Copies nothing else from the real ~/.codex;
 * a copy rather than a symlink for the same reason (a symlink would let a
 * token refresh write *through* to the real file).
 *
 * `destDir` is guaranteed to hold no `auth.json` before this runs
 * (assertNoReservedConfigPath rejects a profile-supplied one earlier in
 * prepare()), so on any failure below the dest is left absent, not stale —
 * the run then runs genuinely unauthenticated rather than under a wrong or
 * partial credential — UNLESS cleaning up a failed copy also fails (a
 * double fault: e.g. copyFile succeeds but chmod then fails, and the
 * catch-block's own rm() fails too). In that case the file at `dest` is
 * left in an unknown state. prepare() already registered `dest` with the
 * pipeline before this call, so the scrub retries the removal during
 * cleanup; if that second removal also fails the pipeline reports the
 * residual path via onWarning. This still throws (rather than silently
 * returning as if nothing were bridged) because aborting prepare() is
 * judged safer than launching Codex against a leftover, untracked
 * credential file at a reserved path.
 */
async function bridgeCodexAuthFile(destDir: string): Promise<string[]> {
  // homedir() follows process.env.HOME, so a test override of process.env.HOME
  // reaches this lookup — matching how Level1Isolation.verify() locates the real home.
  const realCodexHome = codexConfigDir(homedir());
  const sourcePath = join(realCodexHome, 'auth.json');
  const dest = join(destDir, 'auth.json');

  // Graft from synthesis.md: guard against auth.json itself being a symlink that
  // escapes ~/.codex (e.g. -> ~/.ssh/id_rsa). Non-fatal — return rather than throw.
  if (!(await isPathWithin(realCodexHome, sourcePath))) return [];
  if (!(await pathExists(sourcePath))) return [];

  // Best-effort per §12.2: any I/O failure here (permission error, a source
  // file removed between the checks above and the copy, a full disk) must
  // not abort the run — it must leave the run unauthenticated, same as a
  // missing source file. destDir already exists (prepare() creates it).
  try {
    await copyFile(sourcePath, dest);
    await chmod(dest, 0o600);
  } catch (bridgeError) {
    // Don't leave a partial copy (e.g. chmod failed after copyFile succeeded)
    // sitting at the reserved path — absent is the only safe failure state.
    try {
      await rm(dest, { force: true });
    } catch (cleanupError) {
      throw new YuureiError(
        `failed to bridge Codex credentials (${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)}) and could not remove the partial copy left at ${dest}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        EXIT_CODES.ISOLATION_VERIFICATION_FAILED,
      );
    }
    return [];
  }

  return extractCodexAuthSecrets(dest);
}

export class CodexRuntime implements Runtime {
  id(): string {
    return RUNTIME_ID;
  }

  async detect(): Promise<RuntimeDetection> {
    const detection = await detectViaVersionFlag(COMMAND);
    const authUsable = detection.installed && Boolean(process.env['OPENAI_API_KEY']);
    return {
      ...detection,
      versionSupported: isVersionAtLeast(detection.version, MIN_SUPPORTED_VERSION),
      authUsable,
      ...(detection.installed && authUsable === false
        ? {
            authGuidance:
              'Export OPENAI_API_KEY in this shell and re-run `yuurei doctor`. ' +
              'A shell export applies only to that shell and its child processes; do not persist the key in a profile, task, or committed file. ' +
              'Verify the variable is set without printing its value: [ -n "$OPENAI_API_KEY" ] && echo present || echo absent',
          }
        : {}),
    };
  }

  async prepare(
    cell: ResolvedCell,
    isolation: IsolationContext,
    registerCredentialPath: RegisterCredentialPath,
  ): Promise<PreparedRun> {
    const env = { ...isolation.env };
    const configDir = codexConfigDir(configRootOf(isolation));
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    // A profile must never be able to supply its own auth.json (§9.2) — reject
    // it before anything is written, rather than relying on write order to
    // paper over the collision (a bridge that no-ops or fails would otherwise
    // let a profile-supplied credential silently survive).
    assertNoReservedConfigPath(
      configDir,
      cell.resolvedProfile.content.configFiles,
      CODEX_RESERVED_CONFIG_PATHS,
    );
    await writeFileTree(configDir, cell.resolvedProfile.content.configFiles);
    const credentialValuesToRedact = bridgeCodexApiKey(env);

    if (wantsCodexAuthFileBridge(cell.executionOptions)) {
      // Register the destination before the copy. A signal or throw between
      // the write and prepare()'s return — or the documented double fault,
      // where the adapter's own cleanup rm() fails — must still leave the file
      // on the scrub list; the pipeline removes a registered path even on
      // paths where no PreparedRun is ever returned (§9.2). Registering a path
      // the copy never reaches is harmless: the scrub's rm has `force: true`.
      registerCredentialPath(join(configDir, 'auth.json'));
      const secretValues = await bridgeCodexAuthFile(configDir);
      credentialValuesToRedact.push(...secretValues);
    }

    env['CODEX_HOME'] = configDir;

    const detection = await this.detect();

    return {
      runtimeId: RUNTIME_ID,
      command: COMMAND,
      args: buildCodexArgs(cell),
      env,
      cwd: isolation.rootDir,
      isolation,
      cell,
      runtimeVersion: detection.version,
      credentialValuesToRedact,
    };
  }

  async execute(run: PreparedRun, timeoutMs: number | null): Promise<RuntimeResult> {
    const result = await execCapture({
      command: run.command,
      args: run.args,
      env: run.env,
      cwd: run.cwd,
      stdoutPath: join(run.isolation.rootDir, 'stdout.log'),
      stderrPath: join(run.isolation.rootDir, 'stderr.log'),
      ...(timeoutMs !== null ? { timeoutMs } : {}),
    });
    const stderr = await readFile(result.stderrPath, 'utf8');
    const filteredStderr = stripCodexStdinNotice(stderr);
    if (filteredStderr !== stderr) {
      await writeFile(result.stderrPath, filteredStderr, 'utf8');
    }
    return result;
  }

  async normalize(
    result: RuntimeResult,
    context: NormalizationContext,
  ): Promise<NormalizedTraceFragment> {
    const durationMs = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();

    let usage: Record<string, number | null> = {};
    const warnings: string[] = [];
    try {
      const stdout = await readFile(result.stdoutPath, 'utf8');
      // Scan all lines to count every malformed line (including those after
      // turn.completed) and to treat valid-JSON non-objects as malformed too.
      let firstCompleted: Record<string, unknown> | null = null;
      let malformedLineCount = 0;
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          malformedLineCount++;
          continue;
        }
        if (typeof event !== 'object' || event === null) {
          // Valid JSON but not an object (null, string, number) — not a valid event
          malformedLineCount++;
          continue;
        }
        const obj = event as Record<string, unknown>;
        if (obj['type'] === 'turn.completed' && firstCompleted === null) {
          firstCompleted = obj;
        }
      }
      if (malformedLineCount > 0) {
        warnings.push(`codex: ${malformedLineCount} unparseable JSONL line(s) skipped`);
      }
      if (firstCompleted !== null) {
        const usageRaw = firstCompleted['usage'];
        if (typeof usageRaw === 'object' && usageRaw !== null) {
          const u = usageRaw as Record<string, unknown>;
          const pick = (key: string): number | null => {
            const v = u[key];
            return typeof v === 'number' ? v : null;
          };
          usage = {
            input_tokens: pick('input_tokens'),
            output_tokens: pick('output_tokens'),
            cached_input_tokens: pick('cached_input_tokens'),
            cache_write_input_tokens: pick('cache_write_input_tokens'),
            reasoning_output_tokens: pick('reasoning_output_tokens'),
          };
        } else {
          warnings.push('codex: turn.completed event had no usage field — usage unobserved');
        }
      } else {
        warnings.push('codex: no turn.completed event found in stdout — usage unobserved');
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Missing stdout is expected for killed/timed-out runs; warn only on normal exit
        if (result.exitCode === 0 && result.signal === null && !result.timedOut) {
          warnings.push('codex: stdout absent after normal exit — usage unobserved');
        }
      } else {
        warnings.push(
          `codex: stdout unreadable (${err instanceof Error ? err.message : String(err)}) — usage unobserved`,
        );
      }
    }

    return {
      runtime: { id: RUNTIME_ID, version: context.runtimeVersion },
      model: { requested: '', resolved: null },
      execution: { exitCode: result.exitCode, signal: result.signal, durationMs },
      usage,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
