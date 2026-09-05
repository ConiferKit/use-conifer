"""Wrap the real urllib boundary, including SDK streaming, for bounded QA."""
from __future__ import annotations
import io
import json
import math
import urllib.error
import urllib.request
from live_qa_guard import BASE_URL, BUILD, Guard, GuardError

PINS = {'chat': 'gpt-4.1-nano', 'spare': 'gpt-4.1-mini', 'native': 'claude-haiku-4-5', 'embed': 'text-embedding-3-small'}


def assert_model(model, cap, capability, provider=None):
    if not model or model.endpoint_kind != 'conifer' or model.unavailable is True or (capability and capability not in (model.caps or [])) or (provider and model.provider != provider):
        raise AssertionError('fixed model absent, unavailable or incompatible with wire')
    for field in ('in_usd_per_mtok', 'out_usd_per_mtok'):
        price = (model.pricing or {}).get(field)
        if not isinstance(price, str) or not math.isfinite(float(price)) or float(price) < 0:
            raise AssertionError('unpriced model')
    if cap is not None and (model.output_token_limit_supported is False or (model.min_output_tokens or 0) > cap or (model.max_output_tokens or cap) < cap):
        raise AssertionError(f'{model.id} cannot honor {cap} output tokens')
    return model


def empty_outcome(error):
    if (getattr(error, 'status', None) != 422 or error.type != 'output_budget_exhausted' or
        error.code != 'output_budget_exhausted' or error.param != 'max_tokens' or error.retryable is not False or
        not error.request_id or not isinstance(error.body, dict) or not error.body.get('usage')):
        raise error
    return 'typed output_budget_exhausted with preserved usage; transport verified settled receipt'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BufferedResponse(io.BytesIO):
    def __init__(self, data, status, headers):
        super().__init__(data); self.status = status; self.headers = headers


class GuardedHTTP:
    def __init__(self, guard=None, opener_factory=urllib.request.build_opener):
        self.guard = guard or Guard(); self.no_egress = False; self.last_stream = None
        self.opener_factory = opener_factory

    def record(self, action, **payload):
        return self.guard.operation(action, {'phase': 'python', **payload})

    def urlopen(self, request, timeout=90, context=None, **kwargs):
        if not isinstance(request, urllib.request.Request):
            request = urllib.request.Request(request)
        url = request.full_url; method = request.get_method()
        body = json.loads(request.data) if request.data else None
        headers = {k.lower(): v for k, v in request.header_items()}
        if method == 'POST' and not url.endswith('/v1/route'):
            headers.setdefault('x-conifer-max-cost-nanousd', '50000000')
            headers['x-conifer-cache'] = 'off'
        admission = self.record('admit', url=url, method=method, body=body, no_egress=self.no_egress,
                                case_name=getattr(self, 'case_name', None),
                                headers={k: v for k, v in headers.items() if k != 'authorization'})
        headers['idempotency-key'] = admission['request_id']
        request = urllib.request.Request(url, data=request.data, headers=headers, method=method)
        opener = self.opener_factory(urllib.request.HTTPSHandler(context=context), NoRedirect())
        error_response = None
        try:
            try:
                response = opener.open(request, timeout=min(timeout, 90))
            except urllib.error.HTTPError as error:
                response = error; error_response = error
            response_headers = dict(response.headers.items())
            stream = 200 <= response.status < 300 and 'text/event-stream' in response.headers.get('content-type', '')
            data = None if stream else response.read()
            parsed = None
            if data is not None:
                try: parsed = json.loads(data)
                except (ValueError, UnicodeError): parsed = {'non_json_body': data[:1000].decode(errors='replace')}
            self.record('observe', index=admission['index'], status=response.status,
                        headers=response_headers, body=parsed, stream=stream)
            if stream:
                self.last_stream = admission['index']
                return response
            response.close()
            if error_response is not None:
                # Preserve the real HTTPError shape and its readable body for SDK error_from.
                error_response.fp = io.BytesIO(data)
                error_response.file = error_response.fp
                error_response.read = error_response.fp.read
                raise error_response
            return BufferedResponse(data, response.status, response.headers)
        except urllib.error.HTTPError:
            raise
        except Exception as error:
            self.record('fault', index=admission['index'], message=str(error))
            raise

    def without_egress(self, run):
        self.no_egress = True
        try: return run()
        finally: self.no_egress = False

    def stream_done(self, usage):
        return self.record('stream', index=self.last_stream, usage=usage)
