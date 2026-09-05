import unittest
import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from live_qa_reconcile import validate
import live_qa_reconcile
from live_qa_guard import Guard
from copy import deepcopy


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.admission = {'request_id': 'qa-one', 'cap_nanousd': 50_000_000,
                          'path': '/v1/chat/completions', 'body': {'max_tokens': 128},
                          'cost_nanousd': 1234,
                          'response': {'status': 200, 'body': {}, 'headers': {'x-conifer-effective-model': 'gpt-4.1-nano'}}}
        self.receipt = {'request_id': 'qa-one', 'model': 'gpt-4.1-nano',
                        'net_charged_nanousd': 1234, 'prompt_tokens': 10,
                        'completion_tokens': 12, 'cache_read_tokens': 0,
                        'cache_write_tokens': 0, 'lane': 'managed'}

    def test_exact_settlement_matches(self):
        accepted, missing, refused = validate([self.admission], [self.receipt])
        self.assertEqual(len(accepted), 1)
        self.assertEqual(missing, [])
        self.assertEqual(refused, [])

    def test_missing_success_or_ambiguous_server_failure_stays_outstanding(self):
        for status in (200, 502, None):
            self.admission['response']['status'] = status
            self.assertEqual(validate([self.admission], [])[1], ['qa-one'])

    def test_explicit_admission_refusal_needs_no_receipt(self):
        self.admission['response'].update(status=402, body={'error': {'code': 'cost_ceiling_exceeded'}})
        self.assertEqual(validate([self.admission], [])[2], ['qa-one'])

    def test_settled_output_budget_error_still_needs_receipt(self):
        self.admission['response'].update(status=422, body={'error': {'code': 'output_budget_exhausted'}})
        self.assertEqual(validate([self.admission], [])[1], ['qa-one'])

    def test_duplicate_receipts_fail(self):
        with self.assertRaises(ValueError):
            validate([self.admission], [self.receipt, self.receipt])

    def test_invalid_or_unmatched_accounting_fails(self):
        mutations = [{'net_charged_nanousd': 50_000_001}, {'net_charged_nanousd': 1235},
                     {'completion_tokens': 129}, {'prompt_tokens': True},
                     {'lane': 'byok'}, {'model': 'different-model'}]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate([self.admission], [{**self.receipt, **mutation}])

    def test_charged_admission_refusal_fails(self):
        self.admission['response']['status'] = 404
        with self.assertRaises(ValueError):
            validate([self.admission], [self.receipt])

    def test_embedding_zero_output_is_valid_but_generated_tokens_are_not(self):
        self.admission['path'] = '/v1/embeddings'
        self.admission['body'] = {'input': 'hello'}
        self.receipt['completion_tokens'] = 0
        self.assertEqual(len(validate([self.admission], [self.receipt])[0]), 1)
        self.receipt['completion_tokens'] = 1
        with self.assertRaises(ValueError):
            validate([self.admission], [self.receipt])

    def test_embedding_ledger_requires_settled_debits_and_actual_refunds(self):
        admission = {**self.admission, 'path': '/v1/embeddings', 'cost_nanousd': 40}
        settlement = {'request_id': 'qa-one', 'net_charged_nanousd': 40,
            'debits': [{'request_id': 'qa-one', 'debit_kind': 'source', 'debit_state': 'settled', 'actual': 100}],
            'credits': [{'idempotency_key': 'qa-one:embeddings-refund', 'amount': 80,
                         'spendable_delta': 60, 'granted': 60, 'debt_delta': 0, 'kind': 'grant'}]}
        proof = {'passed': True, 'source': 'postgres_read_only_snapshot', 'state_sha256': 'sha',
                 'phase': 'typescript', 'settlements': [settlement]}
        self.assertEqual(live_qa_reconcile.validate_embedding_ledger(proof, [admission], 'sha', 'typescript'), [settlement])
        for change in ('state', 'reserved', 'refund', 'net', 'duplicate'):
            bad = deepcopy(proof)
            if change == 'state': bad['state_sha256'] = 'stale'
            if change == 'reserved': bad['settlements'][0]['debits'][0]['debit_state'] = 'reserved'
            if change == 'refund': bad['settlements'][0]['credits'][0]['spendable_delta'] = 80
            if change == 'net': bad['settlements'][0]['net_charged_nanousd'] = 41
            if change == 'duplicate': bad['settlements'].append(deepcopy(settlement))
            with self.subTest(change=change), self.assertRaises(AssertionError):
                live_qa_reconcile.validate_embedding_ledger(bad, [admission], 'sha', 'typescript')

    def test_authoritative_reconciler_unlocks_python_after_typescript_finish(self):
        with tempfile.TemporaryDirectory() as folder:
            run_dir = Path(folder) / 'live'
            guard = Guard(run_dir)
            guard.operation('claim', {'phase': 'typescript'})
            guard.operation('ready', {'phase': 'typescript'})
            row = guard.operation('admit', {'phase': 'typescript', 'method': 'POST',
                'url': 'https://api.conifer.build/v1/chat/completions',
                'headers': {'x-conifer-max-cost-nanousd': '50000000'},
                'body': {'model': 'gpt-4.1-nano', 'max_tokens': 128}})
            guard.operation('observe', {'index': row['index'], 'status': 200,
                'headers': {'x-conifer-request-id': row['request_id'],
                            'x-conifer-effective-model': 'gpt-4.1-nano',
                            'x-conifer-cost-nanousd': '1234'},
                'body': {'usage': {'prompt_tokens': 10, 'completion_tokens': 12, 'cost_nanousd': 1234}}})
            guard.operation('finish', {'phase': 'typescript', 'failed_checks': 0})
            receipt = {**self.receipt, 'request_id': row['request_id']}
            response = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {'rows': [receipt]})
            with patch.dict('os.environ', {'CONIFER_QA_ADMIN_SECRET': 'fixture-only'}), \
                 patch('sys.argv', ['reconcile', '--phase', 'typescript', '--run-dir', str(run_dir)]), \
                 patch.object(live_qa_reconcile.requests, 'get', return_value=response) as get, \
                 contextlib.redirect_stdout(io.StringIO()):
                live_qa_reconcile.main()
            self.assertEqual(get.call_count, 1)
            proof = json.loads((Path(folder) / 'reconciliation-typescript.json').read_text())
            self.assertTrue(proof['passed'])
            self.assertEqual(proof['outstanding_ids'], [])
            guard.operation('claim', {'phase': 'python'})


if __name__ == '__main__':
    unittest.main()
