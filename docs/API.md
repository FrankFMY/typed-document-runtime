# API guide

Import from the explicit subpaths listed in the README. All public functions
and types are described by the shipped `.d.ts` files. APIs use snake_case.
In the source checkout, the checked examples in `examples/quickstart.mjs` and `tests/consumer/` show
complete runnable requests; the latter run against installed archives.

## Documents, values and programs

`box-document` exports `BoxDocument`, `BoxDocumentNode`, `BoxValue`, and the
frozen `EMPTY_BOX_DOCUMENT`. `normalize_box_document(unknown)` validates the
graph and returns its canonical form. `normalize_box_value(document, value)`
validates a root value; `normalize_box_value_at(document, type_id, value)`
validates a named type. Records use field **names** as value keys; runtime cell
requests use field **identities**. Unknown keys and mismatched scalar types are
rejected rather than coerced.

`is_canonical_box_document`, `box_documents_equal` and `diff_box_documents`
answer different questions: exact admitted representation, normalized equality,
and structural change. `project_box_document_schema` produces a `box.schema.v1`
projection; `project_box_document_code` produces a textual representation.

`box-program` exports `BoxProgram`, its expression/statement unions,
`normalize_box_program`, identity/type references and node projections.
`box-program-semantics` exposes `validate_box_program_semantics(nodes, root,
program)` for checks against a record's typed cells. Document normalization
already performs the corresponding semantic validation.

`box-type-system` exposes `create_box_type_comparer()`. Its `resolved_type`,
`same_type` and `scalar_type` methods operate on objects with a `nodes` array.
A comparer caches graph resolution by object identity; do not mutate a document
while reusing its comparer.

`process-document` exports `ProcessDocument`, `ProcessEffectDeclaration`,
`normalize_process_document`, `is_canonical_process_document` and
`process_document_box_schema`. Processes declare input/output cell identities
and effect request/result types. `process-program` normalizes their ordered
programs and provides identity/projection helpers. `published-document` exports
`PublishedDocument = BoxDocument | ProcessDocument` and shared normalize,
canonicality and diff operations.

## Execution and inspection

`runtime.execute_project_runtime(request)` takes a `RuntimeExecutionRequest`:
a publication `{ id, snapshot }`, `entry_box_id`, input cells, requested output
cell identities, a budget and optional inspection mode (`structure` or `values`).
It returns a discriminated `success`, `rejected` or `fault` outcome. Read
`outputs` only after narrowing to `success`; rejection carries `code` and
`details`, while a fault carries `code` and `message`. Every outcome includes
usage and an execution trace. Budgets are required and must be positive,
within the exported caps.

`execute_process_runtime(request)`, available from both `runtime` and
`process-runtime`, is the same exported function. A `ProcessExecutionRequest`
uses `process_id`, `invocation_id`, inputs, `effect_receipts`, a budget including
`max_effects`, and optional inspection. Its additional `effect` outcome
contains the next typed intent: statement/effect identities, capability,
request and transcript index. The host performs an authorized operation and
restarts execution with a matching receipt appended. A receipt supplies
`statement_id`, `effect_id`, `capability`, `request` and `result`. The runtime
validates transcript order, witnesses and value types. It does not authenticate
the host or grant a capability.

Inspection helpers and `RUNTIME_INSPECTION_LIMITS` are exported from `runtime`.
`normalize_runtime_inspection`, `is_canonical_runtime_inspection` and
`matches_runtime_inspection_terminal` validate the bounded inspection wire
format. Effectful Process inspection redacts values while retaining structure.

## Interactive execution

Construct `new RuntimeSandbox(request)` from a `SandboxExecutionRequest`
(the Process request without invocation identity or receipts). The constructor
captures the request and pauses before the first statement when one exists.
Read `.view` for its immutable status, frames, cells, usage, breakpoints and
current effect/outcome. Cell state distinguishes unset from a value of `null`.

Use `resume("into" | "over" | "out" | "continue")` and `drive()` for subsequent
batches. `drive()` advances at most 64 statement boundaries; yield to the host
event loop between batches while status is `running`. `set_breakpoints` takes
Box-qualified statement identities and reports whether they were admitted.
At an effect, `submit_mock(value)` returns false for an invalid typed result
without advancing or replacing the current view. A valid result resumes the
same continuation. `restart()` starts a new session without old mocks;
`stop()` releases continuation and request references. Sandbox session UUIDs
are fresh, even when semantic execution results are deterministic.

## Snapshots and history

`project-source-snapshot` provides published normalization/serialization and
canonicality checks. Revision inspection has separate
`normalize_project_source_revision_snapshot` and canonicality helpers to allow
revision zero and pending presentation repair. Published snapshots require a
positive revision and resolved presentation references.

`compare_project_source(before, after)` from `project-source-comparison`
returns changes by stable identity, including structure, documents and
presentation. `project-source-history` exports request schemas and parsers
for history pages and witnessed comparisons. Its `parse_*` functions return
`null` for an invalid response or mismatched expected request; they do not fetch
history. Comparison parsing rederives changes from the supplied snapshots.

## Presentation and application data

`box-presentation` normalizes presentation shape and binds it to a document.
`normalize_box_presentation_shape` admits descriptors awaiting repair;
`normalize_box_presentation` validates actual fields/types. Canonicality and
condition helpers accompany these functions. Labels retain both `ru` and `en`.
Layouts, summary fields and view ordering are authored data, not inferred UI.
An empty presentation descriptor is rejected; clear the optional presentation
instead of passing only an empty fields array.

`application-data-contract` provides `normalize_application_data_schema`,
`application_data_operation_contracts`, schema comparison, explicit fill-plan
normalization/application and historical value projection. The eight operation
contracts are `create`, `read`, `update`, `archive`, `restore`, `list`, `query`
and `aggregate`. Capability identifiers bind entity identity and exact schema
revision. These functions neither store records nor execute queries.

`application-data-query` validates query fields, filters, sort order, cursor
and limit against an `OperationSchema`. Defaults are a limit of 25, no archived
records and no filters. `process-contract` projects application input/output
schemas and effect requirements. `check_process_operation_contract` checks
installed operations with contravariant requests and covariant results;
its result distinguishes missing, invalid and incompatible contracts.

## Packages and installation planning

`application-package` validates data-only values with `package_json`, computes
Web Crypto SHA-256 with `package_digest`, creates/freezes an envelope with
`create_application_package`, and verifies it with `parse_application_package`.
Creation requires a name, a publication identity and content digest, a canonical
source snapshot and its exact owned data-schema witnesses. It derives operation
requirements and rejects open/cyclic package calls. `remap_package_source` and
`remap_package_document` use explicit identity maps while retaining local
program/type identities and literal values.

`package_operation_digest` sorts object keys recursively before hashing.
`package_digest` deliberately preserves JSON insertion order. They are not
interchangeable; see [behavior](BEHAVIOR.md).

`application-package-merge.merge_package_source(base, local, incoming,
resolutions?)` returns a source and witnessed conflicts. Choices are `local`
or `incoming` for exact conflict paths; stale choices are rejected.
`application-package-plan` provides `parse_package_request`,
`plan_application_package`, `package_identity`, `package_commands`,
`parse_package_preview` and `parse_package_result`. Plans include readiness,
identities, witnesses, changes, conflicts, blockers and a digest. The host owns
transactions and applies commands only under its own revision and permission
checks. A plan alone does not modify storage or install a package.
