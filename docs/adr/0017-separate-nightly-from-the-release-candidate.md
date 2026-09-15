# 0017. Separate nightly real-runtime checks from the release-candidate gate

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

The contract promises that the trace works against the runtimes themselves, but
until now every check that needs a real `claude`, `codex` or `opencode` lived in
`docs/manual-verification.md` as a hand-run procedure. v0.4.0 added the mechanism
to change that: a fixture harness that can launch a real runtime with no shim,
gated behind `YUUREI_E2E_REAL` (`test/e2e/real-runtime.test.ts`).

Connecting that harness to CI forces two roles apart that are easy to conflate.

A real-runtime run depends on executables this project does not control. Their
behaviour, their versions and their auth change on someone else's schedule, so a
nightly failure is often an upstream change rather than a defect here. Blocking
every pull request, or every release, on that would make the project brittle in a
way that invites ignoring the failures.

But a check that can never block anything proves nothing. If no real-runtime
result is ever allowed to stop a release, "the implementation is exercised
against the runtimes" is an aspiration without teeth.

The two are different questions asked at different cadences, and conflating them
is what makes either answer wrong.

## Decision

Separate the real-runtime work into two roles with different triggers and
different consequences.

### Pull requests run the fake suite only

The per-pull-request gate stays what it is: the fake-runtime suite, on Linux and
macOS. A real run needs credentials, and GitHub does not expose repository
secrets to a pull request from a fork, so a real run on every PR would be
unavailable exactly where review happens. It is also slower and costs tokens per
run. The fake suite is the reviewer's gate.

### Nightly runs the real suite against pinned versions

A scheduled workflow runs the real suite on macOS and Linux against
**exact-pinned** runtime versions (installed from npm at a fixed version). A
failure here is a **signal to revisit the supported-version boundary**, not a
release blocker: it usually means upstream moved, and the response is to decide
whether to move the declared minimum, fix an adapter, or tighten the fixture.

### The release candidate is gated by the same suite

The release process runs the same real suite, against the fixed versions used
for the release decision, on macOS and Linux, and requires it to pass before the
`v<version>` tag is created. A release pull request carries a `release` label (or
the check is dispatched by hand), and `docs/releasing.md` states that the check
must pass first. This is the check with teeth; the nightly is the early warning.

### The costs this assumes

- Runtimes are installed at exact versions, so the suite's behaviour is
  repeatable and a change is a deliberate edit.
- The real suite pins cheap models, and the fixture profiles are minimal, so a
  nightly run costs on the order of a US cent. GitHub Actions is free for the
  standard runners a public repository uses, macOS included, so the only real
  cost is model tokens.

## Consequences

- A PR cannot be blocked by an upstream runtime change it did not cause, so the
  fake suite stays a fast, deterministic reviewer gate.
- A release cannot ship on a real-runtime check that was never run: the RC gate
  is the point at which the contract is shown to hold against the runtimes, which
  is what the milestone promises.
- The project takes on a maintenance loop: a nightly failure has to be triaged
  into "the boundary moved" or "we broke it". That work is real, and it is the
  price of exercising against software we do not control.
- Two workflows share fixture code. If they diverge, the fake gate and the real
  gate stop testing the same thing, so the fixture and harness are the shared
  artifact and the workflows only supply the runtime installation and the
  trigger.
- The RC check depends on repository secrets (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, and any provider key OpenCode needs). They are used only in
  the nightly and RC workflows; a fork PR cannot reach them, which is the same
  property that keeps the PR gate fake.
