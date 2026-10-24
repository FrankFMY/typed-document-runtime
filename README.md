# Typed Document Runtime

Typed Document Runtime is an ESM library for validating typed documents and
executing their programs. A **Box** defines data or a pure executable program;
a **Process** adds declared, typed effects; a **Project** snapshot groups them
into named realms. One evaluator powers ordinary execution, effect replay and
an interactive sandbox.

I want the document that gets validated to be the document that gets executed.
Keeping types, program identities, normalization and execution together makes
it possible to inspect a run, replay an effect transcript and step through the
same semantics without translating to another intermediate language. The host
supplies storage, permissions, transports and real effects.

## Install from npm

Version **0.1.2** is available as
[@frankfmy/typed-document-runtime on npm](https://www.npmjs.com/package/@frankfmy/typed-document-runtime).

```sh
npm install @frankfmy/typed-document-runtime@0.1.2
```

Source builds and the older, immutable **v0.1.1** GitHub archive documented below
remain alternatives. The archive is a different version from npm 0.1.2.

## Build from source

Use Node **24.20.0** and Bun **1.4.2**. From this source checkout:

```sh
bun install --frozen-lockfile
bun run lint
bun run check
bun test src tests --max-concurrency 1
bun run build
bun run pack
```

The archive is `.artifacts/frankfmy-typed-document-runtime-0.1.2.tgz`.
To create it from a clean clone:

```sh
git clone https://github.com/FrankFMY/typed-document-runtime.git
cd typed-document-runtime
bun install --frozen-lockfile
bun run build
bun run pack
```

## Install an artifact

Use the archive built above, or install the versioned
[GitHub release](https://github.com/FrankFMY/typed-document-runtime/releases/tag/v0.1.1)
archive in your application:

```sh
curl --fail --location --output frankfmy-typed-document-runtime-0.1.1.tgz \
  https://github.com/FrankFMY/typed-document-runtime/releases/download/v0.1.1/frankfmy-typed-document-runtime-0.1.1.tgz &&
curl --fail --location --output SHA256SUMS \
  https://github.com/FrankFMY/typed-document-runtime/releases/download/v0.1.1/SHA256SUMS &&
sha256sum --check SHA256SUMS &&
npm install ./frankfmy-typed-document-runtime-0.1.1.tgz
```

This verified-download path also works with npm 12's default restriction on
remote URL dependencies, without changing that policy. Require a successful
checksum check before installing; use an equivalent SHA-256 verifier on platforms
without `sha256sum`.

For an archive you built yourself, create a separate application directory and
copy the tarball into it:

```sh
npm init -y
npm install ./frankfmy-typed-document-runtime-0.1.2.tgz
```

Bun applications can use `bun add ./frankfmy-typed-document-runtime-0.1.2.tgz`
instead. Import explicit subpaths; there is no root barrel or CommonJS build.
The archive contains emitted JavaScript, declarations, source maps and docs.
Zod 4.6.6 is its only runtime dependency.

## Run a program

Save this as `quickstart.mjs`, then run `node quickstart.mjs` or
`bun quickstart.mjs`. It prints `Hello, typed documents!`. The verification
command extracts and runs this exact snippet in separately installed projects.

<!-- quickstart:start -->
```js
import { normalize_box_document } from "@frankfmy/typed-document-runtime/box-document";
import { normalize_project_source_snapshot } from "@frankfmy/typed-document-runtime/project-source-snapshot";
import { execute_project_runtime } from "@frankfmy/typed-document-runtime/runtime";

const id = (n) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const document = normalize_box_document({
	schema: "box.document.v2",
	root_id: id(10),
	nodes: [
		{ id: id(11), kind: "scalar", value_type: "string" },
		{ id: id(10), kind: "record", fields: [{ id: id(12), name: "message", type_id: id(11), required: false }] },
	],
	program: {
		schema: "box.program.v1",
		body: [{ id: id(13), kind: "write", cell_id: id(12), value: { id: id(14), kind: "literal", type_id: id(11), value: "Hello, typed documents!" } }],
	},
});
const snapshot = normalize_project_source_snapshot({
	schema: "project.source.snapshot.v1",
	project_id: id(1),
	revision: "1",
	realms: [{ id: id(2), name: "Main", is_primary: true }],
	boxes: [{ id: id(3), realm_id: id(2), parent_id: null, name: "Greeting", document_version: "1", document }],
});
const result = execute_project_runtime({
	publication: { id: id(4), snapshot },
	entry_box_id: id(3),
	input: [],
	output_cell_ids: [id(12)],
	budget: { max_steps: 100, max_call_depth: 8, max_value_nodes: 100, max_string_units: 1000 },
});
if (result.status !== "success") throw new Error(JSON.stringify(result));
if (result.outputs[0]?.value !== "Hello, typed documents!") throw new Error("Unexpected output");
console.log(result.outputs[0].value);
```
<!-- quickstart:end -->

## Public subpaths

Every row is available under `@frankfmy/typed-document-runtime/` with matching
ESM and TypeScript declarations. Implementation files are not public subpaths.

| Subpath | Purpose |
| --- | --- |
| `application-package` | Immutable package envelopes, validation, digests and identity remapping |
| `application-package-merge` | Three-way source merge and explicit conflict choices |
| `application-package-plan` | Installation previews, deterministic identities and command plans |
| `application-data-contract` | Data schema changes, fill plans and eight operation contracts |
| `application-data-query` | Validated filters, sorting and pagination requests |
| `box-document` | Typed schema graphs, values, normalization and diffs |
| `box-presentation` | Labels, forms, summaries, views and presentation binding |
| `box-program` | Expression and statement types, validation and identity projections |
| `box-program-semantics` | Program checks against a typed cell schema |
| `box-type-system` | Reference resolution and structural type comparison |
| `process-document` | Process inputs, outputs and typed effect declarations |
| `process-contract` | Application projections and installed-operation compatibility |
| `process-program` | Box statements plus effect instructions |
| `process-runtime` | Process execution and outcome types from the shared evaluator |
| `project-source-snapshot` | Canonical published and revision snapshots |
| `project-source-history` | Bound history-page and comparison parsers |
| `project-source-comparison` | Changes by stable object identity |
| `published-document` | The Box/Process document union and common operations |
| `runtime` | Box and Process execution, budgets, inspection and `RuntimeSandbox` |

See [API.md](docs/API.md) for entry points and [behavior and limits](docs/BEHAVIOR.md)
for wire contracts, canonical ordering, effect handling and resource bounds.

## Runtime support and limits

Local qualification targets Node 24.20.0, Bun 1.4.2 and Chromium 153.0.8010.12
through Vite 8.3.5 and Playwright 1.63.0 on Linux x64. TypeScript 7.0.2 checks
both NodeNext and browser bundler consumers. Other versions and browsers have
not been qualified. Browser execution needs modern ES2023 APIs and Web Crypto
in a secure context (HTTPS or localhost).

The library does not supply a UI, database, network client, authentication,
authorization, effect adapter or persistence layer. `RuntimeSandbox` is an
interactive debugger for this bounded document language, not an operating
system security boundary or a JavaScript evaluator. It does not run arbitrary
JavaScript. Existing validation diagnostics include Russian messages, and
presentation text retains its `ru`/`en` wire fields. English documentation does
not change those contracts.

## Verify and contribute

```sh
bunx --no-install playwright install chromium
bun run verify
```

The browser install is only needed when the pinned browser is absent. The
verification command runs lint, strict source/test checking, all native tests,
build, pack, independent npm and Bun installs, positive and negative type
consumers, Node and Bun programs, the quickstart, and real browser scenarios
that exercise all 19 subpaths. Generated projects, browser bundles and reports
stay in ignored `.verification/`; archives stay in ignored `.artifacts/`.
The local harness stops allocating dependencies below 10 GiB free disk space.
It closes the browsers and preview servers it starts. The CI workflow uses the same gates.

## Continuous integration

[CI runs](https://github.com/FrankFMY/typed-document-runtime/actions/workflows/ci.yml)
run the same complete `bun run verify` gate on pull requests, pushes to `main`,
and manual dispatch, with Node 24.20.0, Bun 1.4.2 and pinned Chromium.
This includes independent npm/Bun installs, all 19 subpaths, positive/negative
types, runtime and real browser scenarios, plus a dependency audit.
Logs and consumer receipts are retained for seven days; no registry publication runs.

## Author and contact

Created and maintained by [Artem Prianishnikov (Артем Прянишников / FrankFMY)](https://github.com/FrankFMY).

- Email: [Pryanishnikovartem@gmail.com](mailto:Pryanishnikovartem@gmail.com) · [frankfmy@proton.me](mailto:frankfmy@proton.me)
- Telegram: [@FrankFMY](https://t.me/FrankFMY)
- Website: [frankfmy.com](https://frankfmy.com)
- Profiles: [GitHub](https://github.com/FrankFMY) · [LinkedIn](https://www.linkedin.com/in/frankfmy/) · [X](https://x.com/FrankFMY) · [npm](https://www.npmjs.com/~frankfmy)

## License

See [CONTRIBUTING.md](CONTRIBUTING.md) for development steps and
[CHANGELOG.md](CHANGELOG.md) for release notes. The library is licensed under
[Apache-2.0](LICENSE); retain [NOTICE](NOTICE) and applicable
[third-party notices](THIRD_PARTY_NOTICES.md) when redistributing it.
