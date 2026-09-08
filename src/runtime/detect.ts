import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeDetection } from './types.js';

const execFileAsync = promisify(execFile);

/** Runs `<command> <versionFlag>` and reports whether the CLI is installed. */
export async function detectViaVersionFlag(
  command: string,
  versionFlag = '--version',
): Promise<RuntimeDetection> {
  try {
    const { stdout } = await execFileAsync(command, [versionFlag]);
    return {
      installed: true,
      version: stdout.trim() || null,
      executablePath: command,
      authUsable: null,
    };
  } catch {
    return {
      installed: false,
      version: null,
      executablePath: null,
      authUsable: null,
    };
  }
}
