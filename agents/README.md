# conifer-agents

Client-side agent orchestration for the [Conifer](../..) gateway. It provides an `Agent` class whose run loop calls the gateway with tools, dispatches tool calls, and aggregates per-call receipts into a budget-enforced tree; subagents mount as tools via `agent.asTool()`; a declarative `orchestrate()` layer wires an orchestrator plus subagents plus portable plugins (MCP servers described by a manifest) into a team. Money is integer nanodollars end to end, and every terminal state, including errors, carries the aggregate receipt so cost is never unknown.

This is a 0.x package and it is early. The API will move, names will change, and no compatibility is promised between minor versions yet. Pin an exact version if you depend on it, and expect to read the changelog.

Layer A, the primitives:

```ts
const agent = new Agent({
  name: "researcher",
  model: "claude-haiku-4-5",          // any gateway id or router alias
  instructions: "...",
  tools: [searchTool],                 // { name, description, parameters: JSONSchema, execute }
  maxTurns: 12,
  maxCostNanoUsd: 50_000_000,          // budget for the whole run
  toolLimit: 128,                      // optional override of the preflight cap
});
const run = await agent.run("find the KV cache limits", { signal, onEvent });
run.output;   // final text (or structured tool answer)
run.receipt;  // aggregated: total cost + per-call itemized receipts
```

Layer B, the declarative orchestrator:

```ts
const team = orchestrate({
  orchestrator: { model: "gpt-5.6-sol", instructions: "..." },
  subagents: {
    researcher: { model: "claude-haiku-4-5", instructions: "...",
                  plugins: { github: ["get_file_contents", "search_code"] } },
    writer:     { model: "deepseek-v4-pro", instructions: "..." },
  },
  plugins: [githubPlugin],             // registry; agents opt in with scoping
  maxCostNanoUsd: 200_000_000,
});
const result = await team.run("write a report on X");
```
