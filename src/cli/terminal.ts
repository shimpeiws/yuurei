import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function linuxOwnsTerminal(stat: string): boolean {
  // The parenthesized command can itself contain spaces and closing parentheses.
  const end = stat.lastIndexOf(')');
  if (end === -1) return false;
  const [, , group, , terminal, foreground] = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/u);
  return Number(group) > 0 && Number(terminal) !== 0 && group === foreground;
}

export function ownsTerminal(): boolean {
  if (!process.stderr.isTTY) return false;
  try {
    if (process.platform === 'linux') {
      return linuxOwnsTerminal(readFileSync('/proc/self/stat', 'utf8'));
    }
    if (process.platform !== 'darwin') return false;
    const [group, foreground] = execFileSync(
      '/bin/ps',
      ['-o', 'pgid=,tpgid=', '-p', String(process.pid)],
      { encoding: 'utf8', timeout: 250, stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split(/\s+/u);
    return Number(group) > 0 && group === foreground;
  } catch {
    return false;
  }
}
