import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IsolationContext } from '../../isolation/types.js';
import { configRootOf } from '../../isolation/config-root.js';
import type { ResolvedCell } from '../../cell/types.js';
import { EXIT_CODES, YuureiError } from '../../cli/exit-codes.js';
import { detectViaVersionFlag, isVersionAtLeast } from '../detect.js';
import { execCapture } from '../exec.js';
import type {
  NormalizedTraceFragment,
  PreparedRun,
  Runtime,
  RuntimeDetection,
  RuntimeResult,
} from '../types.js';
import { isPathWithin, pathExists, writeFileTree } from '../../util/fs.js';
import { buildCodexArgs } from './args.js';
import { codexConfigDir } from './paths.js';

const RUNTIME_ID = 'codex';
const COMMAND = 'codex';
const MIN_SUPPORTED_VERSION: [number, number, number] = [0, 100, 0];

/**
 * Root-level `auth.json` is reserved for the opt-in bridged credential (see
 * bridgeCodexAuthFile below) and must never be satisfiable by profile
 * content, regardless of whether that bridge is even enabled for this run.
 * Without this, a profile shipping its own `config/auth.json` would survive
 * untouched whenever the bridge no-ops or fails (including simply being
 * disabled), so the run would silently authenticate with whatever the
 * profile supplied instead of the operator's real credential. Case-
 * insensitive because Codex resolves this file by name on a filesystem that
 * may not be case-sensitive.
 */
function assertNoReservedAuthFileKey(configFiles: Record<string, string>): void {
  const collision = Object.keys(configFiles).find((key) => key.toLowerCase() === 'auth.json');
  if (collision !== undefined) {
    throw new YuureiError(
      `profile config may not provide "${collision}": this path is reserved for the bridged Codex credential`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
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
 * (assertNoReservedAuthFileKey rejects a profile-supplied one earlier in
 * prepare()), so on any failure below the dest is left absent, not stale —
 * the run then runs genuinely unauthenticated rather than under a wrong or
 * partial credential — UNLESS cleaning up a failed copy also fails (a
 * double fault: e.g. copyFile succeeds but chmod then fails, and the
 * catch-block's own rm() fails too). In that case the file at `dest` is
 * left in an unknown, unregistered state that nothing would otherwise
 * retry scrubbing, so this throws rather than silently returning as if
 * nothing were bridged — aborting prepare() is judged safer than launching
 * Codex against a leftover, un-tracked credential file at a reserved path.
 */
async function bridgeCodexAuthFile(
  destDir: string,
): Promise<{ wrote: boolean; secretValues: string[] }> {
  // homedir() follows process.env.HOME, so a test override of process.env.HOME
  // reaches this lookup — matching how Level1Isolation.verify() locates the real home.
  const realCodexHome = codexConfigDir(homedir());
  const sourcePath = join(realCodexHome, 'auth.json');
  const dest = join(destDir, 'auth.json');

  // Graft from synthesis.md: guard against auth.json itself being a symlink that
  // escapes ~/.codex (e.g. -> ~/.ssh/id_rsa). Non-fatal — return rather than throw.
  if (!(await isPathWithin(realCodexHome, sourcePath))) return { wrote: false, secretValues: [] };
  if (!(await pathExists(sourcePath))) return { wrote: false, secretValues: [] };

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
    return { wrote: false, secretValues: [] };
  }

  return { wrote: true, secretValues: await extractCodexAuthSecrets(dest) };
}

export class CodexRuntime implements Runtime {
  id(): string {
    return RUNTIME_ID;
  }

  async detect(): Promise<RuntimeDetection> {
    const detection = await detectViaVersionFlag(COMMAND);
    const authFile = join(codexConfigDir(homedir()), 'auth.json');
    return {
      ...detection,
      versionSupported: isVersionAtLeast(detection.version, MIN_SUPPORTED_VERSION),
      authUsable:
        Boolean(process.env['OPENAI_API_KEY']) ||
        (detection.installed && (await pathExists(authFile))),
    };
  }

  async prepare(cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> {
    const env = { ...isolation.env };
    const configDir = codexConfigDir(configRootOf(isolation));
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    // A profile must never be able to supply its own auth.json (§9.2) — reject
    // it before anything is written, rather than relying on write order to
    // paper over the collision (a bridge that no-ops or fails would otherwise
    // let a profile-supplied credential silently survive).
    assertNoReservedAuthFileKey(cell.resolvedProfile.content.configFiles);
    await writeFileTree(configDir, cell.resolvedProfile.content.configFiles);
    const credentialValuesToRedact = bridgeCodexApiKey(env);

    const credentialFilePaths: string[] = [];
    if (wantsCodexAuthFileBridge(cell.executionOptions)) {
      const { wrote, secretValues } = await bridgeCodexAuthFile(configDir);
      if (wrote) credentialFilePaths.push(join(configDir, 'auth.json'));
      credentialValuesToRedact.push(...secretValues);
    }

    env['CODEX_HOME'] = configDir;

    return {
      runtimeId: RUNTIME_ID,
      command: COMMAND,
      args: buildCodexArgs(cell),
      env,
      cwd: isolation.rootDir,
      isolation,
      cell,
      credentialFilePaths,
      credentialValuesToRedact,
    };
  }

  async execute(run: PreparedRun): Promise<RuntimeResult> {
    return execCapture({
      command: run.command,
      args: run.args,
      env: run.env,
      cwd: run.cwd,
      stdoutPath: join(run.isolation.rootDir, 'stdout.log'),
      stderrPath: join(run.isolation.rootDir, 'stderr.log'),
    });
  }

  async normalize(result: RuntimeResult): Promise<NormalizedTraceFragment> {
    const durationMs = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();

    return {
      runtime: { id: RUNTIME_ID, version: null },
      model: { requested: '', resolved: null },
      execution: { exitCode: result.exitCode, durationMs },
      usage: {},
    };
  }
}
