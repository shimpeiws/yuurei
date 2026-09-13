## What and why

<!-- What changes, and the reasoning a reviewer cannot reconstruct from the diff. -->

## Verification

<!-- What you ran, and what it showed. "Tests pass" is weaker than the output that proves it. -->

## Checklist

- [ ] `pnpm test`, `pnpm run check`, `pnpm run format`, `pnpm run build`, `pnpm run knip` pass
- [ ] `CHANGELOG.md` updated under `[Unreleased]` if this is user-visible
- [ ] No credentials in code, tests, fixtures, or the description
- [ ] If this touches `src/isolation/`, `src/runtime/`, `src/cell/`, or the trust boundary: a manual security review was run per [the policy](../docs/security/review-policy.md)
