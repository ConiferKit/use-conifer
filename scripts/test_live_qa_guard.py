import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from live_qa_guard import Guard, GuardError, LIMIT
from live_qa_transport import GuardedHTTP, empty_outcome


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'live'
        self.guard = Guard(self.root, clock=lambda: 1000)
        self.guard.operation('claim', {'phase': 'typescript'})
        self.guard.operation('ready', {'phase': 'typescript'})

    def state(self):
        return json.loads((self.root / 'state.json').read_text())

    def admit(self, **changes):
        data = dict(phase='typescript', method='POST', url='https://api.conifer.build/v1/chat/completions',
                    headers={'x-conifer-max-cost-nanousd': '50000000'},
                    body={'model': 'gpt-4.1-nano', 'max_tokens': 128})
        data.update(changes)
        return self.guard.operation('admit', data)

    def observe(self, row, *, stream=False, cost='100', usage=None, status=200):
        return self.guard.operation('observe', dict(index=row['index'], status=status, stream=stream,
            headers={'x-conifer-request-id': row['request_id'], 'x-conifer-effective-model': 'gpt-4.1-nano',
                     'x-conifer-cost-nanousd': cost},
            body={'usage': usage or {'prompt_tokens': 2, 'completion_tokens': 1, 'total_tokens': 3, 'cost_nanousd': int(cost)}}))

    def test_invalid_admission_never_reserves(self):
        cases = [dict(headers={}), dict(no_egress=True), dict(url='https://other.invalid/v1/chat/completions'),
                 dict(body={'model': 'gpt-4.1-nano', 'max_tokens': 129}),
                 dict(body={'model': 'gpt-4.1-nano', 'max_tokens': 128, 'defer': True}),
                 dict(headers={'x-conifer-max-cost-nanousd': '50000001'})]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(GuardError): self.admit(**case)
        self.assertEqual(self.state()['admissions'], [])
        self.assertEqual(self.state()['reserved_nanousd'], 0)

    def test_duplicate_identity_and_claim_rejected(self):
        headers = {'idempotency-key': 'fixed', 'x-conifer-max-cost-nanousd': '50000000'}
        self.admit(headers=headers)
        with self.assertRaisesRegex(GuardError, 'duplicate'): self.admit(headers=headers)
        with self.assertRaisesRegex(GuardError, 'claimed'):
            self.guard.operation('claim', {'phase': 'typescript'})
        self.assertEqual(len(self.state()['admissions']), 1)

    def test_tail_requires_manual_recovery_and_permits_only_one_auto(self):
        with self.assertRaisesRegex(GuardError, 'manual admission recovery'):
            self.guard.operation('claim_tail', {'phase': 'typescript'})
        state = self.state()
        state['phases']['typescript'].update(tail_recovered=True, verified_checks=25,
            warmed_pick={'model': 'gpt-4.1-nano', 'fallbacks': []})
        self.guard._save(state)
        with self.assertRaisesRegex(GuardError, 'tail permits'): self.admit()
        phase = self.guard.operation('claim_tail', {'phase': 'typescript'})
        self.assertEqual(phase['prior_passed'], 25)
        self.assertEqual(phase['route_warmups_remaining'], 6)
        with self.assertRaises(GuardError): self.guard.operation('claim_tail', {'phase': 'typescript'})
        self.guard.operation('ready', {'phase': 'typescript'})
        with self.assertRaisesRegex(GuardError, 'tail permits'): self.admit()
        with self.assertRaisesRegex(GuardError, 'tail permits'):
            self.admit(url='https://api.conifer.build/v1/route', body={'policy': 'fast', 'max_output_tokens': 2048})
        self.admit(url='https://api.conifer.build/v1/route', body={'policy': 'balanced', 'max_output_tokens': 2048})
        auto = dict(body={'model': 'auto', 'max_tokens': 2048}, headers={'x-conifer-max-cost-nanousd': '350000000'})
        self.admit(**auto)
        with self.assertRaisesRegex(GuardError, 'exactly once'): self.admit(**auto)

    def test_phase_and_route_limits(self):
        for _ in range(20): self.admit()
        with self.assertRaisesRegex(GuardError, 'phase POST'): self.admit()
        for _ in range(6): self.admit(url='https://api.conifer.build/v1/route', body={'policy': 'balanced', 'max_output_tokens': 2048})
        with self.assertRaisesRegex(GuardError, 'policy allowance'):
            self.admit(url='https://api.conifer.build/v1/route', body={'policy': 'balanced', 'max_output_tokens': 2048})
        self.admit(url='https://api.conifer.build/v1/route', body={'policy': 'fast', 'max_output_tokens': 2048})
        with self.assertRaisesRegex(GuardError, 'phase POST'):
            self.admit(url='https://api.conifer.build/v1/route', body={'policy': 'fast', 'max_output_tokens': 2048})

    def test_spend_reserve_and_one_auto(self):
        row = self.guard.operation('admit', {'phase': 'typescript', 'method': 'GET',
            'url': 'https://api.conifer.build/healthz', 'body': None})
        self.guard.operation('observe', {'index': row['index'], 'status': 200, 'body': {'status': 'ok'}})
        auto = dict(body={'model': 'auto', 'max_tokens': 2048}, headers={'x-conifer-max-cost-nanousd': '350000000'})
        self.admit(**auto)
        with self.assertRaisesRegex(GuardError, 'exactly once'): self.admit(**auto)
        state = self.state(); state['reserved_nanousd'] = LIMIT - 1
        self.guard._save(state)
        with self.assertRaisesRegex(GuardError, 'spend reserve'): self.admit()

    def test_failed_commit_blocks_all_future_dispatch(self):
        with patch.object(self.guard, '_save', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.admit()
        self.assertTrue((self.root / 'transaction.pending').exists())
        with self.assertRaisesRegex(GuardError, 'unfinished journal'): self.admit()

    def test_python_requires_exact_reconciliation(self):
        self.guard.operation('finish', {'phase': 'typescript', 'failed_checks': 0})
        proof = self.root.parent / 'reconciliation-typescript.json'
        proof.write_text(json.dumps({'passed': True, 'outstanding_ids': [], 'state_sha256': 'stale'}))
        with self.assertRaisesRegex(GuardError, 'does not match'):
            self.guard.operation('claim', {'phase': 'python'})
        sha = hashlib.sha256((self.root / 'state.json').read_bytes()).hexdigest()
        proof.write_text(json.dumps({'passed': True, 'outstanding_ids': [], 'state_sha256': sha}))
        self.guard.operation('claim', {'phase': 'python'})
        self.assertIn('python', self.state()['phases'])

    def test_repair_resume_requires_receipt_and_keeps_prior_limits(self):
        row = self.admit()
        self.guard.clock = lambda: 1100
        self.observe(row, usage={'prompt_tokens': 2, 'completion_tokens': 1})
        # Reproduce the preserved halt from the old guard, which incorrectly
        # required body costs before the SDK had enriched usage from headers.
        state = self.state(); state['halt'] = 'body/header settled cost mismatch'
        self.guard._save(state)
        with self.assertRaisesRegex(GuardError, 'authoritative reconciliation'):
            self.guard.operation('resume', {'phase': 'typescript'})
        proof = {'passed': True, 'outstanding_ids': [],
                 'state_sha256': hashlib.sha256((self.root / 'state.json').read_bytes()).hexdigest(),
                 'settled_receipts': [{'request_id': row['request_id'], 'net_charged_nanousd': 100}]}
        (self.root.parent / 'reconciliation-typescript.json').write_text(json.dumps(proof))
        self.guard.clock = lambda: 5000  # repair downtime has no dispatch
        resumed = self.guard.operation('resume', {'phase': 'typescript'})
        self.assertEqual(self.state()['started'], 1000)
        self.assertEqual(self.state()['paused_seconds'], 3900)
        self.assertEqual(self.state()['phases']['typescript']['started'], 4900)
        self.assertEqual(resumed['remaining_phase_ms'], 800_000)
        self.assertEqual(self.state()['reserved_nanousd'], 50_000_000)
        self.assertEqual(len(self.state()['admissions']), 1)
        with self.assertRaisesRegex(GuardError, 'preflight'): self.admit()
        self.guard.operation('ready', {'phase': 'typescript'})
        for _ in range(19): self.admit()
        with self.assertRaisesRegex(GuardError, 'phase POST'): self.admit()
        with self.assertRaisesRegex(GuardError, 'recovery envelope'):
            self.guard.operation('resume', {'phase': 'typescript'})
        self.guard.clock = lambda: 5801
        with self.assertRaisesRegex(GuardError, 'deadline'):
            self.guard.operation('ready', {'phase': 'typescript'})

    def test_header_only_cost_is_valid_transport_input_for_sdk_enrichment(self):
        row = self.admit()
        self.observe(row, usage={'prompt_tokens': 2, 'completion_tokens': 1})
        self.assertEqual(self.state()['admissions'][0]['cost_nanousd'], 100)
        self.assertIsNone(self.state()['halt'])

    def test_supplied_body_cost_must_match_settled_header(self):
        for field, value in [('cost_nanousd', 101), ('cost_nanousd', True), ('cost', 1), ('cost', None)]:
            with self.subTest(field=field, value=value):
                usage = {'prompt_tokens': 2, 'completion_tokens': 1, field: value}
                row = self.admit()
                with self.assertRaises(GuardError): self.observe(row, usage=usage)
                state = self.state(); state['halt'] = None; self.guard._save(state)

    def test_stream_without_terminal_usage_halts(self):
        row = self.admit(); self.observe(row, stream=True)
        with self.assertRaisesRegex(GuardError, 'terminal usage'):
            self.guard.operation('finish', {'phase': 'typescript'})
        with self.assertRaisesRegex(GuardError, 'halted'): self.admit()

    def test_bad_usage_halts(self):
        row = self.admit()
        with self.assertRaises(GuardError):
            self.observe(row, usage={'prompt_tokens': 1, 'completion_tokens': True, 'cost_nanousd': 100})
        with self.assertRaises(GuardError): self.admit()

    def test_over_ceiling_response_halts(self):
        row = self.admit()
        with self.assertRaisesRegex(GuardError, 'cost/model'): self.observe(row, cost='50000001')
        with self.assertRaises(GuardError): self.admit()

    def test_auth_is_not_persisted_and_id_namespaces_differ(self):
        row = self.admit(headers={'authorization': 'SECRET-FIXTURE', 'x-conifer-max-cost-nanousd': '50000000'})
        self.assertNotIn('SECRET-FIXTURE', (self.root / 'state.json').read_text() + (self.root / 'events.jsonl').read_text())
        other = Guard(Path(self.tmp.name) / 'other', clock=lambda: 1000)
        other.operation('claim', {'phase': 'typescript'})
        read = other.operation('admit', {'phase': 'typescript', 'url': 'https://api.conifer.build/healthz', 'method': 'GET'})
        self.assertNotEqual(row['request_id'].split('-typescript')[0], read['request_id'].split('-typescript')[0])

    def test_deadline_blocks_admission(self):
        self.guard.clock = lambda: 1901
        with self.assertRaisesRegex(GuardError, 'deadline'): self.admit()

    def test_concurrent_claims_only_one_wins(self):
        env = {**os.environ, 'CONIFER_QA_RUN_DIR': str(Path(self.tmp.name) / 'concurrent')}
        command = [sys.executable, str(Path(__file__).with_name('live_qa_guard.py'))]
        request = json.dumps({'action': 'claim', 'payload': {'phase': 'typescript'}})
        children = [subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        for child in children:
            child.stdin.write(request); child.stdin.close(); child.stdin = None
        for child in children: child.communicate(timeout=10)
        self.assertEqual(sorted(child.returncode for child in children), [0, 1])


class TransportTests(unittest.TestCase):
    def test_missing_execution_flag_fails_without_network_or_claim(self):
        sdk = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as folder:
            env = {key: value for key, value in os.environ.items() if not key.startswith('CONIFER_')}
            env['CONIFER_QA_RUN_DIR'] = folder + '/never-created'
            for command in [['node', str(sdk / 'scripts/live-qa.mjs')], [sys.executable, str(sdk / 'python/scripts/live_qa.py')]]:
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(Path(env['CONIFER_QA_RUN_DIR']).exists())

    def test_failed_admission_never_constructs_opener(self):
        class Reject:
            def operation(self, *args): raise GuardError('denied')
        with patch('urllib.request.build_opener') as opener:
            http = GuardedHTTP(guard=Reject(), opener_factory=opener)
            with self.assertRaisesRegex(GuardError, 'denied'): http.urlopen('https://api.conifer.build/healthz')
            opener.assert_not_called()

    def test_http_error_preserves_body_and_dispatch_uses_admitted_identity(self):
        events = []; sent = []; factories = []
        raw = b'{"error":{"code":"output_budget_exhausted"},"usage":{"completion_tokens":16}}'
        class Record:
            def operation(self, action, payload):
                events.append((action, payload))
                return {'index': 0, 'request_id': 'admitted-id'}
        class Opener:
            def open(self, request, timeout):
                sent.append(request)
                raise urllib.error.HTTPError(request.full_url, 422, 'exhausted', {'content-type': 'application/json'}, io.BytesIO(raw))
        def factory(*handlers):
            factories.extend(handlers)
            return Opener()
        http = GuardedHTTP(guard=Record(), opener_factory=factory)
        req = urllib.request.Request('https://api.conifer.build/v1/chat/completions', data=b'{"model":"gpt-4.1-nano","max_tokens":128}', headers={'Authorization': 'SECRET-FIXTURE'})
        with self.assertRaises(urllib.error.HTTPError) as caught: http.urlopen(req)
        self.assertEqual(caught.exception.read(), raw)
        self.assertEqual([action for action, _ in events], ['admit', 'observe'])
        self.assertNotIn('SECRET-FIXTURE', json.dumps(events))
        actual = dict((k.lower(), v) for k, v in sent[0].header_items())
        self.assertEqual(actual['idempotency-key'], 'admitted-id')
        self.assertEqual(actual['x-conifer-max-cost-nanousd'], '50000000')
        self.assertEqual(actual['authorization'], 'SECRET-FIXTURE')
        self.assertTrue(any(type(handler).__name__ == 'NoRedirect' for handler in factories))

    def test_typed_empty_outcome_only(self):
        class Failure(Exception): pass
        error = Failure('exhausted')
        for key, value in dict(status=422, type='output_budget_exhausted', code='output_budget_exhausted', param='max_tokens', retryable=False, request_id='id', body={'usage': {'completion_tokens': 16}}).items():
            setattr(error, key, value)
        self.assertIn('typed', empty_outcome(error))
        error.retryable = True
        with self.assertRaises(Failure): empty_outcome(error)


if __name__ == '__main__': unittest.main()
