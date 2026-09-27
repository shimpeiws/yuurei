import { canonicalJsonStringify } from '../util/json.js';
import { sha256Digest } from '../util/hash.js';
import type { RequestedCellInput } from './types.js';

/**
 * Identifies the input set and canonicalization that produced a
 * `requested_cell.digest` (ADR-0009). Comparability is decided by this
 * identifier, never by the digest value: two digests carrying different
 * versions are never compared, even when they match. The hash function is
 * sha256 and stays sha256; what varies is *what is hashed*, so the field is
 * named for the inputs rather than the algorithm.
 */
export const REQUESTED_CELL_INPUTS_VERSION = 1;

/**
 * The input set version for a seeded run (#202): it adds the seed mode and
 * baseline identity to `RequestedCellInput`, which is a different input
 * contract and therefore a different version. Empty-workspace runs keep
 * version 1 — their input set is unchanged, so their digests remain
 * comparable with runs computed before seeding existed.
 */
export const REQUESTED_CELL_INPUTS_VERSION_SEEDED = 2;

/**
 * requested_cell_digest = hash(runtime id, requested model, resolved profile
 * content, task content, isolation strategy, identity-forming execution
 * contracts) — design doc §7.3, ADR-0011. Hashed over resolved content, never
 * over profile/task names alone, so two profiles with the same name but
 * different contents never collide.
 */
export function computeRequestedCellDigest(input: RequestedCellInput): string {
  return sha256Digest(canonicalJsonStringify(input));
}
