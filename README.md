# The Conifer SDK

[![CI](https://github.com/ConiferKit/use-conifer/actions/workflows/ci.yml/badge.svg)](https://github.com/ConiferKit/use-conifer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

One client for the [Conifer](https://conifer.build) gateway, in TypeScript and
Python, plus an MCP server so tools that speak no OpenAI wire can still call it.

Conifer is one API key in front of every major model, on the OpenAI and
Anthropic wires. Credits are charged at the model's list price, and every call
returns its exact settled cost — down to the nanodollar, itemized. Bring your
own provider keys and Conifer proxies them for a small fee on list price.

**Docs:** [conifer.build/docs/sdk](https://conifer.build/docs/sdk/) ·
**Issues:** [file one](https://github.com/ConiferKit/use-conifer/issues) ·
**Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)

```bash
export CONIFER_API_KEY='sk-conifer-…'   # mint one at https://conifer.build/console#/keys
```

> **Not yet on a registry.** `@conifer/sdk` is not on npm and `conifer-sdk` is
> not on PyPI yet, so install from this repository:
>
> ```bash
> git clone https://github.com/ConiferKit/use-conifer
> npm i ./use-conifer                    # TypeScript
> pip install "./use-conifer/python[tls]"  # Python — see the note below
> ```
>
> **Python on macOS: use `[tls]`.** A python.org install whose
> *Install Certificates.command* was never run has an **empty CA trust store**,
> and so does every venv built on it — it cannot verify *any* HTTPS host, and
> your first call dies with `CERTIFICATE_VERIFY_FAILED`. The `[tls]` extra pulls
> in `certifi`, which the SDK uses automatically when it detects an empty store.
> It is an extra rather than a dependency because zero dependencies is a real
> feature here (this drops into a lambda or a locked-down build image with no
> package tree to audit), and because Linux, Homebrew, Docker and conda already
> have a working store. If you hit the error anyway, the SDK says exactly this,
> and names the remedy, rather than reporting "the gateway is unreachable".
>
> Everything else in this README is verified against the live gateway.

```ts
import { Conifer, textOf } from "@conifer/sdk";

const conifer = new Conifer();
const answer = await conifer.chat({
  model: "claude-haiku-4-5",
  messages: [{ role: "user", content: "three names for a build cache" }],
  maxTokens: 200,
  maxCostNanoUsd: 5_000_000,      // refuse this turn if it could cost over $0.005
});

console.log(textOf(answer));
console.log(answer.receipt.costUsd);            // "0.001250000" — this exact call
console.log(answer.receipt.costComponentsNanoUsd); // itemized across four token classes
```

```python
from conifer_sdk import Conifer, ChatRequest

conifer = Conifer()
answer = conifer.chat(ChatRequest(
    model="claude-haiku-4-5",
    messages=[{"role": "user", "content": "three names for a build cache"}],
    max_tokens=200,
    max_cost_nano_usd=5_000_000,
))
print(answer.text, answer.receipt.cost_usd)

# Streaming, with the same semantics as the TypeScript twin.
for chunk in conifer.stream(ChatRequest(model="claude-haiku-4-5", messages=[...])):
    ...
print(conifer.stream_receipt.effective_model)   # routing arrives with the head
```

On a **streamed** turn the cost headers are absent in both languages, and that
is the wire being honest rather than a gap: the response head is sent before the
first token and the money settles after the last. Reconcile a stream from its
terminal `usage` chunk, which the SDK always requests.

### When the answer comes back empty

The most confusing thing this API can return is `""`, and the reason is never in
the content. A reasoning model spends `maxTokens` on its **thinking block
first** — so a budget that looks generous for a one-word answer can be consumed
entirely before the visible answer starts. You get empty content,
`finish_reason: "length"`, and a bill for every one of those output tokens.
Measured on both the OpenAI and Anthropic wires: `claude-fable-5` at
`maxTokens: 16` does exactly this; at 200 the same prompt answers fine.

That empty string looks identical to a refusal, a content filter, or a broken
SDK. So the SDK reads the one distinguishing field for you:

```ts
const answer = await conifer.chat({ model, messages, maxTokens: 16 });
textOf(answer);        // ""
emptyReason(answer);   // "the model hit maxTokens before emitting visible text.
                       //  On a reasoning model the thinking block is spent FIRST…"
```

```python
answer.text          # ""
answer.empty_reason  # the same sentence, or None when there is nothing to explain
```

It returns `undefined`/`None` whenever there is text — and also for a tool call,
because empty text beside a tool call is the correct answer, not an absence.

## Embeddings

Same key, same receipts, same cost ceiling — and the vectors arrive as plain
numbers whatever the wire did.

```ts
const result = await conifer.embeddings.create({
  model: "text-embedding-3-small",
  input: ["alpha", "beta"],       // one vector per input, in order
});

console.log(result.data[0].embedding.length); // 1536
console.log(result.receipt.costUsd);          // "0.000000040" — settled, in band
```

```python
from conifer_sdk import EmbeddingsRequest, vector_of

result = conifer.embed(EmbeddingsRequest(
    model="text-embedding-3-small",
    input="hello world",
))
print(len(vector_of(result)), result.receipt.cost_nano_usd)
```

Three things worth knowing, because they are decisions rather than defaults:

- **base64 on the wire, numbers in your hands.** The SDK requests
  `encoding_format: "base64"` and decodes it for you. A JSON float array spends
  ~20 bytes per dimension against base64 float32's 5.33, so this is roughly 3x
  less network on the one payload that is actually large. It is applied silently
  only because it is exactly lossless — verified live, `text-embedding-3-small`
  returns identical values both ways, max absolute difference 0.0. Pass
  `encodingFormat: "float"` for JSON floats; `raw` always holds the provider's
  own body either way.
- **Embeddings bill on input only.** There is no completion, so there is no
  output term, no `max_tokens`, no sampling knobs and no stream. Unlike a
  streamed chat turn, the cost is on this very response.
- **Refusals are legible.** A chat model sent here is a 400 naming the chat
  door, not an opaque upstream 404 charged to you; token-id input is refused
  client-side before any spend, because the gateway cannot price token ids it
  did not tokenize.
- **Some models are not deterministic, and that is upstream of us.** Measured
  2026-08-27: six identical `bge-m3` calls returned four distinct vectors,
  differing by up to 2.2e-4, while `text-embedding-3-small` returned the same
  bytes every time. Batched GPU inference reorders float accumulation depending
  on what else shares the batch. It is far below anything that changes a
  ranking, but if you are diffing stored vectors or asserting on exact values in
  a test, compare with a tolerance rather than `==`.

`conifer.cheapestFor(["embeddings"])` picks the cheapest embedding seat the
catalog actually declares.

## Deferred jobs

For work that is not interactive — an overnight re-index, a bulk
classification, an eval sweep — submit the turn as a job and collect it later.

```ts
const job = await conifer.defer({
  model: "claude-fable-5",
  messages: [{ role: "user", content: "classify these 400 tickets…" }],
});
console.log(job.jobId, job.status);          // "job-gw-…", "queued"

const answer = await conifer.jobs.wait(job.jobId);
console.log(textOf(answer), answer.receipt.costUsd);
```

```python
job = conifer.defer(ChatRequest(model="claude-fable-5", messages=[...]))
answer = conifer.jobs_wait(job.job_id)       # or job_status / job_result
```

- **`chat({ defer: true })` throws, on purpose.** A deferred turn is answered
  with 202 and a job envelope, not a completion — so `chat()` has nothing to
  return. The previous behavior was worse than an error: the turn was accepted
  *and debited*, and came back as `choices: []`, indistinguishable at the call
  site from a model that answered with nothing.
- **The window floor is the gateway's, not ours.** Deferred work rides a
  provider batch, so the gateway requires a completion window of at least 24h
  and refuses anything narrower rather than quietly serving it synchronously at
  a different price. `defer()` defaults to that floor so the common call works.
- **`wait()` stops on terminal states.** `cancelled`, `failed` and `expired`
  never change; a poll loop keyed only on "is it ended yet" spins until the
  process dies. It also backs off exponentially, and on timeout it raises
  *without cancelling* — killing work you already paid for because a
  client-side clock ran out is not a decision an SDK should make for you.

## Keep your client. Get the receipts anyway.

The exact per-turn cost is the thing Conifer has that other gateways do not, and
it arrives on the **response headers** — which `openai`, `@anthropic-ai/sdk`,
LangChain, LiteLLM and the Vercel AI SDK all throw away. So pointing an existing
client at Conifer works perfectly and makes the whole differentiator invisible.

You do not have to rewrite anything to fix that. Every one of those clients takes
an injected `fetch` (or an `http_client`), so hand it one that reads the receipt
on the way past:

```ts
import OpenAI from "openai";
import { ReceiptCollector } from "@conifer/sdk";

const receipts = new ReceiptCollector();
const openai = new OpenAI({
  baseURL: "https://api.conifer.build/v1",
  apiKey: process.env.CONIFER_API_KEY,
  fetch: receipts.fetch,          // the only line that changes
});

await openai.chat.completions.create({ model: "claude-fable-5", messages });

receipts.last.costNanoUsd;   // 580000 — that exact call
receipts.total.costUsd;      // "0.001170000" — the whole session
```

```python
import httpx
from openai import OpenAI
from conifer_sdk import ReceiptCollector

receipts = ReceiptCollector()
openai = OpenAI(
    base_url="https://api.conifer.build/v1",
    api_key=os.environ["CONIFER_API_KEY"],
    http_client=httpx.Client(event_hooks={"response": [receipts.httpx_hook]}),
)
```

It never reads the response **body**. A body is a single-use stream that belongs
to the caller: consuming it to find a cost would break streaming and double
memory for everyone, and it would fail far from where it was caused. Headers are
already materialized, so observing them costs nothing and changes nothing —
the same response object is handed straight back.

`SpendBudget` answers the other question, the one no single request can:

```ts
const budget = new SpendBudget(5_000_000_000);   // $5 for this whole job
const openai = new OpenAI({ /* … */ fetch: budget.fetch });
```

It refuses the *next* call once the budget is gone. It cannot refund the one that
crossed the line, because a turn's cost is only known after it settles — so the
true worst case is `budget + one turn`. Pair it with a per-request
`maxCostNanoUsd` and that overshoot is bounded rather than open-ended.

### This works on all three wires

The gateway serves three request shapes, and the receipt headers are identical
on every one. Verified against the real vendor SDKs, unmodified:

| wire | client | verified |
| --- | --- | --- |
| `POST /v1/chat/completions` | `openai` → `.chat.completions` | ✅ receipts, streaming |
| `POST /v1/responses` | `openai` → `.responses` (the only wire Codex ≥ 0.145 speaks) | ✅ receipts |
| `POST /v1/messages` | `anthropic` → `.messages` | ✅ receipts, streaming |

```python
import anthropic
client = anthropic.Anthropic(
    base_url="https://api.conifer.build",     # note: no /v1 on the Anthropic door
    api_key=os.environ["CONIFER_API_KEY"],
    http_client=httpx.Client(event_hooks={"response": [receipts.httpx_hook]}),
)
```

This SDK deliberately does **not** reimplement the Responses or Messages wires.
Your vendor SDK already speaks them correctly, the gateway relays them
faithfully, and a third implementation of someone else's wire is a liability,
not a feature. `ReceiptCollector` is the piece that was missing, and it is
wire-agnostic because it reads headers.

## Why this exists when the OpenAI SDK already works

It still does, and it remains the right choice for a plain drop-in. This package
exists for the four things the OpenAI client structurally cannot give you:

| | |
| --- | --- |
| **The receipt** | Every response carries the exact integer nanodollar cost of *that call*, itemized across fresh input, cache write, cache read, and output. No second stats request, no float dollars, no estimating from token counts and a price table. |
| **Named refusals** | A 402 is *three* different problems: the account is out of credit, your own per-request ceiling refused this turn, or this key's lifetime cap is spent. The remedies are unrelated — top up, raise the ceiling, or rotate the key — so they are `ConiferPaymentError`, `ConiferCostCeilingError` and `ConiferKeySpendCapError`, not one status number. A 409 splits the same way: two of them mean "retry shortly" and are retried for you; the third never will be. |
| **The spend ceiling** | `maxCostNanoUsd` is a hard, server-enforced bound checked *before* any upstream call. The gateway refuses rather than serves. |
| **Portability** | Migration shims that refuse what Conifer cannot honor instead of dropping it silently. |

## Migrating from another gateway

Conifer speaks the OpenAI wire, so the base URL and key are most of the work:

```ts
// Vercel AI Gateway  ->  Conifer
- baseURL: "https://ai-gateway.vercel.sh/v1", apiKey: process.env.AI_GATEWAY_API_KEY
+ baseURL: "https://api.conifer.build/v1",    apiKey: process.env.CONIFER_API_KEY

// OpenRouter  ->  Conifer   (vendor/model ids resolve unchanged)
- baseURL: "https://openrouter.ai/api/v1",    apiKey: process.env.OPENROUTER_API_KEY
+ baseURL: "https://api.conifer.build/v1",    apiKey: process.env.CONIFER_API_KEY
```

The rest is the part that usually goes wrong quietly. **The shims refuse what
Conifer cannot honor, and name the replacement:**

```ts
import { fromOpenRouter } from "@conifer/sdk";

fromOpenRouter({ model: "anthropic/claude-opus-5", messages, provider: { order: ["anthropic"] } });
// ConiferPortabilityError: OpenRouter's `provider` preferences pin a serving host.
// Conifer picks the host for the admitted model itself, by price and health, and no
// client can override it. Remove the block, or use `maxCostNanoUsd` if the goal was
// cost control.
```

That is deliberate. Dropping a provider pin, a moderation flag, or a rate-limit
policy on the floor is what makes a migration *look* clean while changing what
runs and what it costs. The full honored/translated/refused matrix, field by
field, is [`cards/portability.card.json`](cards/portability.card.json).

The one thing worth knowing up front: **Conifer admits exactly the model you
name.** There is no server-side fallback list. OpenRouter's `models`, Vercel's
`gateway.models`, and `Helicone-Fallbacks` all become a *client-side* chain of
separate billed requests, which you must opt into:

```ts
const answer = await conifer.chat({
  model: "claude-opus-5",
  messages,
  fallbackModels: ["claude-haiku-4-5"],
  allowClientFallback: true,   // yes, I accept these are separate billed calls
});
answer.fallbackIndex;          // 0 = the model you asked for, 1 = the first fallback
```

Only a *retryable* failure advances the chain. A 402 or a bad request is the
same answer on every member, and spending on a second model would not fix it.

## The MCP server

The paste-one-line-into-your-agent trick only helps a tool that already speaks
the OpenAI wire. An agent, a Slack bot, or an IDE that speaks MCP has no such
hook — it can only use what its host exposes as a tool. So:

Build it once, then point any MCP host at the compiled binary:

```bash
git clone https://github.com/ConiferKit/use-conifer
cd use-conifer && npm install && npm run build
```

```json
{
  "mcpServers": {
    "conifer": {
      "command": "node",
      "args": ["/path/to/use-conifer/bin/conifer-mcp.mjs"],
      "env": { "CONIFER_API_KEY": "sk-conifer-…" }
    }
  }
}
```

Once `@conifer/sdk` is published this becomes
`"command": "npx", "args": ["-y", "@conifer/sdk", "conifer-mcp"]` and the build
step goes away. It is written as a path today because the npx form would 404
until the package is on the registry.

Six tools, each one real gateway call:

- `conifer_complete` — ask any model a question, or hand it a whole conversation. The answer returns **with what it cost**, and `max_cost_nanousd` bounds the spend before the call.
- `conifer_compare` — the same prompt across 2–5 models in parallel, each answer beside its cost, cheapest first. The ceiling caps each turn, not the total.
- `conifer_embed` — text to embedding vectors, with the settled cost. Returns the shape, the cost and a short preview rather than the raw vectors: a single 1536-dimension embedding is ~30 KB of digits that no model can read, and a batch would swallow the context window.
- `conifer_list_models` — the catalog, with declared capabilities and as-charged prices.
- `conifer_choose_model` — the cheapest model *declaring* the capabilities you need. It skips models with undeclared capabilities rather than assuming them, and unpriced models rather than assuming they are free.
- `conifer_balance` — remaining credit.

The reason `conifer_complete` reports its cost is that an agent that can see
what its last call cost can be told to spend less. One that cannot, cannot.

### A Slack bot that routes by cost

```ts
import { Conifer } from "@conifer/sdk";

const conifer = new Conifer({ defaultHeaders: { "x-conifer-client": "slack-bot" } });

export async function onMention(text: string, isLongTask: boolean) {
  // Pick from what the catalog actually declares, not from a hardcoded list.
  const model = await conifer.cheapestFor(isLongTask ? ["tools"] : [], {
    minContextWindow: isLongTask ? 200_000 : undefined,
  });
  if (model === undefined) return "no model in the catalog fits that request";

  const answer = await conifer.chat({
    model: model.id,
    messages: [{ role: "user", content: text }],
    maxTokens: 800,
    maxCostNanoUsd: 20_000_000,          // $0.02 per Slack reply, hard ceiling
    deadlineSeconds: isLongTask ? 900 : undefined,  // advisory: may serve on a cheaper tier
  });

  return `${answer.choices[0]?.message?.content}\n\n_${model.id} · $${answer.receipt.costUsd}_`;
}
```

## The cards

This package's contract is data rather than prose, so it cannot drift from the code that reads it:

- [`cards/sdk.input.card.json`](cards/sdk.input.card.json) — everything the SDK reads, and which gateway input each field maps to.
- [`cards/sdk.output.card.json`](cards/sdk.output.card.json) — everything it emits, including every receipt field and every error class.
- [`cards/portability.card.json`](cards/portability.card.json) — the migration contract, per competitor.

The cards are *tested*, not decorative: `tests/cards.test.ts` reads the
gateway's own generated wire contract — vendored at
[`contracts/gateway-contract.json`](contracts/gateway-contract.json) and pinned
by byte — and fails if a receipt header the gateway emits is not parsed, if a header the input card claims is
never sent, or if a field the portability card calls unsupported does not
actually refuse. The Python suite re-checks the same portability card, so both
languages refuse the same things.

## TypeScript consumers

Target **ES2018 or later** (`"target": "ES2018"`, or `"lib": ["ES2018"]`). The
stream type is an `AsyncIterable`, whose name only exists in `lib.es2018`, so an
older target reports `TS2583` pointing into our declarations. The official
`openai` package has the same requirement for the same reason — async iteration
cannot be described without the names that describe it.

Verified from a real `npm i`: an ES2022 consumer typechecks clean under
`strict` with **no** `skipLibCheck`, and CommonJS `require()` works on Node 22,
24 and 26.

## Tests

```bash
npm run build     # emit dist/ (ESM + .d.ts)
npm test          # 142 tests, offline
npm run typecheck

cd python && python3 -m pytest -q   # 96 tests, offline
```

Most assertions run with an injected transport: no network, no mock framework,
and every one is about bytes that would go on the wire or values handed back.
`tests/packaging.test.ts` is the exception and the important one — it checks the
package as a CONSUMER receives it, because that is where two real defects hid
(see below).

### The live QA harness

Offline tests can only confirm what we already believed. Four defects in this
SDK were invisible to a suite that mocked the server and obvious against the
real one, including three error classes that were unreachable in production and
a deferred turn that was billed and returned nothing readable. So there is a
second, deliberate gate:

```bash
CONIFER_API_KEY=sk-… npm run qa:live                     # 18 checks
CONIFER_API_KEY=sk-… node scripts/live-qa.mjs --include-deferred   # 20

cd python && CONIFER_API_KEY=sk-… python3 scripts/live_qa.py --include-deferred
```

It exercises every surface — catalog, chat, streaming, embeddings, receipts,
budgets, deferred jobs, and each refusal — against `api.conifer.build`, in both
languages, and prints the real cost of what it just did. It **spends real
money** (a few tenths of a cent), which is exactly why it is not part of
`npm test`: run it before a release, on purpose.

## What Conifer does not do

Stated here so you find out now rather than mid-migration:

- **No image generation, reranking, moderation, audio, Files, or Batches.**
  `assertSupportedVercelSurface` throws at the call site, naming the remedy,
  rather than letting you find out as a 404 in production on the one code path
  nobody exercised. (Embeddings WERE on this list; the gateway shipped
  `/v1/embeddings` on 2026-08-26 and the SDK now serves that door directly.)
- **No provider pinning.** The gateway chooses the host for the model you named, by price and health. The model is never substituted.
- **No server-side prompt compression, moderation, injection scanning, or prompt registry.**
- **No mid-stream fallback.** The first token commits the turn, so a chain cannot be attached to a stream.

## Verified against the live gateway

The offline suites use injected transports and no network, so they can only
confirm what we already believed. Every claim in this README is also checked
against production by `scripts/live-qa.mjs` and `python/scripts/live_qa.py`
(18 TS / 17 Python checks, plus 2 more with `--include-deferred`), in both languages, plus a
fresh-install pass that installs the packed tarball and the Python package into
clean projects and uses them as a consumer does.

That second gate is not ceremony. It is where every defect in the 2026-08-27
pass was found, and none of them were visible offline:

- three error classes were **unreachable** in production, because the gateway
  had moved to the industry error vocabulary while the fixtures kept the retired
  names — so every 401 and 400 arrived as a bare `ConiferError` and every 429
  silently discarded the server's own `retry-after`;
- `requestId` was **inert**: the gateway reads `idempotency-key` first, and the
  SDK always sent one, so a caller's trace id was never once consulted;
- `chat({ defer: true })` returned an **empty completion** for a turn that had
  been accepted *and debited*;
- transient `409`s were treated as terminal, and then, once retried, were given
  0.75s to resolve a cross-replica convergence;
- a fresh Python venv could not make its **first call at all**, because a
  python.org install has an empty CA trust store and no `certifi` to fall back
  to.

## License

[Apache License 2.0](LICENSE). Contributions are welcome under the same license
— start with [CONTRIBUTING.md](CONTRIBUTING.md).
