import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IsolationContext } from '../../isolation/types.js';
import { configRootOf } from '../../isolation/config-root.js';
import type { ResolvedCell } from '../../cell/types.js';
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
 * Approved method (design doc §9.2) for Codex: copy exactly ~/.codex/auth.json
 * into the isolated CODEX_HOME at mode 0600. Copies nothing else from the real
 * ~/.codex. A copy rather than a symlink, because a symlink would let a token
 * refresh inside the isolated run write *through* to the user's real auth.json
 * — that is contamination of global config, which principle 1 forbids.
 * Best-effort: a missing source file or a symlink-escape is not an error (§12.2).
 */
async function bridgeCodexCredentials(destDir: string): Promise<void> {
  // homedir() follows process.env.HOME, so a test override of process.env.HOME
  // reaches this lookup — matching how Level1Isolation.verify() locates the real home.
  const realCodexHome = codexConfigDir(homedir());
  const sourcePath = join(realCodexHome, 'auth.json');

  // Graft from synthesis.md: guard against auth.json itself being a symlink that
  // escapes ~/.codex (e.g. -> ~/.ssh/id_rsa). Non-fatal — return rather than throw.
  if (!(await isPathWithin(realCodexHome, sourcePath))) return;
  if (!(await pathExists(sourcePath))) return;

  // Best-effort per §12.2: any I/O failure here (permission error, a source
  // file removed between the checks above and the copy, a full disk) must
  // not abort the run — it must leave the run unauthenticated, same as a
  // missing source file. destDir already exists (prepare() creates it).
  try {
    const dest = join(destDir, 'auth.json');
    await copyFile(sourcePath, dest);
    await chmod(dest, 0o600);
  } catch {
    return;
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
    // ORDER IS AN INVARIANT: profile content first, credentials second, so the
    // bridged auth.json always wins over a stray auth.json inside a profile.
    // (§9.2 forbids credentials in profiles; this makes the violation harmless.)
    await writeFileTree(configDir, cell.resolvedProfile.content.configFiles);
    await bridgeCodexCredentials(configDir);
    env['CODEX_HOME'] = configDir;

    return {
      runtimeId: RUNTIME_ID,
      command: COMMAND,
      args: buildCodexArgs(cell),
      env,
      cwd: isolation.rootDir,
      isolation,
      cell,
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
