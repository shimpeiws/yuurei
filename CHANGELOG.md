# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `yuurei --version` reads the version from `package.json` instead of a
  hardcoded value; the manifest is now the single source of truth.
- `engines.node` is aligned with the Node.js version exercised in CI
  (`>=22.0.0`).
- Added a reproducible npm publish workflow using GitHub OIDC trusted
  publishing.

### Fixed

- The npm `bin` entry keeps the `yuurei` executable when publishing.
