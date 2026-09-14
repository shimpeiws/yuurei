import { chmod, copyFile, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EXIT_CODES, YuureiError } from '../../cli/exit-codes.js';
import type { ExecutionOptions } from '../../cell/types.js';
import { pathExists } from '../../util/fs.js';
import { isRealPathWithin } from './path-safety.js';
import { realOpenCodeDataDir } from './paths.js';

/**
 * Provider API-key environment variables the adapter forwards from the parent
 * environment (design doc §20.6). Forwarding an explicitly-set env var writes
 * nothing to disk and carries no rotation risk, so this is the supported
 * mechanism. Kept as a fixed, adapter-owned allowlist: a key outside this set
 * is not forwarded. Document this list when the adapter ships.
 */
const OPENCODE_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
] as const;

/** Forwards each allowlisted, explicitly-set provider key; returns the values to redact. */
export function bridgeOpenCodeApiKeys(env: Record<string, string>): string[] {
  const forwardedValues: string[] = [];
  for (const key of OPENCODE_CREDENTIAL_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
      forwardedValues.push(value);
    }
  }
  return forwardedValues;
}

export function wantsOpenCodeAuthFileBridge(executionOptions: ExecutionOptions): boolean {
  return executionOptions.runtime['bridge_opencode_auth_file'] === true;
}

/**
 * Best-effort extraction of the secret values inside a bridged OpenCode
 * auth.json so the pipeline can redact them from persisted logs by exact value.
 * The observed shape is `{ "<provider>": { "type": "api", "key": "..." } }`;
 * OAuth entries may instead carry `access`/`refresh` (and snake_case variants).
 * Never throws: a file we just copied failing to re-parse is treated as
 * nothing-to-redact, not a reason to fail preparation.
 */
async function extractOpenCodeAuthSecrets(path: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    const values: string[] = [];
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      for (const key of ['key', 'access', 'refresh', 'access_token', 'refresh_token', 'id_token']) {
        const value = record[key];
        if (typeof value === 'string') values.push(value);
      }
    }
    return values;
  } catch {
    return [];
  }
}

/**
 * Experimental, opt-in method for reusing the operator's file-based OpenCode
 * login: copy exactly `<real data dir>/opencode/auth.json` into the isolated
 * data dir at mode 0600 (design doc §20.6). Not the supported path — that is
 * environment forwarding above — because the file can carry a rotating OAuth
 * token pair, and yuurei's copy-run-discard lifecycle cannot reconcile a
 * mid-run refresh (the isolated copy may rotate while the real file stays
 * stale, and the rotated copy is then scrubbed). Writing the rotated state
 * back would violate "never modify the user's existing global configuration".
 *
 * The source path is adapter-fixed and cannot be chosen by a profile; the
 * destination is a fixed cell path. `destDir` holds no auth.json before this
 * runs, so a failed copy leaves it absent, not stale — unless cleaning up the
 * failed copy also fails (double fault). prepare() has already registered the
 * destination for the pipeline's scrub, but a double fault still throws rather
 * than returning as if nothing were bridged: aborting is judged safer than
 * launching OpenCode against a leftover, untracked credential file at a
 * reserved path. This mirrors Codex's `bridgeCodexAuthFile` and is the one
 * deliberate exception to "bridging failure leaves the run unauthenticated"
 * (§12.2); it is documented in the adapter's comment rather than silent.
 */
export async function bridgeOpenCodeAuthFile(dataDir: string): Promise<string[]> {
  // homedir() follows process.env.HOME, matching Level1Isolation.verify()'s
  // real-home lookup, so a test override of HOME reaches this.
  const realDataDir = realOpenCodeDataDir(homedir());
  const sourcePath = join(realDataDir, 'auth.json');
  const dest = join(dataDir, 'auth.json');

  // Guard against auth.json itself being a symlink that escapes the real data
  // dir (e.g. -> ~/.ssh/id_rsa). Strict: an unresolvable source (EACCES, ELOOP)
  // propagates and refuses the bridge rather than copying an unverified path.
  if (!(await isRealPathWithin(realDataDir, sourcePath))) return [];
  if (!(await pathExists(sourcePath))) return [];

  try {
    await copyFile(sourcePath, dest);
    await chmod(dest, 0o600);
  } catch (bridgeError) {
    try {
      await rm(dest, { force: true });
    } catch (cleanupError) {
      throw new YuureiError(
        `failed to bridge OpenCode credentials (${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)}) and could not remove the partial copy left at ${dest}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        EXIT_CODES.ISOLATION_VERIFICATION_FAILED,
      );
    }
    return [];
  }

  return extractOpenCodeAuthSecrets(dest);
}
