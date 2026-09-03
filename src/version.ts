// version.ts — the SDK's version, as a value consumers can read.
//
// WHY A LITERAL AND NOT A package.json READ. The built package lives at
// dist/src/version.js, so reaching package.json means a `../../` path that is
// correct in the tarball and wrong in the repo, plus a JSON import assertion
// whose syntax is still not portable across the Node range this package
// advertises (18 through 24). A literal has none of those failure modes.
//
// The cost of a literal is drift, so it is GATED: `version stays in lockstep
// with package.json` in tests/packaging.test.ts fails the build if this line
// and the manifest disagree, and a companion test pins the Python constant to
// pyproject.toml. Releasing therefore cannot silently ship a lying version.
//
// Bump this in the same commit as package.json and python/pyproject.toml.
export const VERSION = "0.2.0";
