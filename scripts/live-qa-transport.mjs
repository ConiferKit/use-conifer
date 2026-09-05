import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./live_qa_guard.py', import.meta.url));
export const BASE_URL = 'https://api.conifer.build';
export const BUILD = 'e3fd202';
export const PINS = { chat: 'gpt-4.1-nano', spare: 'gpt-4.1-mini', native: 'claude-haiku-4-5', embed: 'text-embedding-3-small' };

export function journal(action, payload = {}) {
  const result = spawnSync(process.env.CONIFER_QA_PYTHON || 'python3', [helper], {
    input: JSON.stringify({ action, payload: { phase: 'typescript', ...payload } }), encoding: 'utf8',
  });
  if (result.error) throw result.error;
  const reply = JSON.parse(result.stdout || '{}');
  if (result.status !== 0) throw new Error(reply.guard_error || result.stderr || 'QA guard failed');
  return reply;
}

export function assertModel(model, cap, capability, provider) {
  if (!model || model.endpointKind !== 'conifer' || model.unavailable === true ||
      (capability && !model.caps?.includes(capability)) || (provider && model.provider !== provider)) {
    throw new Error('fixed model is absent, unavailable or incompatible with this wire');
  }
  for (const field of ['in_usd_per_mtok', 'out_usd_per_mtok']) {
    const price = model.pricing?.[field];
    if (typeof price !== 'string' || !/^\d+(?:\.\d+)?$/.test(price)) throw new Error('unpriced model');
  }
  if (cap !== undefined && (model.outputTokenLimitSupported === false ||
      (model.minOutputTokens ?? 0) > cap || (model.maxOutputTokens ?? cap) < cap)) {
    throw new Error(`${model.id} cannot honor ${cap} output tokens`);
  }
  return model;
}

export function emptyOutcome(error) {
  if (error?.status !== 422 || error?.type !== 'output_budget_exhausted' ||
      error?.code !== 'output_budget_exhausted' || error?.param !== 'max_tokens' || error?.retryable !== false ||
      !error.requestId || !error.body?.usage) throw error;
  return 'typed output_budget_exhausted with preserved usage; transport verified settled receipt';
}

export function createGuardedFetch({ dispatch = globalThis.fetch, record = journal, remainingPhaseMs = 900_000 } = {}) {
  let noEgress = false;
  let lastStream;
  if (!Number.isSafeInteger(remainingPhaseMs) || remainingPhaseMs <= 0 || remainingPhaseMs > 900_000) {
    throw new Error('invalid remaining phase timeout');
  }
  const deadline = AbortSignal.timeout(remainingPhaseMs);
  const guarded = async (input, init = {}) => {
    const url = String(input); const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (method === 'POST' && !url.endsWith('/v1/route')) {
      if (!headers.has('x-conifer-max-cost-nanousd')) {
        headers.set('x-conifer-max-cost-nanousd', String(body?.model === 'auto' ? 350_000_000 : 50_000_000));
      }
      headers.set('x-conifer-cache', 'off');
    }
    const admission = record('admit', { url, method, body, no_egress: noEgress, case_name: guarded.caseName,
      headers: Object.fromEntries([...headers].filter(([key]) => key !== 'authorization')) });
    headers.set('idempotency-key', admission.request_id);
    const timeout = AbortSignal.timeout(url.endsWith('/v1/route') ? 15_000 : 90_000);
    const signals = [deadline, timeout, ...(init.signal ? [init.signal] : [])];
    try {
      const response = await dispatch(url, { ...init, method, headers, redirect: 'error', signal: AbortSignal.any(signals) });
      const stream = response.ok && response.headers.get('content-type')?.includes('text/event-stream');
      let parsed;
      if (!stream) {
        const text = await response.clone().text();
        try { parsed = JSON.parse(text); } catch { parsed = { non_json_body: text.slice(0, 1000) }; }
      }
      record('observe', { index: admission.index, status: response.status, headers: Object.fromEntries(response.headers), body: parsed, stream: !!stream });
      if (stream) lastStream = admission.index;
      return response;
    } catch (error) {
      record('fault', { index: admission.index, message: String(error.message || error) });
      throw error;
    }
  };
  guarded.withoutEgress = async (run) => {
    noEgress = true;
    try { return await run(); } finally { noEgress = false; }
  };
  guarded.streamDone = (usage) => record('stream', { index: lastStream, usage });
  return guarded;
}
