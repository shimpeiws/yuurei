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

/**
 * The shared redact-and-cap core: whole-buffer redaction, then a byte-exact
 * prefix. `inputTruncated` reports the stream's early stop, so the flag means
 * "the artifact does not contain the complete input" regardless of how much
 * redaction removed.
 */
function redactAndCap(
  buffered: string,
  values: readonly string[],
  maxBytes: number,
  inputTruncated: boolean,
): { text: string; truncated: boolean; redacted: boolean } {
  let output = redactSecrets(redactKnownValues(buffered, values));
  output = redactTerminalKnownPrefix(output, values);
  const truncated = inputTruncated || Buffer.byteLength(output, 'utf8') > maxBytes;
  return { text: utf8Prefix(output, maxBytes), truncated, redacted: output !== buffered };
}

/**
 * The in-memory counterpart of `redactFile`, for payloads that already
 * exist as a string (the runtime's final message, the workspace patch).
 * Staging such a payload to disk only to read it back would write a second,
 * unredacted copy and spend disk proportional to the full input. The payload
 * is redacted in full before the byte cap is applied: capping the raw string
 * first would drop text the redacted result can still retain (a known
 * credential repeated through the payload shrinks far below the cap) and
 * report `truncated` for output that fits. The caller persists only the
 * bounded, redacted result.
 */
export function redactText(
  text: string,
  values: readonly string[],
  maxBytes = DEFAULT_LOG_MAX_BYTES,
): { text: string; truncated: boolean; redacted: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  return redactAndCap(text, values, maxBytes, false);
}

/**
 * Redacts and persists a log without retaining the complete input in
 * memory. Raw input is buffered only until the byte cap is exceeded (plus
 * at most one read chunk), so memory usage is bounded by `maxBytes`
 * regardless of log length or credential length. Redaction runs over the
 * whole buffered prefix, so a known value or secret pattern that spans any
 * number of read chunks is still removed; when the byte cap cuts a stream
 * mid-credential, the surviving prefix is additionally redacted.
 *
 * The result reports whether the stored bytes were cut at the cap and
 * whether the redaction pass changed them — a consumer that needs to know
 * the stored text is a faithful record of the input (the patch
 * completeness mark, #202) reads `redacted`; one that only needs the cap
 * reads `truncated`.
 */
export interface RedactFileResult {
  truncated: boolean;
  redacted: boolean;
}

export async function redactFile(
  inputPath: string,
  outputPath: string,
  values: readonly string[],
  maxBytes = DEFAULT_LOG_MAX_BYTES,
): Promise<RedactFileResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  let output = '';
  let stoppedEarly = false;

  for await (const chunk of createReadStream(inputPath, { encoding: 'utf8' })) {
    output += chunk;
    if (Buffer.byteLength(output, 'utf8') > maxBytes) {
      stoppedEarly = true;
      break;
    }
  }

  const { text, truncated, redacted } = redactAndCap(output, values, maxBytes, stoppedEarly);
  await writeFile(outputPath, text, 'utf8');
  return { truncated, redacted };
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

/**
 * Redacts the tail of a stream when it ends with the prefix of a known
 * value — i.e. the stream was cut (by the byte cap or a crashed writer)
 * while a credential was still being written. Only prefixes that already
 * meet the minimum redactable length are considered, so clean log endings
 * are untouched. Each value's first character is used to locate candidate
 * alignments, so the cost is negligible for logs that do not end in a
 * credential.
 */
function redactTerminalKnownPrefix(text: string, values: readonly string[]): string {
  let longest = 0;
  for (const value of values) {
    if (value.length < MIN_REDACTABLE_LENGTH) continue;
    const maxPrefix = Math.min(value.length - 1, text.length);
    if (maxPrefix < MIN_REDACTABLE_LENGTH) continue;
    const first = value[0];
    for (
      let start = text.length - maxPrefix;
      start <= text.length - MIN_REDACTABLE_LENGTH;
      start += 1
    ) {
      if (text[start] !== first) continue;
      const length = text.length - start;
      let i = 0;
      while (i < length && text[start + i] === value[i]) i += 1;
      if (i === length) {
        longest = Math.max(longest, length);
        break;
      }
    }
  }
  if (longest === 0) return text;
  return `${text.slice(0, text.length - longest)}${REDACTED}`;
}
