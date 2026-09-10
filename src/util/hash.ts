import { createHash } from 'node:crypto';

/** Returns a `sha256:<hex>` digest of the given content. */
export function sha256Digest(content: string | Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return `sha256:${hash}`;
}
