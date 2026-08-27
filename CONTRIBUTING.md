# Contributing

Thanks for helping improve the Conifer SDK. This document is short on purpose:
the useful rules fit on one page.

## What is most useful

**Integration bugs.** A real client library, framework, editor, or agent that
does not work against the gateway when it should. These are the reports we
cannot easily generate ourselves, and they are the ones that matter most: they
are where Conifer quietly diverges from the ecosystem it claims to be
compatible with.

A good report names the client and its version, the exact request, what you
expected, and what happened instead.

**Please do not** paste an API key, a request id tied to your account, or a
full production response body into an issue. If a report needs one of those to
make sense, say so and we will find another way.

## Running the suites

**Node 22 or newer is required to run the TypeScript suite**, which executes
the `.ts` sources directly through `--experimental-strip-types`. That is a
contributor requirement only: the published package is compiled ESM and
supports Node 18 and up, which CI proves on every push.

```bash
git clone https://github.com/ConiferKit/use-conifer
cd use-conifer

npm ci
npm test            # TypeScript
npm run typecheck

cd python
python -m pytest tests -q
```

Both suites are **offline**. They exercise the client against recorded shapes
and the vendored gateway contract, so they need no API key, spend no money, and
run unchanged in a fork's CI. Every pull request must keep both green, and a
behavioral change should arrive with the test that would have caught it.

## House rules

These are the invariants that make the package worth depending on. A change
that breaks one of them will be asked to change, however good the idea is.

**The two languages are twins.** A capability that lands in TypeScript lands in
Python with the same semantics, in the naming each language expects:
`maxCostNanoUsd` and `max_cost_nano_usd` are the same field. A feature in one
language only is an unfinished feature.

**Refuse; never silently drop.** When Conifer cannot honor a field from another
gateway's dialect, the migration shim raises and names the replacement. A
migration that looks clean while changing what actually runs, and what it
costs, is the exact failure this rule exists to prevent.

**Money is exact.** Costs are integer nanodollars end to end. No floats
anywhere near a price, in either language.

**The contract is data, not prose.** `cards/` describes what the SDK reads,
what it emits, and what each competitor's field maps to;
`contracts/gateway-contract.json` is the gateway's own generated wire contract,
vendored and pinned. The tests read those files, so changing documented
behavior means changing the card, not just the code.

**No new runtime dependencies.** Both packages install with an empty dependency
list, deliberately: the SDK has to work in a lambda, a locked-down build image,
or a security review without dragging a package tree behind it. A PR that adds
a dependency needs to argue for it first, in an issue.

## Pull requests

Keep the diff to one subject. Explain *why* in the commit message rather than
restating *what* the diff already shows. If the change is user-visible, update
the README in the same PR, so the docs never lag the code by even one commit.

## Scope

This repository is the client and everything built against the public API. The
gateway itself, the routing engine, and billing are not here. Minting and
revoking API keys happens at
[the console](https://conifer.build/console#/keys); the SDK only ever reads a
key you already hold from `CONIFER_API_KEY`.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, the same license that covers this repository.
