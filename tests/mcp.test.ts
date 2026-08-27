// tests/mcp.test.ts — the MCP server, driven over its real JSON-RPC protocol.
//
// The point of testing `handle` directly is that it IS the protocol: no
// paraphrase, no partial stub. A host that speaks MCP sends these exact
// messages, so if these pass, the server answers a real host.

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { Conifer } from "../src/index.ts";
import { TOOLS, handle, serve } from "../mcp/server.ts";

function stubClient(responses: Response[]) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("no scripted response left");
    return next;
  };
  const client = new Conifer({ apiKey: "sk-conifer-test", fetch: fetchImpl, maxRetries: 0 });
  return { calls, client: () => client };
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const CATALOG = {
  object: "list",
  data: [
    {
      id: "claude-haiku-4-5",
      endpoint_kind: "conifer",
      provider: "anthropic",
      context_window: 200000,
      caps: ["tools"],
      // The LIVE catalog's shape: money as decimal strings per million tokens.
      pricing: { in_usd_per_mtok: "1", out_usd_per_mtok: "5" },
    },
    {
      id: "expensive-model",
      endpoint_kind: "conifer",
      caps: ["tools", "vision"],
      pricing: { in_usd_per_mtok: "50", out_usd_per_mtok: "200" },
    },
  ],
};

/** Read the one JSON payload a tool call returns. */
function payload(response: any) {
  return JSON.parse(response.result.content[0].text);
}

test("initialize answers with the protocol version and tool capability", async () => {
  const response = await handle(
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    stubClient([]).client,
  );
  assert.equal((response as any).result.protocolVersion, "2024-11-05");
  assert.deepEqual((response as any).result.capabilities, { tools: {} });
  assert.equal((response as any).result.serverInfo.name, "conifer");
});

test("tools/list works before a key exists, so a host can inspect the server", async () => {
  const response = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, () => {
    throw new Error("must not construct a client just to list tools");
  });
  const names = (response as any).result.tools.map((tool: any) => tool.name);
  assert.deepEqual(names, [
    "conifer_list_models",
    "conifer_choose_model",
    "conifer_complete",
    "conifer_compare",
    "conifer_balance",
  ]);
  for (const tool of (response as any).result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 60, `${tool.name} needs a usable description`);
  }
});

test("an initialized notification gets no reply, as the protocol requires", async () => {
  const response = await handle(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    stubClient([]).client,
  );
  assert.equal(response, undefined);
});

test("list_models filters by DECLARED capability", async () => {
  const { client } = stubClient([json(CATALOG)]);
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "conifer_list_models", arguments: { caps: ["vision"] } },
    },
    client,
  );
  const models = payload(response);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "expensive-model");
});

test("choose_model picks the cheapest declared-capable entry", async () => {
  const { client } = stubClient([json(CATALOG)]);
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "conifer_choose_model", arguments: { caps: ["tools"] } },
    },
    client,
  );
  assert.equal(payload(response).chosen.id, "claude-haiku-4-5");
});

test("choose_model says so plainly when nothing qualifies", async () => {
  const { client } = stubClient([json(CATALOG)]);
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "conifer_choose_model", arguments: { caps: ["telepathy"] } },
    },
    client,
  );
  const result = payload(response);
  assert.equal(result.chosen, null);
  assert.match(result.why, /no catalog entry declares/);
});

test("complete returns the text AND what that exact call cost", async () => {
  const { calls, client } = stubClient([
    json(
      {
        id: "chatcmpl-1",
        model: "claude-haiku-4-5",
        choices: [{ message: { role: "assistant", content: "pinecone" } }],
        usage: { prompt_tokens: 9, completion_tokens: 2 },
      },
      {
        headers: {
          "x-conifer-effective-model": "claude-haiku-4-5",
          "x-conifer-cost-nanousd": "1250000",
          "x-conifer-cost-components-nanousd":
            "fresh=1000000,cache_write=0,cache_read=50000,output=200000",
          "x-conifer-request-id": "req-9",
        },
      },
    ),
  ]);
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "conifer_complete",
        arguments: {
          model: "claude-haiku-4-5",
          system: "be terse",
          prompt: "name a build cache",
          max_cost_nanousd: 5_000_000,
        },
      },
    },
    client,
  );
  const result = payload(response);
  assert.equal(result.text, "pinecone");
  assert.equal(result.cost_nanousd, 1_250_000);
  assert.equal(result.cost_usd, "0.001250000");
  assert.equal(result.request_id, "req-9");

  const sent = calls[0]!;
  assert.equal(sent.init.headers["x-conifer-max-cost-nanousd"], "5000000");
  assert.equal(sent.init.headers["x-conifer-client"], "conifer-mcp");
  const body = JSON.parse(sent.init.body);
  assert.deepEqual(body.messages[0], { role: "system", content: "be terse" });
  assert.equal(body.max_tokens, 1024, "an unbounded agent turn is not a good default");
});

test("a gateway refusal reaches the agent as readable, actionable text", async () => {
  const { client } = stubClient([
    json(
      {
        error: {
          type: "insufficient_allowance",
          message: "insufficient allowance: this request needs up to 900 nanodollars but you hold 100; add credits",
        },
      },
      { status: 402 },
    ),
  ]);
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "conifer_complete", arguments: { model: "m", prompt: "hi" } },
    },
    client,
  );
  assert.equal((response as any).result.isError, true);
  const text = (response as any).result.content[0].text;
  assert.match(text, /insufficient_allowance/);
  assert.match(text, /add credits/, "the remedy must survive to the agent");
});

test("an unknown tool is a protocol error, not a silent empty result", async () => {
  const response = await handle(
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nope" } },
    stubClient([]).client,
  );
  assert.equal((response as any).error.code, -32602);
});

test("an unknown method answers method-not-found", async () => {
  const response = await handle(
    { jsonrpc: "2.0", id: 9, method: "resources/list" },
    stubClient([]).client,
  );
  assert.equal((response as any).error.code, -32601);
});

test("the stdio transport frames newline-delimited JSON-RPC both ways", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serve(input as any, output as any);

  const lines: string[] = [];
  output.on("data", (chunk) => lines.push(...String(chunk).trim().split("\n")));

  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).result.serverInfo.name, "conifer");
  assert.equal(JSON.parse(lines[1]!).result.tools.length, TOOLS.length);
});

test("every tool that spends money can be given a ceiling", () => {
  for (const name of ["conifer_complete", "conifer_compare"]) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    assert.ok(
      "max_cost_nanousd" in (tool.inputSchema as any).properties,
      `${name}: an agent must be able to bound its own spend`,
    );
  }
});

test("complete accepts a full conversation, not just a one-shot prompt", async () => {
  const { calls, client } = stubClient([
    json(
      { choices: [{ message: { role: "assistant", content: "refined" } }] },
      { headers: { "x-conifer-cost-nanousd": "1000" } },
    ),
  ]);
  const conversation = [
    { role: "user", content: "draft a commit message" },
    { role: "assistant", content: "feat: stuff" },
    { role: "user", content: "too vague, name the subsystem" },
  ];
  await handle(
    {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "conifer_complete",
        arguments: { model: "m", system: "be terse", messages: conversation, reasoning_effort: "low" },
      },
    },
    client,
  );
  const body = JSON.parse(calls[0]!.init.body);
  assert.equal(body.messages.length, 4, "system + the three turns");
  assert.deepEqual(body.messages[0], { role: "system", content: "be terse" });
  assert.deepEqual(body.messages.slice(1), conversation);
  assert.deepEqual(body.reasoning, { effort: "low" });
});

test("compare runs every model, sorts by cost, and keeps failures as footnotes", async () => {
  const { client } = stubClient([
    // Scripted in call order; results must come back sorted by COST.
    json(
      { choices: [{ message: { content: "dear answer" } }] },
      { headers: { "x-conifer-cost-nanousd": "9000", "x-conifer-effective-model": "dear" } },
    ),
    json(
      { choices: [{ message: { content: "cheap answer" } }] },
      { headers: { "x-conifer-cost-nanousd": "10", "x-conifer-effective-model": "cheap" } },
    ),
    json(
      { error: { type: "model_not_found", message: "no" } },
      { status: 404 },
    ),
  ]);
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "conifer_compare",
        arguments: { models: ["dear", "cheap", "missing"], prompt: "hi" },
      },
    },
    client,
  );
  const { results } = payload(response);
  assert.equal(results.length, 3);
  assert.equal(results[0].model, "cheap", "cheapest first");
  assert.equal(results[1].model, "dear");
  assert.match(results[2].error, /model_not_found/, "a failure is reported in place, not thrown");
  assert.equal((response as any).result.isError, undefined, "one bad model never sinks the comparison");
});

test("compare refuses a single-model list with advice instead of spending", async () => {
  const response = await handle(
    {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "conifer_compare", arguments: { models: ["only-one"], prompt: "hi" } },
    },
    stubClient([]).client,
  );
  assert.match(payload(response).error, /at least two/);
});
