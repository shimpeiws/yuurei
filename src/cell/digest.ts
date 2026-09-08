import { canonicalJsonStringify } from '../util/json.js';
import { sha256Digest } from '../util/hash.js';
import type { CellIdentityInput } from './types.js';

/**
 * cell_digest = hash(runtime identity, requested model, resolved profile
 * contents, task contents, yuurei version, relevant execution options) —
 * design doc §7.3. Hashed over resolved content, never over profile/task
 * names alone, so two profiles with the same name but different contents
 * never collide.
 */
export function computeCellDigest(input: CellIdentityInput): string {
  return sha256Digest(canonicalJsonStringify(input));
}
