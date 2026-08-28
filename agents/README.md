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

## Plugins

A plugin is a portable capability bundle described by a manifest (JSON Schema at
[`sdk/contracts/plugin-manifest.schema.json`](../contracts/plugin-manifest.schema.json)):
MCP servers, an optional instructions fragment, and optional code hooks. Nothing
mounts implicitly: an agent gets a plugin's tools only when it names the plugin,
and it can narrow to specific tools.

```json
{
  "name": "github",
  "version": "1.0.0",
  "description": "GitHub via the reference MCP server",
  "mcp": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "toolAllowlist": ["get_file_contents", "search_code", "create_issue"]
    }
  ],
  "instructions": "Prefer search_code over guessing paths."
}
```

Load it with `definePlugin(manifest)` (validates structurally, throws
`PluginValidationError` with JSON-pointer-ish paths on bad input) and hand it to
`orchestrate({ plugins: [...] })`. `${VAR}` placeholders in `env`, `headers`,
and `url` are interpolated from the process environment at mount time via
`resolveEnv`; a missing variable fails loudly rather than sending an empty
string to a server. MCP connections are lazy (first tool listing), shared
across agents in a team, and closed when `team.run()` settles. Tool names are
prefixed `<server>__<tool>` locally; the unprefixed name goes over the wire.

Code hooks (`definePlugin(manifest, { preToolCall, ... })`) run in-process and
are the one NON-PORTABLE part of a plugin: they reference local code, so they
survive neither the manifest file alone nor an MCP export.

## Export

A manifest's MCP servers can be compiled to the standard `mcpServers` config
consumed by MCP-aware harnesses (Claude Desktop and friends):

```console
$ npx conifer-agents export --to mcp github.json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

`${VAR}` placeholders are preserved verbatim for the target harness to resolve.
Anything the format cannot express is reported on stderr instead of dropped
silently: `toolAllowlist` (the target will expose ALL of that server's tools),
`hooks`, and `instructions`. The same compiler is available as
`exportToMcp(manifest)` in code.

## Tool limits

Gateways reject requests with too many tools (the classic symptom is an opaque
422 after a team quietly accumulated every mounted server's tool list). So
every run preflights its tool surface before the first request: past 80% of the
cap (default 128, `toolLimit` to override) you get a warning event, and over
the cap the run throws `ToolLimitError` before spending anything, with a
per-source breakdown (`native`, `subagent`, `plugin:<name>`) naming who
contributed how many tools.

The fix is scoping, not raising the cap: mount plugins per-agent
(`plugins: { github: ["get_file_contents", "search_code"] }`) so each agent
carries only the tools it needs, and use `toolAllowlist` in the manifest to
shrink a server's surface for everyone.
