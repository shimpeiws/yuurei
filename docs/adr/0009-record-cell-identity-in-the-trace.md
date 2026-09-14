# 0009. Record cell identity and the digest-input options in the trace

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

`cell_digest` is computed at `src/cell/resolver.ts` and then discarded. It
reaches no file: not `trace.json`, not `resolved-profile.json` (which records
the _profile_ digest), and `yuurei inspect` prints the profile digest too. The
yuurei version, which §10.1 says is recorded, is likewise absent.

So a run leaves no durable statement of which execution cell it was.
Reproducibility can be asserted and never checked, and an upper layer cannot
group runs by cell identity or tell whether two runs shared one — which is the
comparison the trace exists to enable.

One consequence is easy to get wrong: because no digest was ever persisted,
there are **no stored digests to invalidate**. Changing the input set before 1.0
breaks nothing on disk. The problem is only prospective.

[ADR-0008](./0008-trace-records-identity-and-outcome.md) settles where these
belong. What remains is their form.

## Decision

Record in `trace.json`:

- **`cell.digest`** — the `sha256:<hex>` cell digest, matching the existing
  digest convention (`src/util/hash.ts`).
- **`cell.inputs_version`** — an integer identifying the input set and
  canonicalization that produced the digest. Starts at `1`; no `0` is needed
  because nothing was ever recorded.
- **`yuurei_version`** — top level, beside `schema_version`, so the
  independence asserted in [ADR-0003](./0003-independent-trace-schema-version.md)
  is visible rather than merely documented. It is an **observed** property of the
  run, not a digest input — see
  [ADR-0011](./0011-identify-a-cell-by-what-was-requested.md).
- **`execution_options`** — the execution contracts that constitute cell
  identity, split by who owns them:

```jsonc
"execution_options": {
  "timeout_ms": null,               // core: named and typed
  "runtime": {                      // adapter-owned: generic record
    "bridge_codex_auth_file": false
  }
}
```

### Name the identifier `inputs_version`, not `algorithm`

The hash function is sha256 and stays sha256; what varies is _what is hashed_.
`algorithm` invites the reader to look for a cryptographic choice that is not
there.

**Comparability is decided by `inputs_version`, never by the digest value.** Two
digests with different `inputs_version` are never compared, even when equal. An
absent `cell` means _unknown_, never _different_.

### Record only what constitutes identity — never the runtime's argv

Three reasons, the third decisive:

1. argv is built entirely by the adapters (`src/runtime/*/args.ts`). Putting it
   in the common trace makes a runtime-specific format part of the core's public
   data format, against §14's fifth acceptance criterion.
2. The adapters inject credential-related configuration and cell paths into argv
   — Codex forces `-c cli_auth_credentials_store="file"` at the highest
   precedence layer (§9.2), and each adapter passes isolated-directory paths.
   Recording argv would leave absolute temp-cell paths in a durable trace that
   survives `--keep`.
3. **argv is derived from the cell, not an input to it.** The same cell produces
   the same argv, so recording it adds no identity information at all — only
   leak surface. Worse, temp directory names differ per run, so argv would make
   two runs of an identical cell look different.

`--keep` is excluded for the same reason it is excluded from the digest: it
changes how the result is stored, not what is executed.

### Cell identity is the set of execution contracts, not of inputs that demonstrably mattered

An option belongs to cell identity when changing it **could** change the run —
not when it demonstrably did.

The tempting objection runs: a timeout that never fires leaves the execution
byte-identical, so a one-hour limit and no limit should be the same cell when
both finish in thirty seconds. The objection fails, and the reason is decisive:
**it decides identity from the outcome, which makes identity uncomputable before
the run starts.** A digest that can only be known afterwards cannot identify the
cell that is about to execute. Two runs finishing inside their limits shows only
that the difference did not surface this time; it does not show the two
conditions were interchangeable, and load or non-determinism can make one of them
time out tomorrow.

`execution.timed_out` records whether the limit _surfaced in the outcome_.
`timeout_ms` records _which execution contract the run was given_. They are an
outcome and an input, and both belong in the trace for different reasons.

The test to apply to every option added later:

> Changing this option, with the same profile, task and model — could it change
> the permitted behaviour, the termination condition, the environment, the
> inputs, the outputs, or the side effects?

- **Yes** → a `cell_digest` input. `timeout_ms` is a yes; that it sometimes does
  not fire does not change the classification.
- **No, it only changes storage, retention, display or logging** → not an input.
  `--keep` is a no.
- **No, but it is needed to interpret the run** → record it in the trace, outside
  the digest.
- **Unclear** → ask whether it is a contract fixed before the run or an
  observation available only afterwards. Before → identity. After → outcome.

### Narrow §10.1's "Launch options" rather than adding a field for the remainder

§10.1 names "Launch options" among what is recorded, which reads like a missing
field. Mapping the actual `yuurei run` options against the schema shows it is
not: `--profile` and `--task` are recorded as `profile` and `task` with their
digests, `--model` as `model.requested`, `--isolation` as `isolation.strategy`,
and `--timeout` and the bridge flags become `execution_options` above. What
§10.1 calls one category, the schema records as several purpose-named fields.

The only residue is `--keep` (and `--json`, which formats output and says nothing
about the run). **`--keep` is not recorded.** It is not identity — by the test
above it only changes retention — and it is not outcome either: it is the
operator's housekeeping choice, and what it preserves is the temporary cell, not
the run directory, which persists regardless.

The one case where the request and the reality could diverge does not arise in
practice. `src/run/pipeline.ts` removes the isolation directory despite `--keep`
when the run ended before the runtime started and credential writes cannot be
identified (§9.2) — but that path ends before a trace is written and takes the
partial run directory with it. Every run that has a trace was kept exactly as
asked, so recording the outcome would carry no information the request does not.

Accordingly, §10.1 is narrowed to identity-forming execution contracts rather
than growing a field for a boolean nobody consumes. Because §10.1 is normative
and this record is not, the narrowing is applied to the design document itself,
with the previous wording and the reason for the change noted there — an ADR
cannot narrow a promise on its own.

### Split core options from adapter options

`timeout_ms` is a core concept — the `Runtime` interface itself takes it
(`execute(run, timeoutMs)`, `src/runtime/types.ts`) and every runtime has one.
It gets a named, typed field.

The auth-bridge flags are adapter-owned: `bridgeCodexAuthFile` is read only by
the Codex adapter and `bridgeOpenCodeAuthFile` only by the OpenCode adapter.
Naming them in the common schema would make the runtime-agnostic core name two
specific runtimes, and a fourth adapter with its own bridging concept would then
require a change to the public schema for what is purely an adapter concern. A
generic record keyed by the adapter avoids that, following the precedent already
set by `usage`, which handles per-runtime metrics the same way rather than with
a union of per-runtime shapes.

`execution_options` exists for interpretation, not verification. The digest
cannot be recomputed from the trace — the profile content is not there — so its
purpose is to answer "why do these two runs differ?".

### Alternatives rejected

- **One flat generic record for everything.** Simpler, and it was the first
  proposal, but it puts `timeout_ms` — which no adapter owns — in the same bag
  as adapter-specific flags. That repeats the mistake
  [ADR-0002](./0002-four-kinds-of-promise.md) exists to prevent: mixing things
  of different kinds in one container.
- **`timeout_ms` inside the existing `execution` object**, beside `timed_out`.
  It reads naturally to a human, but `execution` currently holds only outcome,
  and the configured limit is an identity input. Mixing an input into a
  pure-outcome object contradicts
  [ADR-0008](./0008-trace-records-identity-and-outcome.md).

## Consequences

- An upper layer can group and compare runs by cell identity, which
  [ADR-0004](./0004-no-repetition-or-comparison.md) makes it responsible for.
- A later change to the digest inputs increments `inputs_version` instead of
  silently producing values that look comparable. The failure mode this exists
  to prevent is a consumer comparing two digests that mean different things.
- Old algorithms are never reimplemented, so an old digest is never recomputed.
- Traces from before this change have no `cell` and no `yuurei_version`, which
  obliges every reader to handle absence as unknown.
- The generic `execution_options.runtime` record is weakly typed: a consumer
  cannot know its keys in advance, and a misspelled key passes schema
  validation. That cost is accepted for the adapter-owned half and avoided for
  the core half, which is why the split exists.
- §6.3's trace example and §7.3's `cell_digest` naming both need updating to
  match the nested `cell` shape. The design document and the code disagree until
  that lands.
