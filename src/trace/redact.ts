import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';

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

const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
const MAX_STREAMING_CARRY_LENGTH = 4096;

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

/** Redacts and persists a log without retaining the complete input in memory. */
export async function redactFile(
  inputPath: string,
  outputPath: string,
  values: readonly string[],
  maxBytes = DEFAULT_LOG_MAX_BYTES,
): Promise<boolean> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  const carryLength = Math.max(32, ...values.map((value) => value.length - 1));
  let carry = '';
  let output = '';
  let reachedCap = false;
  let truncated = false;

  for await (const chunk of createReadStream(inputPath, { encoding: 'utf8' })) {
    if (reachedCap) {
      truncated = true;
      break;
    }
    carry += chunk;
    const boundary = streamingBoundary(carry, carryLength, values);
    if (boundary === 0) continue;
    const hasIncompleteCandidate = incompleteCandidateExists(carry, boundary);
    output += redactStreamingPrefix(carry, boundary, values);
    carry = carry.slice(boundary);
    if (hasIncompleteCandidate) carry = carry.replace(/^[a-zA-Z0-9._-]+/, '');
    if (Buffer.byteLength(output, 'utf8') >= maxBytes) {
      reachedCap = true;
      truncated = Buffer.byteLength(output, 'utf8') > maxBytes;
    }
  }

  if (!reachedCap) {
    output += redactStreamingPrefix(carry, carry.length, values);
    truncated = Buffer.byteLength(output, 'utf8') > maxBytes;
  } else if (carry.length > 0) {
    truncated = true;
  }
  await writeFile(outputPath, utf8Prefix(output, maxBytes), 'utf8');
  return truncated;
}

function streamingBoundary(text: string, carryLength: number, values: readonly string[]): number {
  const protectedStart = Math.max(
    0,
    text.length - Math.min(carryLength, MAX_STREAMING_CARRY_LENGTH),
  );
  let boundary = protectedStart;
  for (const value of values) {
    if (value.length < MIN_REDACTABLE_LENGTH) continue;
    const completeStart = text.lastIndexOf(value);
    if (completeStart >= 0 && completeStart < boundary && completeStart + value.length > boundary) {
      boundary = completeStart;
    }
    const partialStart = Math.max(0, protectedStart - value.length + 1);
    for (let start = partialStart; start < protectedStart; start += 1) {
      const suffix = text.slice(start);
      if (suffix.length < value.length && value.startsWith(suffix)) {
        boundary = start;
        break;
      }
    }
  }
  const candidatePattern =
    /\b(?:sk-|Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = candidatePattern.exec(text)) !== null) {
    if (match.index >= protectedStart) boundary = Math.min(boundary, match.index);
  }
  return boundary;
}

function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = '';
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

function redactStreamingPrefix(text: string, boundary: number, values: readonly string[]): string {
  let prefix = text.slice(0, boundary);
  const candidatePattern =
    /\b(?:sk-|Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = candidatePattern.exec(text)) !== null) {
    if (match.index >= boundary) continue;
    const tail = text.slice(match.index + match[0].length, boundary);
    if (text.length > boundary && /^[a-zA-Z0-9._-]*$/.test(tail)) {
      prefix = `${prefix.slice(0, match.index)}${REDACTED}`;
    }
  }
  return redactSecrets(redactKnownValues(prefix, values));
}

function incompleteCandidateExists(text: string, boundary: number): boolean {
  const candidatePattern =
    /\b(?:sk-|Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?)/gi;
  let match: RegExpExecArray | null;
  while ((match = candidatePattern.exec(text)) !== null) {
    if (
      match.index < boundary &&
      text.length > boundary &&
      /^[a-zA-Z0-9._-]*$/.test(text.slice(match.index + match[0].length, boundary))
    ) {
      return true;
    }
  }
  return false;
}
