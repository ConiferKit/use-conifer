"""Read authoritative receipts for one SDK QA phase; never issue inference."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import os
import time

import requests

FIELDS = ('request_id', 'requested_model', 'model', 'venue', 'reason',
          'net_charged_nanousd', 'prompt_tokens', 'completion_tokens',
          'cache_read_tokens', 'cache_write_tokens', 'lane', 'provider')


def validate(admissions, receipts):
    by_id = {}
    for receipt in receipts:
        rid = receipt.get('request_id')
        if rid in by_id:
            raise ValueError('Duplicate authoritative receipt')
        by_id[rid] = receipt
    accepted, missing, refusals = [], [], []
    for admission in admissions:
        rid = admission['request_id']
        response = admission.get('response', {})
        status = response.get('status')
        body = response.get('body') or {}
        code = body.get('error', {}).get('code') if isinstance(body, dict) else None
        # Only explicit admission refusals can be accounted for without a
        # receipt. A timeout, 5xx, or unknown outcome retains its whole reserve.
        refusal = status in (400, 401, 402, 403, 404, 422) and code != 'output_budget_exhausted'
        receipt = by_id.get(rid)
        if receipt is None:
            (refusals if refusal else missing).append(rid)
            continue
        for key in ('net_charged_nanousd', 'prompt_tokens', 'completion_tokens',
                    'cache_read_tokens', 'cache_write_tokens'):
            if type(receipt.get(key)) is not int or receipt[key] < 0:
                raise ValueError('Invalid authoritative counter: ' + key)
        if receipt.get('lane') == 'byok':
            raise ValueError('Unexpected BYOK accounting lane')
        cost = receipt['net_charged_nanousd']
        if cost > admission['cap_nanousd'] or (refusal and cost != 0):
            raise ValueError('Authoritative charge violates request ceiling/refusal')
        if 'cost_nanousd' in admission and admission['cost_nanousd'] != cost:
            raise ValueError('Authoritative and wire costs disagree')
        request = admission.get('body') or {}
        output_limit = request.get('max_tokens', request.get('max_output_tokens'))
        if admission['path'] == '/v1/embeddings':
            output_limit = 0
        if output_limit is not None and receipt['completion_tokens'] > output_limit:
            raise ValueError('Authoritative output exceeds admitted limit')
        wire_model = response.get('headers', {}).get('x-conifer-effective-model')
        if wire_model and receipt.get('model') != wire_model:
            raise ValueError('Authoritative and wire model disagree')
        accepted.append({k: receipt[k] for k in FIELDS if k in receipt})
    return accepted, missing, refusals


def validate_embedding_ledger(proof, admissions, state_sha, phase):
    """Validate operator-supplied read-only ledger evidence, separately from usage receipts."""
    assert proof['passed'] is True and proof['source'] == 'postgres_read_only_snapshot'
    assert proof['state_sha256'] == state_sha and proof['phase'] == phase
    by_id = {r['request_id']: r for r in admissions}
    seen = set()
    for row in proof['settlements']:
        rid = row['request_id']; admission = by_id[rid]
        assert rid not in seen; seen.add(rid)
        assert admission['path'] == '/v1/embeddings' and admission['response']['status'] == 200
        assert sum(d['request_id'] == rid for d in row['debits']) == 1
        assert len({d['request_id'] for d in row['debits']}) == len(row['debits'])
        assert len({c['idempotency_key'] for c in row['credits']}) == len(row['credits'])
        paid = 0; refunded = 0
        for debit in row['debits']:
            assert debit['request_id'] in (rid, rid + ':embeddings-extra')
            assert debit['debit_state'] == 'settled' and debit['debit_kind'] in ('source', 'legacy')
            amount = debit['actual'] if debit['debit_kind'] == 'source' else debit['amount']
            assert type(amount) is int and amount >= 0
            paid += amount
        for credit in row['credits']:
            assert credit['idempotency_key'] in (rid + ':embeddings-refund', rid + ':embeddings-upstream-refund')
            assert credit['kind'] == 'grant' and credit['debt_delta'] == 0
            amount = credit['spendable_delta']
            assert type(amount) is int and 0 <= amount <= credit['amount'] and amount == credit['granted']
            refunded += amount
        assert type(row['net_charged_nanousd']) is int
        assert paid - refunded == row['net_charged_nanousd'] == admission['cost_nanousd']
        assert 0 <= paid - refunded <= admission['cap_nanousd']
    return proof['settlements']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=('typescript', 'python'), required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--embedding-ledger-proof', type=Path)
    args = parser.parse_args()
    state_path = args.run_dir / 'state.json'
    root = args.run_dir.parent
    frozen = state_path.read_bytes()
    state = json.loads(frozen)
    admissions = [r for r in state['admissions'] if r['phase'] == args.phase and r['cap_nanousd'] > 0]
    assert admissions, 'No inference admissions for this phase'
    assert len({r['request_id'] for r in admissions}) == len(admissions)
    admin = os.environ.get('CONIFER_QA_ADMIN_SECRET')
    assert admin, 'Set CONIFER_QA_ADMIN_SECRET privately for read-only authoritative receipts'
    since = dt.datetime.fromtimestamp(state['started'] - 5, dt.timezone.utc).isoformat()
    ids = {r['request_id'] for r in admissions}
    deadline = time.monotonic() + 15
    receipt_events = []
    fault = None
    accepted, missing, refusals = [], sorted(ids), []
    ledger = []
    try:
        if args.embedding_ledger_proof:
            ledger = validate_embedding_ledger(json.loads(args.embedding_ledger_proof.read_text()),
                admissions, hashlib.sha256(frozen).hexdigest(), args.phase)
        ledger_ids = {r['request_id'] for r in ledger}
        receipt_admissions = [r for r in admissions if r['request_id'] not in ledger_ids]
        while True:
            response = requests.get('https://api.conifer.build/admin/usage/receipts',
                                    params={'since': since, 'until': dt.datetime.now(dt.timezone.utc).isoformat()},
                                    headers={'Authorization': 'Bearer ' + admin},
                                    timeout=(5, 15), allow_redirects=False)
            response.raise_for_status()
            rows = response.json()['rows']
            assert isinstance(rows, list) and all(isinstance(r, dict) for r in rows)
            filtered = [{k: r[k] for k in FIELDS if k in r} for r in rows if r.get('request_id') in ids]
            receipt_events = filtered
            accepted, missing, refusals = validate(receipt_admissions, filtered)
            if not missing or time.monotonic() >= deadline:
                break
            time.sleep(1)
        assert not missing, 'Authoritative receipt not observed for dispatched request'
        assert state_path.read_bytes() == frozen, 'QA state changed during reconciliation'
    except Exception as error:
        fault = type(error).__name__ + ': ' + str(error)
    matched = {r['request_id'] for r in accepted + ledger} | set(refusals)
    outstanding = [r for r in admissions if r['request_id'] not in matched]
    record = {'phase': args.phase, 'at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'state_sha256': hashlib.sha256(frozen).hexdigest(), 'passed': fault is None,
              'fault': fault, 'admissions': len(admissions), 'settled_receipts': accepted,
              'settled_embedding_ledger': ledger,
              'receipt_events': receipt_events, 'confirmed_admission_refusals': refusals,
              'settled_nanousd': sum(r['net_charged_nanousd'] for r in accepted + ledger),
              'outstanding_ids': [r['request_id'] for r in outstanding],
              'outstanding_reserved_nanousd': sum(r['cap_nanousd'] for r in outstanding)}
    (root / ('reconciliation-' + args.phase + '.json')).write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({k: v for k, v in record.items() if k not in ('settled_receipts', 'receipt_events', 'settled_embedding_ledger')}))
    if fault:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
