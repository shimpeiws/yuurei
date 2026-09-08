/**
 * Patterns for common secret shapes (API keys, bearer tokens, generic
 * long hex/base64 blobs following an assignment). This is a best-effort
 * safety net, not a guarantee — adapters must still avoid writing secrets
 * into anything that flows through here (design doc §10.2).
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[a-zA-Z0-9]{16,})\b/g,
  /\bBearer\s+[a-zA-Z0-9._-]{16,}\b/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[a-zA-Z0-9._-]{8,}['"]?/gi,
];

const REDACTED = '[REDACTED]';

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Env var names a runtime adapter may forward a real credential into
 * (ClaudeCodeRuntime.bridgeClaudeCredentials, CodexRuntime.bridgeCodexApiKey).
 * A single shared list rather than each adapter reporting its own, so
 * there's exactly one place to update when a new credential env var is
 * added, and the pipeline can redact known bridged values generically off
 * `PreparedRun.env` without adapter-specific knowledge leaking into it.
 */
export const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
] as const;

/**
 * Exact-match redaction of specific known secret values (as opposed to
 * redactSecrets' shape-based patterns, which won't catch a credential that
 * doesn't happen to look like `sk-...` or `Bearer ...`). Literal
 * split/join rather than a constructed RegExp, since a credential value
 * may itself contain regex metacharacters.
 */
export function redactKnownValues(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of values) {
    if (!value) continue;
    result = result.split(value).join(REDACTED);
  }
  return result;
}
