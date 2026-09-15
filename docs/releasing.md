# Releasing

This document describes how `yuurei` is published to the npm registry and
how to produce a GitHub Release.

## Prerequisites

- A public npm account with a verified email and two-factor authentication.
- A GitHub account with `write` access to this repository.
- **The GitHub repository must be public.** npm refuses to generate a
  provenance attestation from a private source repository, and
  `.github/workflows/publish.yml` publishes with `--provenance`.

## One-time setup

Both steps are done once, before the first release. Neither needs a published
version to exist.

### 1. Register the trusted publisher

npm (11.10.0 and later) can register a trusted publisher for a package that has
not been published yet, so the very first release can come from the workflow
with provenance — no manual publish, no placeholder version:

```sh
npm login
npm trust github yuurei --file publish.yml --repo shimpeiws/yuurei --env npm --allow-publish
npm trust list yuurei
```

Check that `npm trust list` reports the same workflow file and environment name
that `publish.yml` actually presents at OIDC exchange time. A mismatch here
surfaces only as a failed publish during a real release.

If the registry rejects registering a publisher for a name that does not exist
yet, fall back to claiming the name manually and configuring trusted publishing
afterwards in the npmjs.com package settings:

```sh
npm publish --access public   # no --provenance: a local publish cannot attest
```

Claim it with a placeholder version **below** the version you intend to
release, so the release itself still goes through the workflow. Publishing the
release version by hand and then tagging it makes the workflow fail on a
duplicate version. Deprecate the placeholder afterwards with
`npm deprecate yuurei@<placeholder> "placeholder; use >=<release>"`.

### 2. Create the `npm` GitHub environment

`publish.yml` declares `environment: npm`, which must exist in this repository:

```sh
gh api -X PUT repos/shimpeiws/yuurei/environments/npm
```

No `NODE_AUTH_TOKEN` or npm token is stored in the repository. When
`npm publish` runs inside the workflow, npm reads the OIDC token supplied by
the runner and exchanges it for a publish credential scoped to `yuurei`, so
there is no credential in the repository to leak.

## Cutting a release

Releases are source-of-truth from `package.json`. The tag must match the
package version.

1. Confirm the version in `package.json` is the version you intend to ship,
   and that `yuurei --version` prints it (`src/version.ts` reads the version
   from `package.json` at runtime).
2. Update `CHANGELOG.md` following [Keep a Changelog]
   (https://keepachangelog.com/en/1.1.0/) in the `[Unreleased]` section.
3. Open a PR with those changes, merge it against `origin/main`.
4. Run the **release-candidate real-runtime check** and confirm it is green
   before going further. It is the real-runtime suite on macOS and Linux against
   the pinned runtime versions, triggered by the `release` label on the release
   PR or by hand. The nightly run is the same suite and is not blocking; this one
   is the gate, and the tag is not created until it passes (ADR-0017).
5. Create a GitHub Release with tag `v<version>` on the merged commit,
   e.g. `v0.1.0`. The `Publish to npm` workflow runs from the release tag
   (an immutable ref) on the `[published]` event and publishes the matching
   npm version.

Shipped versions are `Semantic Versioning` (https://semver.org/) compatible.
What that covers — which surfaces are promised, which are experimental, and
which release a given change requires — is stated in
[the public contract](contract.md). Before 1.0 the freeze is an intention rather
than a promise; that document says what it means.

## Release candidates and the soak

Before 1.0, a release candidate soaks for one week before the final tag
(ADR-0020). A candidate is cut like a release, with a prerelease version:

1. Set `package.json` to `X.Y.Z-rc.N`, promote the CHANGELOG's `[Unreleased]`
   section, and open the release PR as usual. Run the release-candidate
   real-runtime check on it (step 4 above) and confirm it is green.
2. Create a GitHub Release with tag `vX.Y.Z-rc.N`, marked **pre-release**. The
   publish workflow publishes it to the npm `next` dist-tag, never `latest`.
3. Install it with `npm install yuurei@next` and use it for real work for one
   week. The period is fixed before the candidate is published; it is not
   shortened because the candidate looks fine.
4. During the soak, `docs/contract.md` is **frozen**. A change to any contract
   entry restarts the one-week period and is cut as `rc.N+1`, so the soaked
   artifact always matches the frozen document.
5. When the week is complete and no contract entry changed, tag `X.Y.Z` as a
   normal release. `latest` moves then.

## What the publish workflow does

`.github/workflows/publish.yml`:

- Checks out exactly the tag that the GitHub Release points at, never a
  moving branch.
- Verifies the tag matches `package.json` version with
  `scripts/verify-release-version.mjs`. A mismatch fails the job.
- Runs the test suite.
- Installs npm 11 before publishing. Trusted publishing requires npm
  `>=11.5.1` and Node `>=22.14.0`; the npm bundled with Node 22 is 10.9.x and
  fails with `ENEEDAUTH` because it cannot perform the OIDC exchange.
- Derives the npm dist-tag from the version — a prerelease goes to `next`, a
  clean version to `latest` — and publishes with it, so a prerelease can never
  become the default install (ADR-0020).
- Publishes with `npm publish --provenance`. The OIDC credential is held by
  GitHub, so the workflow needs no real credentials.

No `npm publish` can run outside a GitHub Release, so the published tarball
always matches a released tag.

## Version source of truth

- `package.json` `version` is the single source of truth.
- `src/version.ts` reads the version at runtime via `node:module` and is the
  single source for both the CLI and the `yuurei_version` the trace records; the
  CLI `--version` output comes from `package.json`.
- The npm and GitHub release versions are equal because of the tag match
  check above.

## Minimum Node.js version

CI executes on Node.js 22 LTS, so `engines.node` is declared as
`>=22.0.0`.
