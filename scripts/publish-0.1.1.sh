#!/usr/bin/env bash
# publish-0.1.1.sh — finish the 0.1.1 release. RUN THIS IN YOUR OWN TERMINAL.
#
# WHY A SCRIPT AND NOT INSTRUCTIONS: both registries need a credential only you
# can approve — npm opens a browser for 2FA, and PyPI wants a token — so an
# agent cannot run the last step. Everything BEFORE that step is automated here
# so nothing is reconstructed from memory at the moment it matters.
#
# WHAT 0.1.1 FIXES: the published 0.1.0 README documents
# `import { VERSION } from "conifer-sdk"`, but 0.1.0 does not export VERSION.
# Anyone copying the example gets a TypeError. The docs shipped ahead of the
# artifact; this closes the gap.
#
#   ./scripts/publish-0.1.1.sh              # gate + build, stops before publish
#   ./scripts/publish-0.1.1.sh --publish    # gate + build + publish both
#
# Safe to re-run. It rebuilds artifacts from the current tree rather than
# trusting whatever is in /tmp (which macOS clears on reboot).

set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
PUBLISH="${1:-}"

step() { printf '\n==> %s\n' "$*"; }

step "Version consistency ($VERSION)"
# The suite already pins all five sites to each other; this is a fast readout.
grep -H '"version"' package.json alias/package.json | sed 's/^/    /'
grep -H '^version' python/pyproject.toml | sed 's/^/    /'
grep -H 'VERSION =' src/version.ts | sed 's/^/    /'
grep -H '^__version__' python/conifer_sdk/__init__.py | sed 's/^/    /'

step "Offline gate, both languages, both Node routes"
npm run build
npm run typecheck
npm test
CONIFER_TEST_COMPILE=1 npm test
(cd python && python3 -m unittest discover -s tests -t tests -q)

step "Live gate (spends a few tenths of a cent)"
if [ -n "${CONIFER_API_KEY:-}" ]; then
  npm run qa:live
  (cd python && python3 scripts/live_qa.py)
else
  echo "    CONIFER_API_KEY not set — SKIPPING the live gate."
  echo "    Set it and re-run if you want the full RELEASING.md gate."
fi

step "Build artifacts"
rm -rf dist-release && mkdir -p dist-release
npm pack --pack-destination dist-release >/dev/null
python3 -m venv .release-venv >/dev/null 2>&1 || true
./.release-venv/bin/pip -q install build twine >/dev/null 2>&1
(cd python && ../.release-venv/bin/python -m build --outdir ../dist-release >/dev/null)
./.release-venv/bin/twine check dist-release/*.whl dist-release/*.tar.gz
ls -la dist-release | sed 's/^/    /'

step "Consumer proof (install the tarball, import BY PACKAGE NAME)"
# NOT a dot-directory: `npm init` rejects a package name starting with "." and
# takes the name from the folder. Found by running this script, not by reading
# it. It goes under dist-release/, which is already git-ignored.
rm -rf dist-release/consumer-check && mkdir -p dist-release/consumer-check
(
  cd dist-release/consumer-check
  npm init -y >/dev/null
  npm i "../conifer-sdk-${VERSION}.tgz" --silent
  node -e "
    import('conifer-sdk').then(m => {
      if (m.VERSION !== '${VERSION}') {
        console.error('FAIL: tarball reports', m.VERSION, 'not ${VERSION}');
        process.exit(1);
      }
      console.log('    VERSION from the tarball:', m.VERSION);
    })"
  test -f node_modules/conifer-sdk/CHANGELOG.md && echo "    CHANGELOG ships"
  test -L node_modules/.bin/conifer-mcp && echo "    MCP bin links"
)

if [ "$PUBLISH" != "--publish" ]; then
  cat <<EOF

==> DRY RUN COMPLETE — nothing published.
Artifacts are in ./dist-release. To publish for real:

    ./scripts/publish-0.1.1.sh --publish

npm opens a browser for 2FA. PyPI needs a token: create one at
https://pypi.org/manage/account/token/ (scope it to the conifer-sdk project
now that the project exists), then either export TWINE_USERNAME=__token__ and
TWINE_PASSWORD=pypi-…, or put them in ~/.pypirc.
EOF
  exit 0
fi

step "PUBLISH to npm (a browser will open for 2FA)"
npm publish --access public

step "PUBLISH to PyPI"
./.release-venv/bin/twine upload dist-release/*.whl dist-release/*.tar.gz

step "Verify what the registries actually serve"
sleep 5
npm view "conifer-sdk@${VERSION}" version
curl -fsS "https://pypi.org/pypi/conifer-sdk/${VERSION}/json" >/dev/null && echo "PyPI has ${VERSION}"

cat <<EOF

==> RELEASE LIVE — ${VERSION} on both registries.

Still to do by hand:
  git tag -a sdk-v${VERSION} -m "conifer-sdk ${VERSION}" && \\
    git push https://github.com/ConiferKit/use-conifer.git sdk-v${VERSION}

  cd alias && npm publish --access public   # the @conifer scope, if it works now
                                            # see docs/npm-scope-blocked.md
EOF
