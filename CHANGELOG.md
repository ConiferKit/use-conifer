# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is written for the person deciding whether to upgrade. An entry says
what changed in the software and what it means for a caller — not what a commit
touched. `scripts/check-changelog.mjs` enforces the structural rules and runs in
CI; the judgement about whether an entry is worth reading is the reviewer's.

## [Unreleased]

### Added

- `serverFallbackModels` (TS) / `server_fallback_models` (Python): models the
  GATEWAY falls back to, in order, when the requested model's upstream call
  fails. Sent as `x-conifer-fallback-models`.

  This is the one to reach for in production, and it is a different thing from
  the existing `fallbackModels`. That one is a CLIENT chain — a second HTTP
  request, decided here, only after a retryable refusal reaches you; it cannot
  help a stream, and each member is separately billed. The new field is ONE
  request: the gateway holds money once for the whole chain, dispatches the
  members in your order, settles once against whichever served, and refunds in
  full if none did. Because the gateway sees the provider's own failure it can
  advance on classes a client never gets to judge — including the 4xx a
  mis-configured model surface returns, which is the failure this exists for.

  Every member is admitted by the gateway like a primary before anything is
  spent, and an unknown model is refused BY NAME rather than silently skipped:
  a fallback you believe is armed and is not is worse than an error. The SDK
  mirrors the gateway's own rules rather than inventing stricter ones —
  duplicates and the model you already requested are dropped, at most three
  members survive, and a member that cannot ride the header at all (blank, or
  carrying a comma or a non-ASCII byte) throws at the call site. When nothing
  survives, no header is sent.

  A served fallback is disclosed, never silent: the receipt's `effectiveModel`
  names the member that answered and `reason` reads `provider_failover` (the
  gateway reuses that reason code rather than minting a new one). On a STREAMED
  turn the handshake headers are written before the failover resolves, so
  `reason` reads `as_requested` there while `effectiveModel` is still correct —
  read the model, not the reason, to detect a substitution.

  Requires a gateway carrying `x-conifer-fallback-models` (ConiferKit/typhoon#356).

### Changed

- The migration shims now map fallback intent onto the gateway chain, which is
  what those features always meant on the platform you are leaving:
  - OpenRouter's `route: "fallback"` **converts** instead of throwing (it asked
    the proxy to fail over, and the gateway now does), taking `models` as the
    server chain. Without `route`, `models` keeps its old client-chain meaning.
  - Helicone's `Helicone-Fallbacks` maps to the server chain rather than the
    client one — Helicone walked it in the proxy, on one request, and mapping it
    client-side silently turned that into several billed requests.

## [0.1.2] - 2026-08-29

### Added

- `ConiferCapabilityError` (TS and Python), a `ConiferBadRequestError` subclass
  raised when the gateway refuses a request the MODEL cannot serve: image
  content on a model without the `vision` cap, tools on a no-tool model, or an
  over-`max_tools` array. It carries the new `param` field (`messages`,
  `tools`, `tool_choice`) and `modelSwitchable = true` — the one 400 a
  different model can fix. Nothing is billed for the refusal.
- `error.param` is now read from the gateway envelope and exposed on every
  error class (`param` in TS, `.param` in Python).

### Changed

- The `chat()` client-side fallback chain (TS) now advances on a
  `ConiferCapabilityError` in addition to retryable failures: a chain like
  `{model: "deepseek-v4-flash", fallbackModels: ["glm-5.3-flash"],
  allowClientFallback: true}` absorbs an image turn the primary cannot take,
  so the end user never sees the error. All other 4xx still throw immediately.

## [0.1.1] - 2026-08-28

### Added

- `VERSION`, exported from the package root, so a bug report can name exactly
  what ran: `import { VERSION } from "conifer-sdk"`. Python already had
  `conifer_sdk.__version__`; both are now pinned to the manifests by tests in
  both suites, so a release cannot ship a client that misreports itself.
- `CHANGELOG.md` now ships inside the package, so `npm i` and the registry page
  carry the history rather than only the repository.
- The TypeScript sources ship alongside the build, so stack traces and
  step-debugging resolve into real code instead of stopping at compiled output.

### Fixed

- The 0.1.0 README documented `import { VERSION }` from a package that did not
  export it, so the example threw `TypeError` for anyone who copied it. The
  docs and the artifact are back in agreement, and a test now parses every
  import out of the README and fails if the package does not provide it — in
  both languages, so that class of defect cannot ship again.
- The Python package shipped without its PEP 561 `py.typed` marker, so mypy and
  pyright were required to treat it as untyped: every annotation resolved to
  `Any`, and `import conifer_sdk` under a type checker raised "missing library
  stubs or py.typed marker". The package was fully typed and none of it reached
  anyone. Verified with mypy against the built wheel before and after.
- 0.1.0 shipped 16 source maps pointing at `src/*.ts`, which was not in the
  published files — every one dangled, so debugging showed "source not found"
  and the maps were dead weight. The sources now ship, and a test fails if a
  map ever references a path the package does not include.

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

[Unreleased]: https://github.com/ConiferKit/use-conifer/compare/sdk-v0.1.2...HEAD
[0.1.2]: https://github.com/ConiferKit/use-conifer/compare/sdk-v0.1.1...sdk-v0.1.2
[0.1.1]: https://github.com/ConiferKit/use-conifer/compare/sdk-v0.1.0...sdk-v0.1.1
[0.1.0]: https://github.com/ConiferKit/use-conifer/releases/tag/sdk-v0.1.0
