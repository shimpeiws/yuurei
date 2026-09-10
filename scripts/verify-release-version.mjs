#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifestVersion = JSON.parse(
  await readFile(join(process.cwd(), 'package.json'), 'utf8'),
).version;
const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error('verify-release-version: GITHUB_REF_NAME is not set');
  process.exit(1);
}
const tagVersion = tag.replace(/^v/, '');
if (tagVersion !== manifestVersion) {
  console.error(
    `verify-release-version: tag ${tag} does not match package version ${manifestVersion}`,
  );
  process.exit(1);
}
console.log(`verify-release-version: tag ${tag} matches package version ${manifestVersion}`);
