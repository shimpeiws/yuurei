# 0014. Treat the trace schema version as a compatibility token

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

[ADR-0003](./0003-independent-trace-schema-version.md) settled that the trace
schema is versioned independently of the package and that a v1 CLI reads a `0.3`
trace read-only, but deliberately left the number itself for later, once the
compatibility policy existed. [ADR-0012](./0012-versioning-and-deprecation-policy.md)
supplied that policy. What remains is not only the number but what the field is.

**The field is compared for equality.** `TraceSchema` declares
`schema_version: z.literal(TRACE_SCHEMA_VERSION)` and `readTrace` parses through
it, so the value is a token. The dotted spelling `0.3` invites a range or
ordering comparison the code has never performed.

**Parse compatibility is asymmetric.** Parsing the four combinations that
matter, measured rather than assumed:

|                                                         | Result                                 |
| ------------------------------------------------------- | -------------------------------------- |
| Old reader × newer trace carrying unknown fields        | **Parses** — unknown keys are stripped |
| New reader with an added **optional** field × old trace | **Parses**                             |
| New reader with an added **required** field × old trace | **Rejected**                           |
| Either reader × a trace whose version string differs    | **Rejected**, both directions          |

Four fields are about to be added: `requested_cell` and `yuurei_version`
(ADR-0009, ADR-0011), `execution_options` (ADR-0009), and `definition`
(ADR-0013). None exists in `src/trace/schema.ts` yet — this record decides their
shape ahead of the implementation, which lands with #136 and #137.

## Decision

### The version identifies a compatibility class, compared for equality

It is not a range, carries no ordering, and must never be sorted or compared with
`<` or `>` despite the dotted spelling. It says which compatibility class a trace
belongs to — nothing about product stability, release maturity, or whether
incompatibilities have occurred in the past.

The design document does not currently say this. §6.3 explains `resolved_reason`
and `diagnostics` but never states how the version field is to be compared, so
the normative sentence has to be added there and carried into the contract
document.

### It is independent of the package version

Restating ADR-0003 because this record is where the consequence becomes visible:
a 1.0 product may ship, and will ship, a schema labelled `0.3`.

### The pending fields are optional, so the token stays `0.3`

All four are optional. ADR-0009 already requires a reader to treat an absent
digest as _unknown_, never as _different_; declaring them optional is that
decision expressed in the schema, and a trace written before them genuinely
lacks them.

Optional additions therefore do not change the compatibility class, and the
token stays `0.3`. This is what makes ADR-0003's read-old-traces requirement free
rather than expensive: one schema reads traces from before and after, and no
version-dispatching reader has to exist.

**What "compatible" means here is narrow, and the narrowness matters.** An
optional addition keeps _parsing_ working in both directions. It does not
preserve data: an old reader strips fields it does not know, so a trace read and
re-emitted through one comes back without them. And it guarantees nothing about
whether a feature that needs a new field works — a consumer written against
`0.3` that meets a trace with `definition` parses it successfully and sees
nothing. Parse compatibility is the only thing the token promises.

### The finer signal lives in `yuurei_version`

A consumer wanting to know which build wrote a trace reads that field; its
absence marks a trace written by v0.2.0 or earlier. The two divide cleanly:
`schema_version` is the compatibility class of the data format,
`yuurei_version` is an observation of what produced it.

### When a field must become required

That is the signal a real version change is due, and the change is not just a new
token. These have to be answered together, and are recorded here so the next
person does not have to rediscover them:

- Must existing `0.3` traces still be readable at all?
- Does a reader for the new token also accept `0.3`?
- Or does it read them while treating the feature that needs the new field as
  _unknown_, per ADR-0009's rule?
- If old traces fall out of scope, which CLI operations fail on them, and with
  what message?

### Rejected: renumbering to `1.0`

**At product 1.0**, for tidiness — so that a 1.0 product does not ship a `0.3`
schema. This breaks every existing reader for no semantic reason, at precisely
the release where the project promises to stop breaking things.

**Now, while 0.x makes breaking cheap.** Superficially the better timing, but it
does not reduce work; it creates it. The obligation to read `0.3` traces survives
the renumber, so a reader would then have to accept two version values — exactly
the version-dispatching machinery that not renumbering avoids. What it buys is
cosmetic.

## Consequences

- A 1.0 product ships a schema labelled `0.3`. The contract document has to say
  the field is a compatibility class and not a stability signal, or the `0.` will
  be read as "unstable". Defending a correct design with an explanation is
  weaker than a design that cannot be misread — accepted here because the field
  is already public and renumbering costs more than it returns.
- The token holding still is not the absence of information: `0.3` states which
  compatibility class a trace belongs to, which is exactly what a reader needs.
  What it does not carry is provenance, and `yuurei_version` carries that.
- Every field added from here is optional by default. A field that genuinely
  cannot be optional is the signal that a real version change is due, with the
  questions above to answer.
- Declaring the four fields optional makes "this may be absent" permanent for
  them. A consumer must handle absence for every one, and ADR-0009's rule —
  absent means _unknown_, never _different_ — binds every consumer, not only the
  digest.
- Readers must not sort or range-compare the version. Nothing enforces that;
  the contract document states it and a consumer can still get it wrong.
- The four fields have no tests yet because they have no implementation yet.
  Both land with #136 and #137.
