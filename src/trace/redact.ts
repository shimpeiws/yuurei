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
 * Below this length, a "known value" is refused rather than redacted: a
 * malformed or truncated credential file could otherwise hand this function
 * a one- or two-character string, which would then blank out every
 * occurrence of that character across the whole log. Real API keys and
 * OAuth tokens are always far longer than this.
 */
const MIN_REDACTABLE_LENGTH = 8;

/**
 * Exact-match redaction of specific known secret values reported by the
 * runtime adapter that produced them (as opposed to redactSecrets' generic
 * shape-based patterns, which won't catch a credential that doesn't happen
 * to look like `sk-...` or `Bearer ...` — an OAuth access/refresh token
 * embedded in a bridged Codex auth.json, for instance). Literal split/join
 * rather than a constructed RegExp, since a credential value may itself
 * contain regex metacharacters.
 */
export function redactKnownValues(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of values) {
    if (value.length < MIN_REDACTABLE_LENGTH) continue;
    result = result.split(value).join(REDACTED);
  }
  return result;
}
