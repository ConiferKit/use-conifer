# Releasing

Both packages are **live** as `conifer-sdk` (0.1.0, published 2026-08-27): npm
and PyPI. Verified from clean installs on both: import by package name, a real
gateway call, and a real cost receipt.

## The `@conifer/sdk` alias

`alias/` is a SEPARATE, near-empty package published as `@conifer/sdk`. It
depends on `conifer-sdk` at an exact version and re-exports it, nothing more.

It exists for ONE reason: an unclaimed scope is a supply-chain hole. Anyone can
register `@conifer` and publish something that looks official under a name our
own docs used to mention. Holding the name closes that, and anyone who guesses
the scoped name gets the real SDK instead of a 404.

It is NOT the package to develop against, and it is not in the main tarball.
When bumping the SDK, bump `alias/package.json` version AND its
`dependencies.conifer-sdk` to the same number, then publish it after the real
package (its dependency must exist first).

**It is not published yet.** The `@conifer` scope cannot currently be published
to at all — the org has zero teams, so not even its owner can create the first
package in it, and npm reports that as a 404 rather than a permission error.
[docs/npm-scope-blocked.md](docs/npm-scope-blocked.md) has the evidence, what
was already ruled out, the two-minute retry, and a ready-to-send support ticket.

NOTE ON THE NAME. The SDK itself ships UNSCOPED. `@conifer/sdk` was the intent and the
`conifer` org exists with `conifer_v11` as owner, but every publish into the
scope 404s on the PUT — the org has ZERO teams (`GET /-/org/conifer/team`
returns `[]`, and `npm team ls conifer:developers` says "Team not found"), and
npm grants package-create rights through a team, so even the owner cannot
create the first package in the scope. That was reproduced against a granular
token, a scope-granted token, and a full browser-2FA login: the 2FA succeeded
and the PUT still 404'd, which is npm reporting a permission failure as a 404
so it does not leak private package names. Unscoped `conifer-sdk` sidesteps the
org entirely and matches the PyPI name. If the org is ever repaired, publish
`@conifer/sdk` as an alias that re-exports; do not rename this package.

Publishing is deliberately a human action: it is public, irreversible per
version, and npm/PyPI both refuse to reuse a version number even after an
unpublish. This document exists so it is a checklist rather than improvisation.

## Bumping the version

FOUR files carry the version and all four must move together:

| File | What it feeds |
|---|---|
| `package.json` | the npm package |
| `python/pyproject.toml` | the PyPI package |
| `src/version.ts` | `VERSION`, what a TS caller reports in a bug report |
| `python/conifer_sdk/__init__.py` | `__version__`, the same for Python |

You do not have to remember this: `npm test` fails if any of the four disagree,
and fails again if `CHANGELOG.md` has no section for the new version. Add the
changelog entry in the SAME commit as the bump — `scripts/check-changelog.mjs`
(also run by `npm test`) rejects a release with no entry, an entry that is a
raw commit subject, an entry citing a bare SHA, and an empty category.

## Before you publish anything

Run the whole gate. Not one of these is decorative — the live and consumer
checks each caught defects the offline suite could not see.

```bash
# 1. Offline, both languages, on the Node the package advertises.
npm run build && npm test && npm run typecheck
CONIFER_TEST_COMPILE=1 npm test          # the older-Node route CI uses
cd python && python3 -m pytest -q
python3 -m unittest discover -s tests -t tests -q   # the no-pytest route

# 2. Against the REAL gateway. Spends a few tenths of a cent, on purpose.
CONIFER_API_KEY=sk-… npm run qa:live
cd python && CONIFER_API_KEY=sk-… python3 scripts/live_qa.py
```

Then check the artifacts themselves, because a green build says nothing about
what is inside the tarball:

```bash
npm pack --dry-run                 # 52 files, no tests/, no scripts/, no dist maps you did not mean
cd python && python3 -m build      # then INSPECT the wheel, see below
```

The Python metadata is worth reading by hand at least once per release. A
`readme` that resolves to nothing produces a blank PyPI page and does **not**
fail the build — that exact bug was live in this repo until 2026-08-27:

```bash
python3 -c "
import zipfile; z = zipfile.ZipFile('dist/conifer_sdk-0.1.0-py3-none-any.whl')
m = z.read('conifer_sdk-0.1.0.dist-info/METADATA').decode()
body = m.split('\n\n', 1)[1] if '\n\n' in m else ''
print('description bytes:', len(body))    # ~24000, not 0
"
```

Finally, install what you are about to publish into a clean project and use it
as a consumer would. This is how the empty-CA-store bug and the 409 backoff bug
were found — both would otherwise have met a new user on their first call.

```bash
npm pack --pack-destination /tmp/consumer && cd /tmp/consumer
npm init -y && npm i ./conifer-sdk-0.1.0.tgz
# import by PACKAGE NAME, call the gateway, check types resolve under strict

python3 -m venv /tmp/pyconsumer && /tmp/pyconsumer/bin/pip install "path/to/python[tls]"
```

## The public mirror (`ConiferKit/use-conifer`)

The public repo is generated, never hand-edited. It is the `sdk-public` branch
of the workspace repo, pushed to the mirror's `main`:

```bash
bash sdk/scripts/public-split.sh                                  # regenerate
git push https://github.com/ConiferKit/use-conifer sdk-public:main
```

It is a **filtered** split, not `git subtree split --prefix=sdk`. Some paths
under `sdk/` are deliberately private, and a plain subtree split publishes
them — that is not hypothetical: `agents/` (the unreleased `conifer-agents`
package) shipped to the public mirror at `fcb7dd7` that way, and was removed at
`30b4a97`. The exclusion list lives in `scripts/public-split.sh` and the script
re-checks recursively that each exclusion actually took, so a typo fails loudly
instead of publishing.

Editing the mirror directly is the other way this goes wrong: the next split
overwrites it, silently. Land the change in `sdk/` on `main` and regenerate.

## Publishing

```bash
# npm — the @conifer scope must exist and be public.
npm adduser                    # not authenticated on any dev machine by default
npm publish --access public    # scoped packages are private unless you say this

# PyPI — upload to TestPyPI first and install from it.
python3 -m twine upload --repository testpypi dist/*
python3 -m twine upload dist/*
```

`--access public` is not optional: a scoped npm package publishes **private** by
default, which on a paid org silently succeeds and on a free one fails with a
message about paid plans. Neither is what you want at launch.

## After

Update the README's install block — it currently says, correctly, that neither
registry has the package. Leaving that text in place after publishing is the
kind of small dishonesty that costs trust on exactly the day it matters.

Tag the release, and keep `package.json` and `pyproject.toml` versions in step.
They are separate files with no shared source of truth, so a mismatched pair
ships silently.
