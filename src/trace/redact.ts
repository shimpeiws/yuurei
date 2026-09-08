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
