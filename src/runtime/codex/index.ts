import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IsolationContext } from '../../isolation/types.js';
import { configRootOf } from '../../isolation/config-root.js';
import type { ResolvedCell } from '../../cell/types.js';
import { EXIT_CODES, YuureiError } from '../../cli/exit-codes.js';
import { detectViaVersionFlag } from '../detect.js';
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
 * access/refresh token pair can.
 */
function bridgeCodexApiKey(env: Record<string, string>): void {
  const value = process.env['OPENAI_API_KEY'];
  if (value) env['OPENAI_API_KEY'] = value;
}

function wantsCodexAuthFileBridge(executionOptions: Record<string, unknown>): boolean {
  return executionOptions['bridgeCodexAuthFile'] === true;
}

/**
 * Experimental, opt-in method for reusing an interactive ChatGPT login: copy
 * exactly ~/.codex/auth.json into the isolated CODEX_HOME at mode 0600. Not
 * the supported v0.3 path — that's bridgeCodexApiKey above — because this
 * file can carry a rotating OAuth token pair. If `codex exec` refreshes the
 * token mid-run, only the isolated copy receives the new state; the real
 * ~/.codex/auth.json stays stale, and the valid rotated copy is then deleted
 * by the pipeline's unconditional credential scrub. Writing the rotated
 * state back to the real file would fix that but violates principle 1 (never
 * modify the user's existing global configuration), so this is left as a
 * known, documented limitation rather than "fixed" by breaking that
 * guarantee — callers who opt in accept it. Copies nothing else from the
 * real ~/.codex; a copy rather than a symlink for the same reason (a symlink
 * would let a token refresh write *through* to the real file).
 *
 * `destDir` is guaranteed to hold no `auth.json` before this runs
 * (assertNoReservedAuthFileKey rejects a profile-supplied one earlier in
 * prepare()), so on any failure below the dest is left absent, not stale —
 * the run then runs genuinely unauthenticated rather than under a wrong or
 * partial credential. Returns whether a file was actually written, so the
 * caller knows whether there's anything to scrub later.
 */
async function bridgeCodexAuthFile(destDir: string): Promise<boolean> {
  // homedir() follows process.env.HOME, so a test override of process.env.HOME
  // reaches this lookup — matching how Level1Isolation.verify() locates the real home.
  const realCodexHome = codexConfigDir(homedir());
  const sourcePath = join(realCodexHome, 'auth.json');
  const dest = join(destDir, 'auth.json');

  // Graft from synthesis.md: guard against auth.json itself being a symlink that
  // escapes ~/.codex (e.g. -> ~/.ssh/id_rsa). Non-fatal — return rather than throw.
  if (!(await isPathWithin(realCodexHome, sourcePath))) return false;
  if (!(await pathExists(sourcePath))) return false;

  // Best-effort per §12.2: any I/O failure here (permission error, a source
  // file removed between the checks above and the copy, a full disk) must
  // not abort the run — it must leave the run unauthenticated, same as a
  // missing source file. destDir already exists (prepare() creates it).
  try {
    await copyFile(sourcePath, dest);
    await chmod(dest, 0o600);
    return true;
  } catch {
    // Don't leave a partial copy (e.g. chmod failed after copyFile succeeded)
    // sitting at the reserved path — absent is the only safe failure state.
    await rm(dest, { force: true }).catch(() => undefined);
    return false;
  }
}

export class CodexRuntime implements Runtime {
  id(): string {
    return RUNTIME_ID;
  }

  async detect(): Promise<RuntimeDetection> {
    return detectViaVersionFlag(COMMAND);
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
    bridgeCodexApiKey(env);

    const credentialFilePaths: string[] = [];
    if (wantsCodexAuthFileBridge(cell.executionOptions)) {
      const wrote = await bridgeCodexAuthFile(configDir);
      if (wrote) credentialFilePaths.push(join(configDir, 'auth.json'));
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
