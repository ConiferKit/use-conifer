import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGuardedFetch, emptyOutcome, journal } from './live-qa-transport.mjs';

test('header-only transport receipt reaches the installed SDK and enriches answer usage', async () => {
  const entry = process.env.CONIFER_QA_NODE_PACKAGE
    ? pathToFileURL(process.env.CONIFER_QA_NODE_PACKAGE) : new URL('../dist/src/index.js', import.meta.url);
  const { Conifer } = await import(entry.href);
  const root = mkdtempSync(join(tmpdir(), 'conifer-header-cost-'));
  const old = process.env.CONIFER_QA_RUN_DIR;
  process.env.CONIFER_QA_RUN_DIR = root;
  try {
    journal('claim'); journal('ready');
    let calls = 0;
    const fetch = createGuardedFetch({ async dispatch(url, init) {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pinecone' } }],
        usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 } }), {
        headers: { 'content-type': 'application/json', 'x-conifer-request-id': init.headers.get('idempotency-key'),
          'x-conifer-effective-model': 'gpt-4.1-nano', 'x-conifer-cost-nanousd': '4200' },
      });
    } });
    const client = new Conifer({ apiKey: 'fixture-only', maxRetries: 0, fetch });
    const answer = await client.chat({ model: 'gpt-4.1-nano', maxTokens: 128,
      messages: [{ role: 'user', content: 'reply with exactly: pinecone' }] });
    assert.equal(calls, 1);
    assert.equal(answer.usage.cost_nanousd, 4200);
    assert.equal(answer.usage.cost, 0.0000042);
    assert.equal(answer.receipt.costNanoUsd, 4200);
    assert.equal(answer.choices[0].message.content, 'pinecone');
    const state = JSON.parse(readFileSync(join(root, 'state.json')));
    assert.equal(state.admissions[0].cost_nanousd, 4200);
    assert.equal(state.halt, null);
  } finally {
    if (old === undefined) delete process.env.CONIFER_QA_RUN_DIR;
    else process.env.CONIFER_QA_RUN_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test('resumed transport aborts an in-flight request at the remaining phase deadline', async () => {
  const fetch = createGuardedFetch({ remainingPhaseMs: 20,
    record() { return { index: 0, request_id: 'id' }; },
    async dispatch(url, { signal }) {
      await new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => reject(new Error('phase timeout was not preserved')), 200);
        signal.addEventListener('abort', () => { clearTimeout(watchdog); reject(signal.reason); }, { once: true });
      });
    },
  });
  await assert.rejects(fetch('https://api.conifer.build/healthz'), { name: 'TimeoutError' });
});

test('refused admission cannot dispatch', async () => {
  let dispatched = 0;
  const fetch = createGuardedFetch({ record() { throw new Error('denied'); }, dispatch() { dispatched++; } });
  await assert.rejects(fetch('https://api.conifer.build/healthz'), /denied/);
  assert.equal(dispatched, 0);
});

test('actual transport uses admitted identity and cap without consuming caller body', async () => {
  const events = []; let sent;
  const fetch = createGuardedFetch({ record(action, payload) {
    events.push({ action, payload }); return { index: 7, request_id: 'admitted-id' };
  }, async dispatch(url, init) {
    sent = init;
    return new Response(JSON.stringify({ usage: { cost_nanousd: 100 } }), { status: 200 });
  } });
  const response = await fetch('https://api.conifer.build/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'SECRET-FIXTURE' }, body: JSON.stringify({ model: 'auto', max_tokens: 2048 }),
  });
  assert.equal(sent.headers.get('idempotency-key'), 'admitted-id');
  assert.equal(sent.headers.get('x-conifer-max-cost-nanousd'), '350000000');
  assert.equal(sent.headers.get('authorization'), 'SECRET-FIXTURE');
  assert.equal(sent.redirect, 'error');
  assert.equal(JSON.stringify(events).includes('SECRET-FIXTURE'), false);
  assert.deepEqual(await response.json(), { usage: { cost_nanousd: 100 } });
  assert.deepEqual(events.map(x => x.action), ['admit', 'observe']);
});

test('transport failure records ambiguous outcome once', async () => {
  const events = [];
  const fetch = createGuardedFetch({ record(action) { events.push(action); return { index: 0, request_id: 'id' }; },
    async dispatch() { throw new Error('connection lost'); } });
  await assert.rejects(fetch('https://api.conifer.build/healthz'), /connection lost/);
  assert.deepEqual(events, ['admit', 'fault']);
});

test('client refusal guard resets after refusal', async () => {
  let dispatched = 0;
  const fetch = createGuardedFetch({ record(action, payload) {
    if (payload.no_egress) throw new Error('no egress');
    return { index: 0, request_id: 'id' };
  }, async dispatch() { dispatched++; return new Response('{}'); } });
  await assert.rejects(fetch.withoutEgress(() => fetch('https://api.conifer.build/healthz')), /no egress/);
  assert.equal(dispatched, 0);
  await fetch('https://api.conifer.build/healthz');
  assert.equal(dispatched, 1);
});

test('only the exact nonretryable settled exhaustion shape is accepted', () => {
  const valid = Object.assign(new Error('exhausted'), { status: 422, type: 'output_budget_exhausted',
    code: 'output_budget_exhausted', param: 'max_tokens', retryable: false, requestId: 'id', body: { usage: { completion_tokens: 16 } } });
  assert.match(emptyOutcome(valid), /typed/);
  for (const change of [{ status: 200 }, { code: 'other' }, { retryable: true }, { requestId: '' }, { body: {} }]) {
    assert.throws(() => emptyOutcome(Object.assign(new Error('bad'), valid, change)));
  }
});
