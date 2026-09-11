import type { ResolvedCell } from '../../cell/types.js';

/**
 * Builds the non-interactive CLI invocation for Codex. Kept isolated from
 * the rest of the codebase so a future CLI flag change only touches this
 * file (design doc §6.1: adapter-internal conventions must not leak).
 *
 * `-c` overrides always win over a config.toml value (verified against the
 * real `codex` CLI). Forcing the credential store to `file` here, at the
 * adapter boundary, closes an isolation bypass: a materialized profile's
 * own `config.toml` could otherwise set `cli_auth_credentials_store =
 * "keyring"` (or "auto", which prefers the keyring when available) and read
 * or refresh the operator's real OS-keychain-backed credential — entirely
 * outside the isolated CODEX_HOME, regardless of whether
 * --bridge-codex-auth-file was ever passed. mcp_oauth_credentials_store
 * defaults to "auto" for the same reason and gets the same override. This
 * doesn't need to defend against a profile's own -p/--profile config layer,
 * since this adapter never passes -p — only the single materialized
 * config.toml is ever in play.
 */
export function buildCodexArgs(cell: ResolvedCell): string[] {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-c',
    'cli_auth_credentials_store="file"',
    '-c',
    'mcp_oauth_credentials_store="file"',
    cell.resolvedTask.content,
  ];
  if (cell.requestedModel) {
    args.push('--model', cell.requestedModel);
  }
  return args;
}
