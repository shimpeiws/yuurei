# Contributing

Thanks for looking at `yuurei`. This page covers what you need to build it,
what CI expects, and the one area where the bar is higher than usual.

## Before you start

Read the [design document](docs/design/yuurei-design-v0.3.md). It is
authoritative: `CLAUDE.md` and the code comments reference its section numbers,
and a change that contradicts it is a design decision, not an implementation
detail.

## Setup

Node.js `>=22` and pnpm `11.6.0` (this repository uses [mise](https://mise.jdx.dev/)
to pin both; `mise install` sets them up).

```sh
pnpm install
```

## Commands

```sh
pnpm test              # vitest run
pnpm run check         # oxlint --deny-warnings
pnpm run format        # oxfmt --check
pnpm run build         # tsc --build (type check)
pnpm run knip          # unused exports
pnpm run smoke:package # pack, install the tarball, run the bin
```

Prefer targeted test files while iterating (`pnpm test <path>`); CI runs
everything.

## What CI requires

A pull request must pass `ci`, `gitleaks`, `semgrep/ci`, and both CodeQL jobs
(`analyze (javascript-typescript)` and `analyze (actions)`). `main` takes no
direct pushes.

Every GitHub Action must be pinned to a commit SHA with the version in a
trailing comment — the repository enforces this, so a tag reference is
rejected:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

## The part that is different

`yuurei` bridges credentials into an environment where a coding agent
executes, so some code paths carry guarantees rather than preferences.
`CLAUDE.md` lists them under **Invariants**: a change that breaks one is a
defect, not a tradeoff. It also lists what is deliberately **out of scope** —
please do not file those as findings.

If your change touches `src/isolation/`, `src/runtime/`, `src/cell/`, or
anything else that crosses the trust boundary, read
[the security review policy](docs/security/review-policy.md) first: those
areas require a manual security review before merge, and a new runtime adapter
always does.

## Reporting a vulnerability

Do not open a public issue. Follow [SECURITY.md](SECURITY.md), which routes
reports through a private GitHub security advisory.

## Pull requests

Keep the diff focused and explain **why** in the description — the reasoning
is the part a reviewer cannot reconstruct from the code. Update `CHANGELOG.md`
under `[Unreleased]` for anything user-visible.

Releases are cut by a maintainer; see [docs/releasing.md](docs/releasing.md).
