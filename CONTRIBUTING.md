# Contributing

Use Node 24.20.0 and Bun 1.4.2. Install the exact lockfile with
`bun install --frozen-lockfile`. The package remains private until its owner
establishes registry publication authority.

Run `bun run lint`, `bun run check`, `bun test src tests --max-concurrency 1`,
`bun run build`, `bun run pack`, then `bun run verify:package`. The one-command
form is `bun run verify`. If Chromium is missing, install the pinned browser
with `bunx --no-install playwright install chromium` first. The test suite uses
Bun's native runner; `.js` relative imports resolve to the matching `.ts` sources.
The separate package consumers compile and run emitted JavaScript from the
installed archive, with no source aliases or workspace dependencies.

Source and native test checks use TypeScript strict mode with dependency
checking enabled. Consumer checks also exercise NodeNext and Bundler resolution,
including deliberately invalid type uses. Oxlint's correctness rules run with
warnings treated as failures and unused suppression directives reported. Keep
the existing tab-indented source style. Do not suppress a finding to make a gate
pass or translate diagnostics as an incidental cleanup.

Keep changes narrow. Add behavioral regression tests for wire contracts,
ordering, digest identities, bounds, effects and continuations. Preserve all
public subpaths and the shared evaluator. Never replace insertion-order package
digests with sorted-key operation digests. Update the README, API guide and
changelog when public behavior changes. The README quickstart must exactly
match `examples/quickstart.mjs`; verification executes both Node and Bun forms.

Generated artifacts and consumer projects stay in `.artifacts/`, `dist/` and
`.verification/`. The consumer harness checks available disk before installs
and closes its own browser and preview server in a finally block. It does not
clean shared caches. Do not include credentials, private paths or verification
receipts in public package files. Retain the complete license and applicable
third-party notices. There is no configured hosted workflow.

Owner and maintainer: Artem Prianishnikov (FrankFMY). Contribution proposals can
be discussed through repository issues or pull requests when the repository is
available. This document does not designate a private security reporting channel.
