# 0019. Authenticate `codex exec` from an API key, not a subscription token

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

#146 asked two things: fix how OpenCode's experimental marking is decided, and
investigate whether Codex has a subscription-derived environment-variable path,
the way Claude Code has `ANTHROPIC_AUTH_TOKEN`.

Building the real-runtime CI answered the second question in a way the issue did
not anticipate. The adapter's supported Codex path — forward an explicitly-set
`OPENAI_API_KEY` — was verified against `codex` 0.100.0, where `codex exec`
authenticated from it. On the pinned 0.154.0 the same run fails: `codex exec`
opens the Responses transport with no credential and retries `401 Unauthorized`.
Current `codex exec` reads **`CODEX_API_KEY`**; `OPENAI_API_KEY` is the
interactive login flow (and older exec releases). The adapter now forwards
`CODEX_API_KEY` and maps `OPENAI_API_KEY` into it, so either variable works.

There is also a subscription-derived path, and it was the one the issue asked
about. The Codex environment-variable reference lists **`CODEX_ACCESS_TOKEN`**,
"a ChatGPT or Codex access token for trusted automation", and `codex login
--with-access-token` persists one. It is roughly the Codex analog of Claude
Code's subscription token.

## Decision

### The supported Codex automation credential is an API key

An explicitly-set API key is forwarded into the cell as `CODEX_API_KEY`, falling
back to `OPENAI_API_KEY`, and both names carry the same value. It is the
supported path because it is non-rotating and writes nothing to disk — the same
reason the design already gives for the API-key mechanism (§9.2).

### Do not adopt a ChatGPT access token

`CODEX_ACCESS_TOKEN` / `codex login --with-access-token` is **not** added as a
supported path. An access token is short-lived and rotates, so adopting it
reintroduces exactly the failure the experimental auth-file bridge already has: a
mid-run refresh updates only the isolated copy, the real login stays stale, and
the rotated copy is discarded on cleanup. Making it supported would either widen
that unsoundness to a second entry point or require writing the rotated token
back to the real file, which the project refuses (it would modify the operator's
real global configuration, a Section C invariant).

The experimental, opt-in `--bridge-codex-auth-file` remains for an operator who
accepts the rotation risk. This decision does not change it.

### The variable name is adapter-owned

`CODEX_API_KEY` is a Codex convention, not this project's surface, and it has
already changed once (from `OPENAI_API_KEY` for `exec`). It lives inside the
adapter, and the adapter maps the older name onto it, so an operator who sets
either keeps working. Neither name is a promise the contract makes.

## Consequences

- Someone holding only a ChatGPT subscription still has no supported
  non-interactive path and must use the experimental bridge, as before. The
  access token does not become a supported path, and this is a deliberate
  limitation rather than a gap left unexamined.
- The adapter carries the knowledge of which Codex variable `exec` reads. If
  Codex changes it again, that is an adapter edit, and a nightly failure is the
  signal that surfaced (and will surface) it — which is the point of running the
  real suite.
- The `401` retry loop is upstream behaviour: `codex exec` without credentials
  opens the transport and retries instead of failing fast. The adapter cannot fix
  that, but forwarding the credential means it no longer reaches it. If a future
  version regresses, the real suite reports a non-zero exit with the run's
  stderr, not a silent success.
- If Codex later ships a non-rotating subscription token, this record is
  superseded rather than edited: the reasoning that a rotating token cannot be a
  supported path stays readable.
