# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is written for the person deciding whether to upgrade. An entry says
what changed in the software and what it means for a caller — not what a commit
touched. `scripts/check-changelog.mjs` enforces the structural rules and runs in
CI; the judgement about whether an entry is worth reading is the reviewer's.

## [Unreleased]

## [0.1.1] - 2026-08-28

### Added

- `VERSION`, exported from the package root, so a bug report can name exactly
  what ran: `import { VERSION } from "conifer-sdk"`. Python already had
  `conifer_sdk.__version__`; both are now pinned to the manifests by tests in
  both suites, so a release cannot ship a client that misreports itself.
- `CHANGELOG.md` now ships inside the package, so `npm i` and the registry page
  carry the history rather than only the repository.

### Fixed

- The 0.1.0 README documented `import { VERSION }` from a package that did not
  export it, so the example threw `TypeError` for anyone who copied it. The
  docs and the artifact are back in agreement.

## [0.1.0] - 2026-08-27

First public release, on [npm](https://www.npmjs.com/package/conifer-sdk) and
[PyPI](https://pypi.org/project/conifer-sdk/) as `conifer-sdk`.

### Added

- **One client, two languages.** TypeScript and Python clients with matching
  behavior, verified against shared contract cards so a refusal in one is a
  refusal in the other.
- **Exact per-turn cost receipts.** Every response carries `receipt.costUsd`
  (`cost_usd` in Python) as the settled cost of that call, itemized across four
  token classes rather than estimated from a price table.
- **Server-enforced spend ceilings.** `maxCostNanoUsd` refuses a turn that could
  exceed it, at the gateway, before the money is spent.
- **`SpendBudget` and `ReceiptCollector`** for bounding and observing spend
  across many calls, including calls made by a raw `fetch` you already have.
- **An MCP server** (`npx -y conifer-sdk conifer-mcp`) exposing the catalog to
  any MCP client, with six tools including `conifer_compare`.
- **Migration shims** from OpenRouter, Vercel AI Gateway, and Helicone that
  refuse what they cannot faithfully translate instead of silently changing
  what runs.
- **Zero runtime dependencies** in both languages. The `[tls]` extra on Python
  is opt-in, for environments whose CA trust store is empty.

### Fixed

- The npm `bin` path lost its `./` prefix. npm validates bin paths at publish
  and **silently drops** a `"./"`-prefixed entry, so only the published package
  would have lost `npx conifer-mcp` — invisible in local testing, broken for
  every MCP client config. Pinned by a packaging test.
- The Python `readme` resolved to nothing, which does not fail the build and
  produces a **blank PyPI project page**. Caught by inspecting the built wheel's
  metadata rather than trusting a green build.

[Unreleased]: https://github.com/ConiferKit/use-conifer/compare/sdk-v0.1.1...HEAD
[0.1.1]: https://github.com/ConiferKit/use-conifer/compare/sdk-v0.1.0...sdk-v0.1.1
[0.1.0]: https://github.com/ConiferKit/use-conifer/releases/tag/sdk-v0.1.0
