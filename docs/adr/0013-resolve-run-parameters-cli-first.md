# 0013. Resolve run parameters CLI-first, and record what the CLI overrode

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

Today a run's model, timeout and isolation reach the pipeline from the CLI only;
`yuurei.yaml`'s `runs` entries carry `profile` and `task` and nothing else. Once
the definition can express those three (#136), each has two possible sources and
no rule says which wins.

The rule cannot be left implicit, because the effective value is hashed into
`requested_cell.digest`. An ambiguous precedence produces an ambiguous identity.

There is no third source. §17 declares `YUUREI_` as an environment-variable
prefix, but that is a naming convention in a naming record — nothing in the code
reads such a variable.

## Decision

### Resolution is per field, CLI first

```
effective value = CLI flag, if given
                → the run definition's entry, if present
                → the default
```

Per **field**, not per record: passing `--model` must not discard a `timeout`
the definition set.

### `profile` and `task` identify the run; they are not parameters

A named run's profile and task cannot be overridden. `yuurei run hello --profile
other` is a configuration error, not an override — if the profile can be
swapped, the run name means nothing.

The current implementation does something worse than either: `src/cli/run.ts`
seeds the profile and task from the flags and then **overwrites them
unconditionally** when a run name is given, so the flag is silently discarded
with no diagnostic. Accepting a flag and ignoring it is the one behaviour that
teaches a user the wrong thing. The specification stands and the implementation
follows in #136.

This splits the fields into two kinds, and the split is the useful part:

|                           | Fields                          | CLI may override |
| ------------------------- | ------------------------------- | ---------------- |
| Identifies **which run**  | `profile`, `task`               | No               |
| **Parameterises** the run | `model`, `timeout`, `isolation` | Yes              |

The existing CLI already treats the two as alternatives — a run name _or_ a
`--profile`/`--task` pair — so this names a distinction the code already makes.

### A value set in the definition cannot be unset from the CLI

There is no flag meaning "no timeout" when the definition sets one. `--timeout
0` is rejected: `execCapture` accepts 1 to 2 147 483 647 and refuses anything
outside it.

This is left unsolved deliberately. Adding `--no-timeout` now would create a CLI
entry that (A) then has to carry forever, whereas adding it later is an additive
change costing a minor release
([ADR-0012](./0012-versioning-and-deprecation-policy.md)). Deferring is cheap and
reversible; committing now is not.

The gap is also narrow in practice. A defined value can still be _changed_ from
the CLI; `--timeout 2147483647` is about 24.8 days, which is "no timeout" for any
real run; and `yuurei run --profile P --task T` bypasses the `runs` entry
entirely, so nothing is inherited to unset.

### The trace records how the run was specified

```jsonc
"definition": {
  "run": "hello",              // the named run, or null for the --profile/--task form
  "cli_overrides": ["model"]   // fields the CLI took precedence on; [] when none
}
```

Without this, a reader holding one trace cannot tell whether a value came from
the file or a flag. The apparent alternative — "re-run from the definition and
see whether the digest differs" — is not a usable diagnostic: it requires
re-running to notice anything at all, and then yields two opaque hashes that
say _something_ differs without saying _what_.

`run` also closes a smaller gap. The trace records `profile.name` and
`task.source` but not the run's own name, so two runs in one `yuurei.yaml`
sharing a profile and task while differing in model are indistinguishable after
the fact. `null` marks the direct form, which is a different state from "a named
run with nothing overridden" and cannot be expressed by the override list alone.

Only field _names_ are recorded, never values, so nothing new can leak.

### This refines ADR-0008 rather than contradicting it

[ADR-0008](./0008-trace-records-identity-and-outcome.md) sorts what the trace
holds into identity and outcome. Recording where a value came from is neither —
but the trace already carries fields of that third kind, and has since the
beginning:

| Field          | In the digest                                                | Why it is recorded               |
| -------------- | ------------------------------------------------------------ | -------------------------------- |
| `profile.name` | No — §7.3 hashes resolved content, "not a mere profile name" | So a reader can find the profile |
| `task.source`  | No — the task's _content_ is hashed                          | So a reader can find the task    |

So the trace also records **provenance**: fields deliberately outside identity
that let a reader get back to the inputs. `definition` joins that category
rather than opening it — though it widens it. `profile.name` and `task.source`
say only _where_ an input lives; `cli_overrides` says _which source won_ when
two offered a value. Both answer "how did this value get here", which is the
category as it should be stated.

A field is provenance when removing it would leave a reader unable to trace a
recorded value back to where it came from. It stays out of the digest for the
same reason the profile's _name_ does: it describes how an input was reached,
not what the input is.

## Consequences

- One trace answers "was anything supplied outside the definition?" —
  `cli_overrides` empty and `run` non-null means no. That is weaker than
  reproducibility and deliberately so: the definition file can have changed
  since, and the runtime version, the resolved model and the yuurei build all
  move independently. What the field establishes is that the same _request_ can
  be reconstructed from the definition, not that re-running reproduces the
  run.
- Someone who wants a defined timeout gone for one run has to change it rather
  than clear it, or drop to the `--profile`/`--task` form. If that friction shows
  up in practice, `--no-timeout` is a minor release away.
- ADR-0008's two-way split turned out to be incomplete as stated. It is amended
  by this record rather than rewritten, so the reasoning that produced it stays
  readable — and the incompleteness is itself informative, since the missing
  category had been in the schema all along without a name.
- `definition` is one more entry the contract document must carry and 1.0 must
  keep.
