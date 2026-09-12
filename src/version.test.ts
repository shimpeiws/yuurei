import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { packageVersion } from './version.js';

const require = createRequire(import.meta.url);
const manifestVersion: string = require('../package.json').version;

describe('packageVersion', () => {
  it('is read from package.json, so a version bump reaches both CLI output and cell identity', () => {
    // The regression #113 guards against: a hard-coded version in the CLI
    // would silently diverge from the manifest, leaving cell digests keyed on
    // a stale yuurei version after a bump.
    expect(packageVersion).toBe(manifestVersion);
  });

  it('is a non-empty semver-shaped string', () => {
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
