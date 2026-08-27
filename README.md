# The Conifer SDK

[![CI](https://github.com/ConiferKit/use-conifer/actions/workflows/ci.yml/badge.svg)](https://github.com/ConiferKit/use-conifer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

One client for the [Conifer](https://conifer.build) gateway, in TypeScript and
Python, plus an MCP server so tools that speak no OpenAI wire can still call it.

Conifer is one API key in front of every major model, on the OpenAI and
Anthropic wires. It charges the market rate for the model you call and **adds no
markup of its own**, and bringing your own provider key costs nothing.

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
> npm i ./use-conifer            # TypeScript
> pip install ./use-conifer/python   # Python
> ```
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

## Why this exists when the OpenAI SDK already works

It still does, and it remains the right choice for a plain drop-in. This package
exists for the four things the OpenAI client structurally cannot give you:

| | |
| --- | --- |
| **The receipt** | Every response carries the exact integer nanodollar cost of *that call*, itemized across fresh input, cache write, cache read, and output. No second stats request, no float dollars, no estimating from token counts and a price table. |
| **Named refusals** | A 402 is either "the account is out of credit" or "your own ceiling refused this turn". Those have opposite remedies, so they are `ConiferPaymentError` and `ConiferCostCeilingError`, not one status number. |
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
step goes away. It is written as a path today because the npx form would 404 —
see the note on publishing below.

Four tools, each one real gateway call:

- `conifer_list_models` — the catalog, with declared capabilities and as-charged prices.
- `conifer_choose_model` — the cheapest model *declaring* the capabilities you need. It skips models with undeclared capabilities rather than assuming them, and unpriced models rather than assuming they are free.
- `conifer_complete` — one turn, returned **with what it cost**. Takes `max_cost_nanousd`, so an agent can bound its own spend.
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
npm run build                                            # emit dist/ (ESM + .d.ts)
node --experimental-strip-types --test tests/*.test.ts   # 70 tests
cd python && python3 -m unittest discover -s tests       # 35 tests
```

Most assertions run with an injected transport: no network, no mock framework,
and every one is about bytes that would go on the wire or values handed back.
`tests/packaging.test.ts` is the exception and the important one — it checks the
package as a CONSUMER receives it, because that is where two real defects hid
(see below).

## What Conifer does not do

Stated here so you find out now rather than mid-migration:

- **No embeddings door and no image generation.** `assertSupportedVercelSurface` throws on both rather than letting you discover it as a 404.
- **No provider pinning.** The gateway chooses the host for the model you named, by price and health. The model is never substituted.
- **No server-side prompt compression, moderation, injection scanning, or prompt registry.**
- **No mid-stream fallback.** The first token commits the turn, so a chain cannot be attached to a stream.

## Verified against the live gateway

The suites above run offline. The package was also exercised against production
(`api.conifer.build`, 83-model catalog), which is what caught the two bugs worth
recording here:

1. **The catalog states money as decimal strings** (`"in_usd_per_mtok": "10"`),
   not numbers. The first `priceOf` summed only numeric values, so every model
   in the real catalog ranked as unpriced and `cheapestFor` returned nothing at
   all — while passing a unit test built on an invented shape. The tests now use
   the live shape.
2. **A TLS trust failure was reported as "could not reach the gateway"**, which
   sends the reader to check the network, the key, and the gateway, none of which
   are wrong. It now names the real cause and the two fixes.
3. **The package was unusable on the Node version it advertised.** `engines`
   said `>=22`, but the entry point was a raw `.ts` file, so Node 22 threw
   `ERR_UNKNOWN_FILE_EXTENSION` on `import`. It now ships compiled ESM plus
   `.d.ts` and runs from Node 18.
4. **`npx conifer-mcp` exited 0 in silence.** The server's
   direct-invocation guard compared `import.meta.url` against `process.argv[1]`,
   which is the bin shim's path in a published package — never the module's — so
   `serve()` never started, and an MCP host just saw no answer. Both are pinned
   by `tests/packaging.test.ts`, verified against a real `npm i` on Node 22.

Live results: exact receipts (`0.000046000` USD on a haiku turn, itemized and
summing to the total), `ConiferCostCeilingError` on a $0.000000001 ceiling with
the projection attached, and `ConiferModelNotFoundError` on an unknown id — in
both languages.

## License

[Apache License 2.0](LICENSE). Contributions are welcome under the same license
— start with [CONTRIBUTING.md](CONTRIBUTING.md).
