# Behavior and limits

## Wire and identity contracts

The wire discriminators are part of the API: `box.document.v1` (data),
`box.document.v2` (executable), `box.program.v1`, `process.document.v1`,
`process.program.v1`, `box.presentation.v1`, `project.source.snapshot.v1` and
`application.package.v1`. Projections, history operations, installation
requests/results and inspection retain their own versioned discriminators.
A package's npm version does not rewrite document schema versions.

Normalization lowercases admitted UUIDs, normalizes applicable names to NFC
and trims them, then validates graph closure and identities. Box nodes and
snapshot objects sort by canonical identity; record fields sort by name then
identity. Executable statements, array values, summaries and form layouts
retain meaningful authored order. Canonicality checks are stricter than
normalizability; execution requires a canonical publication snapshot.

`package_digest(value)` hashes the UTF-8 bytes returned by `package_json(value)`
using SHA-256 and returns `sha256:` followed by 64 lowercase hexadecimal digits.
Object insertion order participates in that identity. `{ "a": 1, "b": 2 }`
and `{ "b": 2, "a": 1 }` intentionally have different package digests.
`package_operation_digest` instead recursively sorts object keys. Do not use
either digest as a signature, authorization proof or replacement for verifying
a package's content, publication witness and type contracts.

## Evaluation and host responsibilities

There is one evaluator. Process execution extends Box execution with declared
effects, and the interactive sandbox uses the same continuation semantics.
Normal execution is synchronous; a Process yields an intent rather than doing
I/O. Receipt replay runs again from the beginning with the supplied transcript.
Sandbox stepping preserves live continuation state instead of replaying mocks.
A host is responsible for effect authorization, idempotency, receipt custody,
transactions, cancellation scheduling and persistence.

Budgets count language execution work and values; they are not time limits or
OS isolation. Collection expressions are atomic within a statement. The host
should yield between sandbox batches and use its own process/worker limits
when admitting untrusted workloads. Value inspection may expose program data;
effectful Process inspection redacts values. Output states distinguish success,
expected rejection and runtime faults.

## Fixed bounds

| Area | Bound |
| --- | --- |
| Document nodes / record fields | 256 / 128 |
| Program statements / projected nodes | 512 / 4,096 |
| Expression depth / literal depth | 64 / 64 |
| Literal nodes / items per collection | 16,384 / 4,096 |
| Process effects / input or output projections | 64 / 128 |
| Published realms / Boxes / serialized snapshot | 256 / 4,096 / 8 MiB |
| Presentation bytes / summary fields | 64 KiB / 6 |
| Query filters / text units / cursor units | 8 / 256 / 4,096 |
| Query page size | 1–100; default 25 |
| Package serialization | 12 MiB, 500,000 nodes, depth 96, arrays up to 65,536 |
| Runtime steps / call depth | 100,000 / 64 |
| Runtime value nodes / string units | 100,000 / 16,777,216 |
| Process effect budget | 64 |
| Inspection events / value nodes / string units / depth | 4,096 / 20,000 / 100,000 / 64 |
| Sandbox batch / breakpoints | 64 statement boundaries / 512 |

Callers must supply positive runtime budgets at or below the caps. String-unit
budgets count JavaScript UTF-16 units; serialized-size limits count UTF-8 bytes.
Revision counters are decimal strings bounded by signed 64-bit maximum.
Published source revisions are positive; revision-history snapshots may be zero.

Package serialization rejects non-data values, accessors, sparse arrays,
non-enumerable/symbol properties and unsupported prototypes without invoking
getters or `toJSON`. Do not assume all normalizers are a general-purpose guard
against arbitrary JavaScript objects: normalizers are intended for decoded
document data, and many failures throw. Runtime outcomes and nullable response
parsers have their own explicit error contracts.

Existing validation diagnostics include localized Russian text. Presentation
labels have required `ru` and `en` members when a bilingual label is supplied.
Do not interpret English-first documentation as a translation of wire fields
or diagnostic strings. Prefer outcome status and fault codes to message text.

## Scope

This package has no root export, CommonJS build, UI framework, database,
transport, authentication system, policy engine, arbitrary-code evaluator or
automatic effect runner. Package planning does not execute its commands.
Only the tested runtimes listed in the README are qualified. There is no
promise of identical behavior on older JavaScript engines or other locales
beyond the explicit sorting behavior implemented by these APIs.
