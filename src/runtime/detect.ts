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
      versionSupported: null,
      executablePath: command,
      authUsable: null,
    };
  } catch {
    return {
      installed: false,
      version: null,
      versionSupported: null,
      executablePath: null,
      authUsable: null,
    };
  }
}

export function isVersionAtLeast(
  version: string | null,
  minimum: [number, number, number],
): boolean | null {
  if (!version) return null;
  const matches = [...version.matchAll(/(\d+)\.(\d+)(?:\.(\d+))?/g)];
  const match = matches.at(-1);
  if (!match) return null;
  const actual: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3] ?? 0),
  ];
  return (
    actual[0] > minimum[0] ||
    (actual[0] === minimum[0] &&
      (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2])))
  );
}
