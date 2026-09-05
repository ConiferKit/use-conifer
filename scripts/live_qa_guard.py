"""Local admission journal for the deliberately bounded SDK release QA.

No network or credential lookup lives here. Both language harnesses use this
same flock-protected state before their real transport touches the network.
"""
from __future__ import annotations

import fcntl
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
from urllib.parse import urlsplit

RUN_DIR = Path(os.environ.get('CONIFER_QA_RUN_DIR', '/private/tmp/conifer-sdk-unblock-20260905/live'))
BUILD = 'e3fd202f1cdc2372e70d7a0ea879905adcba775b'
BASE_URL = 'https://api.conifer.build'
PLAN = 'sdk021-40post-1850000002-v1'
LIMIT = 1_850_000_002
PHASE_LIMITS = {'typescript': (20, 7), 'python': (13, 0)}
SAFE_HEADERS = {'idempotency-key', 'x-request-id', 'x-conifer-max-cost-nanousd',
                'x-conifer-fallback-models', 'x-conifer-cache', 'anthropic-version'}


class GuardError(RuntimeError):
    pass


def integer(value):
    if type(value) is not int or not 0 <= value <= (1 << 53) - 1:
        raise GuardError('counter must be an explicit nonnegative safe integer')
    return value


def supplied_counts(usage):
    if not isinstance(usage, dict):
        raise GuardError('usage/details must be objects')
    for key, value in usage.items():
        if key.endswith('_tokens'):
            integer(value)
        elif key.endswith('_details') or key == 'cache_creation':
            supplied_counts(value)


def output_count(usage, path):
    supplied_counts(usage)
    if path in ('/v1/messages', '/v1/responses'):
        integer(usage.get('input_tokens'))
        return integer(usage.get('output_tokens'))
    prompt = integer(usage.get('prompt_tokens'))
    if path == '/v1/embeddings':
        integer(usage.get('total_tokens'))
        return 0
    completion = integer(usage.get('completion_tokens'))
    reasoning = usage.get('completion_tokens_details', {}).get('reasoning_tokens', 0)
    floor = completion + reasoning if reasoning > completion else completion
    return max(floor, max(0, usage.get('total_tokens', prompt) - prompt))


class Guard:
    def __init__(self, root=RUN_DIR, *, clock=time.time):
        self.root = Path(root)
        self.clock = clock

    def operation(self, action, payload):
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            pending = self.root / 'transaction.pending'
            if pending.exists():
                raise GuardError('unfinished journal transaction; manual reconciliation required, no new dispatch')
            state_path = self.root / 'state.json'
            if state_path.exists():
                state = json.loads(state_path.read_text())
                if state.get('plan') != PLAN:
                    raise GuardError('run plan changed')
            else:
                if list(self.root.glob('*.claim')) or (self.root / 'events.jsonl').exists():
                    raise GuardError('journal missing beside prior execution evidence')
                state = {'plan': PLAN, 'run_nonce': uuid.uuid4().hex, 'started': self.clock(), 'phases': {},
                         'admissions': [], 'reserved_nanousd': 0, 'halt': None}
            with pending.open('x') as marker:
                marker.write(action + '\n'); marker.flush(); os.fsync(marker.fileno())
            self._sync_directory()
            try:
                result = getattr(self, '_' + action)(state, payload)
            except GuardError as error:
                if action in ('observe', 'stream', 'fault', 'finish'):
                    state['halt'] = str(error)
                self._save(state)
                pending.unlink(); self._sync_directory()
                raise
            self._save(state)
            pending.unlink(); self._sync_directory()
            return result

    def _sync_directory(self):
        descriptor = os.open(self.root, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)

    def _save(self, state):
        path = self.root / 'state.next'
        with path.open('w') as target:
            json.dump(state, target, sort_keys=True, allow_nan=False)
            target.write('\n'); target.flush(); os.fsync(target.fileno())
        os.replace(path, self.root / 'state.json')
        self._sync_directory()

    def _event(self, event):
        with (self.root / 'events.jsonl').open('a') as target:
            target.write(json.dumps({'time': self.clock(), **event}, allow_nan=False) + '\n')
            target.flush(); os.fsync(target.fileno())

    def _claim(self, state, data):
        phase = data['phase']
        if phase not in PHASE_LIMITS or state['halt']:
            raise GuardError('unknown phase or halted run')
        if phase in state['phases']:
            raise GuardError('phase already claimed; automatic reruns are forbidden')
        if phase == 'python':
            previous = state['phases'].get('typescript', {})
            proof = self.root.parent / 'reconciliation-typescript.json'
            if not previous.get('complete') or previous.get('failed_checks') != 0 or not proof.exists():
                raise GuardError('Python waits for successful TypeScript completion and root reconciliation')
            settled = json.loads(proof.read_text())
            prior_sha = hashlib.sha256((self.root / 'state.json').read_bytes()).hexdigest()
            if settled.get('passed') is not True or settled.get('outstanding_ids') != [] or settled.get('state_sha256') != prior_sha:
                raise GuardError('TypeScript reconciliation marker does not match admissions')
        try:
            with (self.root / (phase + '.claim')).open('x') as marker:
                marker.write(PLAN + '\n'); marker.flush(); os.fsync(marker.fileno())
        except FileExistsError as error:
            raise GuardError('phase already claimed') from error
        state['phases'][phase] = {'started': self.clock(), 'complete': False, 'ready': False}
        self._event({'kind': 'claim', 'phase': phase})
        return {'plan': PLAN, 'run_dir': str(self.root)}

    def _ready(self, state, data):
        self._phase(state, data['phase'])['ready'] = True
        return {'ready': True}

    def _claim_tail(self, state, data):
        record = self._phase(state, data['phase'])
        if (data['phase'] != 'typescript' or not record.get('tail_recovered') or
                record.get('tail_claimed') or record.get('verified_checks') != 25):
            raise GuardError('final check requires one verified manual admission recovery')
        record['tail_claimed'] = True
        record['ready'] = False
        self._event({'kind': 'claim_tail', 'preserved_checks': 25})
        return {'prior_passed': 25, 'warmed_pick': record['warmed_pick'],
                'route_warmups_remaining': 6 - sum(r['path'] == '/v1/route' and
                    (r.get('body') or {}).get('policy') == 'balanced' for r in state['admissions']),
                'remaining_phase_ms': int((900 - (self.clock() - record['started'])) * 1000)}

    def _resume(self, state, data):
        """One explicit repair continuation; retain every prior admission/reserve."""
        phase = data['phase']
        posts = [row for row in state['admissions'] if row['method'] == 'POST']
        record = state['phases'].get(phase, {})
        if (phase != 'typescript' or not state['halt'] or record.get('resumed') or
                record.get('complete') or len(posts) != 1 or
                any(not row['observed'] for row in state['admissions'])):
            raise GuardError('repair continuation is outside the one-settled-request recovery envelope')
        row = posts[0]
        response = row.get('response', {})
        if (row['path'] != '/v1/chat/completions' or response.get('status') != 200 or
                row.get('cost_nanousd') is None or
                response.get('body', {}).get('usage', {}).get('cost_nanousd') is not None):
            raise GuardError('repair continuation requires the observed header-only cost receipt')
        proof = self.root.parent / 'reconciliation-typescript.json'
        if not proof.exists():
            raise GuardError('repair continuation requires authoritative reconciliation')
        settled = json.loads(proof.read_text())
        prior_sha = hashlib.sha256((self.root / 'state.json').read_bytes()).hexdigest()
        receipts = settled.get('settled_receipts', [])
        if (settled.get('passed') is not True or settled.get('outstanding_ids') != [] or
                settled.get('state_sha256') != prior_sha or len(receipts) != 1 or
                receipts[0].get('request_id') != row['request_id'] or
                receipts[0].get('net_charged_nanousd') != row['cost_nanousd']):
            raise GuardError('repair reconciliation does not match the preserved dispatch')
        events = [json.loads(line) for line in (self.root / 'events.jsonl').read_text().splitlines()]
        failed_at = next(event['time'] for event in events
                         if event['kind'] == 'response' and event['index'] == row['index'])
        if (not 0 <= failed_at - state['started'] <= 1800 or
                not 0 <= failed_at - record['started'] < 900 or failed_at > self.clock()):
            raise GuardError('invalid active-execution timing')
        # Preserve the original start for receipt queries. Only this verified
        # zero-egress repair interval is excluded from the active QA deadline.
        state['paused_seconds'] = self.clock() - failed_at
        self._event({'kind': 'repair_resume', 'phase': phase, 'previous_halt': state['halt'],
                     'preserved_post_count': len(posts), 'preserved_reserved_nanousd': state['reserved_nanousd'],
                     'paused_seconds': state['paused_seconds']})
        state['halt'] = None
        record.update(started=record['started'] + state['paused_seconds'], ready=False, resumed=True)
        return {'resumed': True, 'reserved_nanousd': state['reserved_nanousd'],
                'remaining_phase_ms': int((900 - (self.clock() - record['started'])) * 1000)}

    def _phase(self, state, phase):
        record = state['phases'].get(phase)
        if not record or record['complete'] or state['halt']:
            raise GuardError('phase not claimed, already complete, or run halted')
        if self.clock() - record['started'] > 900 or self.clock() - state['started'] - state.get('paused_seconds', 0) > 1800:
            raise GuardError('QA deadline expired')
        return record

    def _admit(self, state, data):
        phase = data['phase']; record = self._phase(state, phase)
        if data.get('no_egress'):
            raise GuardError('this client-side refusal check must not dispatch')
        url = urlsplit(data['url'])
        if url.scheme != 'https' or url.netloc != 'api.conifer.build' or url.query or url.fragment:
            raise GuardError('unapproved destination')
        method = data['method'].upper(); path = url.path
        headers = {k.lower(): str(v) for k, v in data.get('headers', {}).items() if k.lower() in SAFE_HEADERS}
        body = data.get('body')
        if isinstance(body, str):
            body = json.loads(body)
        admissions = state['admissions']
        mine = [row for row in admissions if row['phase'] == phase]
        is_route = path == '/v1/route'
        cap = 0
        if method == 'GET':
            if path not in ('/healthz', '/v1/models', '/v1/balance') and not path.startswith('/v1/models/'):
                raise GuardError('unapproved GET path')
            if sum(row['method'] == 'GET' for row in mine) >= 32:
                raise GuardError('GET allowance exhausted')
        elif method == 'POST':
            if record.get('tail_recovered') and (not record.get('tail_claimed') or not isinstance(body, dict) or
                    not ((path == '/v1/chat/completions' and body.get('model') == 'auto') or
                         (path == '/v1/route' and body.get('policy') == 'balanced'))):
                raise GuardError('recovered TypeScript tail permits only auto and remaining bounded warmups')
            if path not in ('/v1/chat/completions', '/v1/embeddings', '/v1/responses', '/v1/messages', '/v1/route'):
                raise GuardError('unapproved POST path')
            if not isinstance(body, dict) or len(json.dumps(body).encode()) > 4096:
                raise GuardError('request body outside frozen small-fixture envelope')
            if body.get('defer'):
                raise GuardError('deferred jobs need a separate plan')
            if not is_route and not record['ready']:
                raise GuardError('catalog/build preflight has not passed')
            if sum(row['method'] == 'POST' for row in admissions) >= 40:
                raise GuardError('combined POST allowance exhausted')
            prior = [row for row in mine if row['method'] == 'POST' and (row['path'] == '/v1/route') == is_route]
            if len(prior) >= PHASE_LIMITS[phase][1 if is_route else 0]:
                raise GuardError('phase POST allowance exhausted')
            if is_route:
                if body.get('max_output_tokens') != 2048 or body.get('policy') not in ('balanced', 'fast'):
                    raise GuardError('route request outside plan')
                policy = body['policy']
                if sum(row.get('body', {}).get('policy') == policy for row in prior) >= (6 if policy == 'balanced' else 1):
                    raise GuardError('route policy allowance exhausted')
            else:
                raw_cap = headers.get('x-conifer-max-cost-nanousd', '')
                if not re.fullmatch(r'[1-9][0-9]*', raw_cap):
                    raise GuardError('missing or malformed pre-dispatch cost ceiling')
                cap = int(raw_cap); model = body.get('model')
                allowed = {'gpt-4.1-nano', 'no-such-model-xyz', 'auto'}
                if path == '/v1/embeddings':
                    allowed = {'text-embedding-3-small', 'gpt-4.1-nano'}
                if path == '/v1/messages':
                    allowed = {'claude-haiku-4-5'}
                if path == '/v1/responses':
                    allowed = {'gpt-4.1-nano'}
                if model not in allowed:
                    raise GuardError('model outside fixed phase pins')
                if model == 'auto':
                    if phase != 'typescript' or any((row.get('body') or {}).get('model') == 'auto' for row in admissions):
                        raise GuardError('auto may generate exactly once')
                    if cap != 350_000_000:
                        raise GuardError('auto ceiling differs from approved plan')
                elif cap > 50_000_000:
                    raise GuardError('inference ceiling exceeds approved plan')
                if path != '/v1/embeddings':
                    mt = body.get('max_output_tokens') if path == '/v1/responses' else body.get('max_tokens')
                    planned_mt = 2048 if model == 'auto' or path == '/v1/messages' else (
                        16 if data.get('case_name') == 'an empty completion explains itself rather than just being empty' else 128)
                    if integer(mt) != planned_mt:
                        raise GuardError('output budget outside plan')
                if state['reserved_nanousd'] + cap > LIMIT:
                    raise GuardError('combined spend reserve exhausted')
        else:
            raise GuardError('unapproved HTTP method')
        request_id = headers.get('idempotency-key') or headers.get('x-request-id') or f'sdk021-{state["run_nonce"]}-{phase}-{len(admissions):03d}'
        if any(row['request_id'] == request_id for row in admissions):
            raise GuardError('duplicate request identity; retries forbidden')
        row = {'phase': phase, 'index': len(admissions), 'method': method, 'path': path,
               'case_name': data.get('case_name'),
               'request_id': request_id, 'cap_nanousd': cap, 'body': body, 'headers': headers,
               'body_sha256': hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest(),
               'observed': False}
        admissions.append(row); state['reserved_nanousd'] += cap
        self._event({'kind': 'admit', **row})
        return {'index': row['index'], 'request_id': request_id}

    def _observe(self, state, data):
        row = state['admissions'][data['index']]
        if row['observed']:
            raise GuardError('duplicate response observation')
        row['observed'] = True
        status = data['status']; headers = {k.lower(): str(v) for k, v in data.get('headers', {}).items()}
        safe = {k: v for k, v in headers.items() if k.startswith('x-conifer-') or k in ('x-request-id', 'content-type')}
        observation = {'kind': 'response', 'index': row['index'], 'status': status, 'headers': safe,
                       'body': data.get('body'), 'stream': data.get('stream', False)}
        row['response'] = observation; self._event(observation)
        if status >= 500 or 300 <= status < 400:
            # route503 is the one planned bounded read-only retry.
            if row['path'] == '/v1/route' and status == 503:
                return {'route_waking': True}
            raise GuardError('server failure/redirect: accounting may be unresolved; halted')
        if not row['cap_nanousd']:
            return {'observed': True}
        if (headers.get('x-conifer-request-id') or headers.get('x-request-id')) != row['request_id']:
            raise GuardError('response request identity missing or mismatched')
        body = data.get('body') or {}
        error = body.get('error', {}) if isinstance(body, dict) else {}
        exhausted = error.get('code') == 'output_budget_exhausted'
        settled = 200 <= status < 300 or exhausted
        if data.get('stream'):
            if not 200 <= status < 300 or not headers.get('x-conifer-effective-model'):
                raise GuardError('stream head lacks success/effective model')
            return {'stream_needs_terminal_usage': True}
        if settled or 'x-conifer-cost-nanousd' in headers:
            raw_cost = headers.get('x-conifer-cost-nanousd', '')
            if not re.fullmatch(r'[0-9]+', raw_cost):
                raise GuardError('settled response lacks an explicit integer cost')
            cost = integer(int(raw_cost))
            if cost > row['cap_nanousd'] or not headers.get('x-conifer-effective-model'):
                raise GuardError('settled cost/model violates admission')
            row['cost_nanousd'] = cost
            usage = body.get('usage')
            output = output_count(usage, row['path'])
            row['normalized_output_tokens'] = output
            mt = (row['body'] or {}).get('max_tokens', (row['body'] or {}).get('max_output_tokens', 0))
            if output > mt:
                raise GuardError('normalized output exceeds requested budget')
            # The SDK enriches usage from the authoritative header after this
            # transport returns. Raw body cost is optional; supplied cost must agree.
            if 'cost_nanousd' in usage and integer(usage['cost_nanousd']) != cost:
                raise GuardError('body/header settled cost mismatch')
            if 'cost' in usage and (type(usage['cost']) not in (int, float) or
                    Decimal(str(usage['cost'])) != Decimal(cost) / 1_000_000_000):
                raise GuardError('body/header settled USD cost mismatch')
        return {'observed': True}

    def _stream(self, state, data):
        row = state['admissions'][data['index']]
        output = output_count(data['usage'], row['path'])
        if output > row['body']['max_tokens']:
            raise GuardError('stream normalized output exceeds requested budget')
        row['stream_terminal_usage'] = data['usage']
        row['normalized_output_tokens'] = output
        self._event({'kind': 'stream_terminal', **data})
        return {'terminal': True}

    def _fault(self, state, data):
        state['halt'] = data.get('message', 'transport outcome unknown')
        self._event({'kind': 'fault', **data})
        return {'halt': state['halt']}

    def _finish(self, state, data):
        phase = self._phase(state, data['phase'])
        if phase.get('tail_recovered'):
            autos = [r for r in state['admissions'] if (r.get('body') or {}).get('model') == 'auto']
            if len(autos) != 1 or data.get('passed_checks') != 26 or data.get('failed_checks') != 0:
                raise GuardError('recovered tail must complete the remaining auto check')
        for row in state['admissions']:
            if row['phase'] != data['phase']:
                continue
            if not row['observed']:
                raise GuardError('dispatch has no observed result')
            if row.get('response', {}).get('stream') and 'stream_terminal_usage' not in row:
                raise GuardError('stream lacks terminal usage')
        phase['complete'] = True; phase['failed_checks'] = data.get('failed_checks', 0)
        self._event({'kind': 'finish', **data})
        return {'reserved_nanousd': state['reserved_nanousd'], 'post_count': sum(row['method'] == 'POST' for row in state['admissions']),
                'note': 'Root must reconcile authoritative receipts before release, including streams.'}


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        print(json.dumps(Guard().operation(request['action'], request.get('payload', {}))))
    except Exception as error:
        print(json.dumps({'guard_error': str(error)}))
        raise SystemExit(1)
