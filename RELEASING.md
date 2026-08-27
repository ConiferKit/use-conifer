# Releasing

The SDK is **not on npm or PyPI yet**. Both names are free as of 2026-08-27
(`@conifer/sdk` 404s, the `@conifer` npm scope is unclaimed, `conifer-sdk` 404s
on PyPI), and the README is honest that installation is from source.

Publishing is deliberately a human action: it is public, irreversible per
version, and npm/PyPI both refuse to reuse a version number even after an
unpublish. This document exists so it is a checklist rather than improvisation.

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
