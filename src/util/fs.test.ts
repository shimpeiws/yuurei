import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeUtf8Strict, isPathWithin } from './fs.js';

describe('isPathWithin', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('accepts descendants and rejects siblings', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-fs-'));
    const parent = join(root, 'parent');
    await mkdir(join(parent, 'child'), { recursive: true });

    await expect(isPathWithin(parent, join(parent, 'child'))).resolves.toBe(true);
    await expect(isPathWithin(parent, join(root, 'sibling'))).resolves.toBe(false);
  });

  it('resolves symlink targets before checking containment', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-fs-'));
    const parent = join(root, 'parent');
    const outside = join(root, 'outside');
    await mkdir(parent);
    await mkdir(outside);
    await symlink(outside, join(parent, 'link'));

    await expect(isPathWithin(parent, join(parent, 'link'))).resolves.toBe(false);
  });
});

describe('decodeUtf8Strict', () => {
  it('decodes a literal U+FFFD while rejecting invalid bytes', () => {
    // U+FFFD is EF BF BD — valid UTF-8, decoded back to the character.
    expect(decodeUtf8Strict(Buffer.from('draft\uFFFD.txt', 'utf8'))).toBe('draft\uFFFD.txt');
    // A raw 0xFF byte is not valid UTF-8 — lossy decoding would have
    // hidden it behind the same U+FFFD character.
    expect(decodeUtf8Strict(Buffer.from([0x66, 0xff]))).toBeNull();
  });
});
