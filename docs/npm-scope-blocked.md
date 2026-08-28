# The `@conifer` npm scope — blocked, and what to do about it

Status as of 2026-08-28. Owned by whoever holds the npm account; nothing here
can be finished by an agent, because every remaining step needs a browser 2FA
approval that cannot be scripted.

## The short version

`conifer-sdk` (unscoped) is live on npm and PyPI and is the real package. The
`@conifer` scope is **unclaimed and unpublishable**, so anyone can register it
and publish something that looks official. `alias/` is built, tested, and ready
to publish the moment the scope works.

## What is actually wrong

The `conifer` org exists and `conifer_v11` is its **owner**:

```
GET /-/org/conifer/user   ->  {"conifer":"owner"}
```

But the org has **zero teams**:

```
GET /-/org/conifer/team          ->  []
npm team ls conifer:developers   ->  404 Team not found
```

npm grants package-*create* rights through a team. With no teams, not even the
owner can create the first package in the scope, so `PUT /@conifer%2fsdk`
fails. npm reports that as **404, not 403**, deliberately, so the registry does
not leak which private package names exist — which is why this looked like a
missing-package problem for hours.

A brand-new org with no default `developers` team is not normal. This is npm-side
state, not a configuration mistake on our end.

## What was already ruled out

Each of these was tried against the live registry and produced the same 404 on
the PUT:

- a granular token scoped to "only select packages" (empty set)
- a granular token regenerated with scope/all-packages selected
- a full `npm login` browser session token — **2FA succeeded and the PUT still
  404'd**, which is what proves this is not a credentials problem
- `npm team create conifer:developers` from the CLI (needs 2FA, then no effect)

One later attempt reached the **EOTP prompt** rather than the 404. That is a
change in behavior and may mean the scope is now publishable. Try the publish
before assuming it is still broken.

## Try this first (2 minutes)

```bash
cd sdk/alias
npm publish --access public      # opens a browser for 2FA
```

If it succeeds, the scope is claimed — done, and delete this file's "blocked"
framing. Verify with:

```bash
npm view @conifer/sdk version                       # expect the SDK's version
cd /tmp && npm init -y && npm i @conifer/sdk        # expect conifer-sdk pulled in
```

## If it still 404s: the support ticket

<https://www.npmjs.com/support> → "I need help with an organization".

> **Subject:** Org `conifer` has no teams; owner cannot create a package in the
> `@conifer` scope
>
> The organization `conifer` was created on 2026-08-27 under the account
> `conifer_v11`. `GET /-/org/conifer/user` reports `{"conifer":"owner"}`, so
> membership is correct.
>
> However `GET /-/org/conifer/team` returns `[]` — the org has no teams at all,
> not even the default `developers` team, and `npm team ls conifer:developers`
> returns "Team not found". Creating a team from the CLI has no effect.
>
> As a result, publishing any package into the scope fails:
> `404 Not Found - PUT https://registry.npmjs.org/@conifer%2fsdk`
>
> This was reproduced with a granular access token scoped to the org with
> read/write and 2FA bypass, and separately with a full `npm login` session
> token where the browser 2FA step completed successfully before the PUT still
> returned 404. So this does not appear to be a credentials problem.
>
> Could you check whether the org was provisioned without its default team, and
> restore it? We would like to publish `@conifer/sdk` as an alias that
> re-exports our existing public package `conifer-sdk`, so the scope matching
> our project name is not left available to someone else.

## Why we care about an empty scope

Not vanity. Our own docs and README referenced `@conifer/sdk` for weeks before
the rename, and the name still appears in older git history, issues, and any
blog post or LLM answer written in that window. Someone typing the scoped name
today gets a 404; if a squatter registers it, they get **that person's code**,
running under a name that looks first-party.

`alias/` closes this: it re-exports `conifer-sdk` verbatim at an exact pinned
version, so anyone who guesses the scoped name gets the real SDK. It is
verified by installing the packed tarball and making a real gateway call
through it, and `npm test` pins its version and dependency to the SDK's.
