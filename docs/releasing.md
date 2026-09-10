# Releasing

This document describes how `yuurei` is published to the npm registry and
how to produce a GitHub Release.

## Prerequisites

- A public npm account with a verified email and two-factor authentication.
- A GitHub account with `write` access to this repository.

## One-time first publish

The `yuurei` package name must be claimed once before the automated release
workflow can publish under it.

1. From a clean `origin/main` checkout, run all checks locally:
   `pnpm run check`, `pnpm run format`, `pnpm run knip`, `pnpm test`,
   `pnpm run build`, and `pnpm run smoke:package`.
2. Publish the current version manually:

   ```sh
   npm publish --provenance --access public
   ```

   You must be logged in with `npm login`. This first publish claims the
   package name manually because trusted publishing cannot authenticate the
   first release.

3. Verify the package on `https://www.npmjs.com/package/yuurei`.

## Trusted publishing setup

After the package name is claimed, npm publishes can run from GitHub Actions
without storing a token in this repository.

In the npmjs.com package settings, create a trusted-publishing connection that
points to this repository and the `npm` environment. In this repository,
create a GitHub Actions environment named `npm` with the target GitHub
repository as the trusted source. No `NODE_AUTH_TOKEN` or npm token is stored
in the repository, so credentials cannot be leaked from the workflow.

When `npm publish` runs inside `.github/workflows/publish.yml`, npm reads the
OIDC token supplied by the runner and exchanges it for a publish credential
that is scoped to `yuurei`.

## Cutting a release

Releases are source-of-truth from `package.json`. The tag must match the
package version.

1. Confirm the version in `package.json` is the version you intend to ship,
   and that `src/index.ts` prints it via `yuurei --version` (the CLI reads
   the version from `package.json` at runtime).
2. Update `CHANGELOG.md` following [Keep a Changelog]
   (https://keepachangelog.com/en/1.1.0/) in the `[Unreleased]` section.
3. Open a PR with those changes, merge it against `origin/main`.
4. Create a GitHub Release with tag `v<version>` on the merged commit,
   e.g. `v0.1.0`. The `Publish to npm` workflow runs from the release tag
   (an immutable ref) on the `[published]` event and publishes the matching
   npm version.

Shipped versions are `Semantic Versioning` (https://semver.org/) compatible.

## What the publish workflow does

`.github/workflows/publish.yml`:

- Checks out exactly the tag that the GitHub Release points at, never a
  moving branch.
- Verifies the tag matches `package.json` version with
  `scripts/verify-release-version.mjs`. A mismatch fails the job.
- Runs the test suite.
- Publishes with `npm publish --provenance`. The OIDC credential is held by
  GitHub, so the workflow needs no real credentials.

No `npm publish` can run outside a GitHub Release, so the published tarball
always matches a released tag.

## Version source of truth

- `package.json` `version` is the single source of truth.
- `src/index.ts` reads the version at runtime via `node:module`; the CLI
  `--version` output comes from `package.json`.
- The npm and GitHub release versions are equal because of the tag match
  check above.

## Minimum Node.js version

CI executes on Node.js 22 LTS, so `engines.node` is declared as
`>=22.0.0`.
