# Bounded SDK release QA

Both language harnesses use the same locked admission journal. Execution needs
an approved request/spending plan, `CONIFER_API_KEY`, an unused
`CONIFER_QA_RUN_DIR`, and installed release artifacts. Missing `--execute` exits
nonzero, so an omitted live gate cannot pass a publisher's checks.

For the 0.2.1 campaign, the combined ceiling is 40 POSTs and $1.850000002 in
reserved caller-cost limits. The gateway build and allowed models are pinned in
the guard and transport helpers. No inference retries, redirects or deferred jobs
are allowed. A halted or already claimed campaign cannot be silently restarted.

Run the following commands separately and check each exit status:

```sh
# CONIFER_QA_NODE_PACKAGE points to the installed npm artifact's dist/src/index.js.
node sdk/scripts/live-qa.mjs --execute

# Supply CONIFER_QA_ADMIN_SECRET privately. This command only reads receipts.
python3 sdk/scripts/live_qa_reconcile.py --phase typescript --run-dir "$CONIFER_QA_RUN_DIR"

# Use the Python interpreter from the environment containing the release wheel.
python-consumer/bin/python sdk/python/scripts/live_qa.py --execute
python3 sdk/scripts/live_qa_reconcile.py --phase python --run-dir "$CONIFER_QA_RUN_DIR"
```

The reconciler requires `requests` in its own execution environment. It matches
only this campaign's request identities, validates authoritative charges against
each reservation, checks observed cost/model agreement, and writes
`reconciliation-typescript.json` beside the run directory. The proof includes
the exact journal SHA-256 and no unresolved request identities. Python requires
that proof plus a successful TypeScript phase before it can claim its phase.
TypeScript does not create its own settlement proof merely because its checks
passed: streams can finish before ledger settlement is visible.

The current gateway's usage-receipts feed omits embeddings. For these requests,
an operator can supply `--embedding-ledger-proof PATH` from an exact read-only
database query bound to the journal hash. Validation requires settled base/extra
debits and actual credited refunds, cross-checked against grant operations and
sources. The report keeps this money evidence separate from usage receipts;
model and token counts remain wire observations. Missing or inconsistent ledger
evidence leaves the campaign unresolved. No settlement or migration functions
may be called to perform this read.

If either phase fails, stop new dispatch and run read-only reconciliation. Keep
the journal, logs and failed observations. Never fabricate a successful marker,
delete the campaign to rerun it, or release an unresolved spending reserve.

The first 0.2.1 attempt stopped on a valid header-only cost receipt because the
guard incorrectly required cost on the raw body before SDK enrichment. The
corrected guard accepts absent body costs, validates supplied costs, and keeps
the live SDK-level assertion that `answer.usage` matches the settled receipt.
For that specific case only, `--resume-after-repair` accepts a successful
SHA-bound authoritative receipt proof for the one preserved POST. It retains
the request, charge and full reserve and permits only one explicit continuation.
The embedding-width check reuses the newly observed live vector, saving one POST
so the failed attempt plus the continuation fit the original request limits.
Only the reconciled interval with no dispatch while repairing the QA guard is
excluded from the active 15-minute phase and 30-minute combined QA deadlines.
Pre-failure active time remains counted, including the transport abort timer.

The continuation also found a local admission bug: an earlier GET has no body,
so checking its model while admitting the final auto request raised before any
dispatch. The guard now handles bodyless GETs. `--continue-final-auto` requires
an explicit, independently reconciled manual recovery recorded under the journal
lock; it retains the 25 completed checks and runs their original final auto
assertions. The recovered phase permits that one remaining inference POST and
any unused route warmups within the original six-attempt total, and cannot
finish successfully without all 26 checks. An unfinished transaction remains
blocking until the operator verifies and archives it; this flag does not clear it.

Offline checks:

```sh
cd sdk/scripts
python3 -m unittest test_live_qa_guard.py test_live_qa_reconcile.py
node --test test-live-qa-transport.mjs
```
