<!--
Thanks for sending this. The checklist is short on purpose: everything on it is
something CI will tell you about anyway, so ticking it just saves you a round
trip.
-->

## What this changes

<!-- What a USER of the package would notice. If the answer is "nothing", say
so — internal-only changes are welcome and skip the changelog below. -->

## Why

<!-- The problem, not the patch. If there is an issue, link it. -->

## How it was verified

<!-- Which suites you ran, and anything you checked by hand. If you changed
behavior, name the test that would have caught the old behavior. -->

- [ ] `npm test` and `npm run typecheck` pass
- [ ] `cd python && python -m pytest tests -q` passes
- [ ] Behavioral change? A test that fails without this fix comes with it
- [ ] User-visible change? An entry under `## [Unreleased]` in `CHANGELOG.md`

<!--
Both suites are offline: no API key, no spend. If you cannot run them for some
reason, say so and open the PR anyway — CI runs them on Node 18/20/22/24 and
Python 3.10/3.13.

Please do not include an API key, a request id tied to your account, or a
receipt id from a real call. Security issue? Do not open a PR:
https://github.com/ConiferKit/use-conifer/security/advisories/new
-->
