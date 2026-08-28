// orchestrate.ts — Layer B: declarative teams. One orchestrator delegates to
// named subagents (mounted as tools via asTool()); portable plugins mount
// ONLY on agents that reference them by name. Agents are constructed
// synchronously so callers can inspect/override them before run(); only the
// async MCP tool mounting is deferred (memoized) to Team.run().

import { Agent, type ChatClient } from "./agent.ts";
import { AgentError } from "./errors.ts";
import { mergeHooks, type HookSet } from "./hooks.ts";
import { resolveEnv, type Plugin } from "./plugins/manifest.ts";
import { McpPluginRuntime } from "./plugins/mcp.ts";
import type { AgentTool, NanoUsd, RunOptions, RunResult } from "./types.ts";

export interface SubagentSpec {
  model: string;
  instructions: string;
  tools?: AgentTool[];
  /** Override for the asTool() description shown to the orchestrator. */
  description?: string;
  /** plugin name -> tool allowlist (unprefixed names) or true = all. */
  plugins?: Record<string, string[] | true>;
  maxCostNanoUsd?: NanoUsd;
  maxTurns?: number;
  toolLimit?: number;
}

export interface OrchestrateConfig {
  orchestrator: {
    model: string;
    instructions: string;
    plugins?: Record<string, string[] | true>;
    maxTurns?: number;
    toolLimit?: number;
  };
  subagents: Record<string, SubagentSpec>;
  /** The plugin registry; nothing mounts implicitly. */
  plugins?: Plugin[];
  /** Budget for the whole tree — lands on the orchestrator only (subagent
   * spend folds into its aggregate between turns). */
  maxCostNanoUsd?: NanoUsd;
  client?: ChatClient;
  hooks?: HookSet;
}

export interface Team {
  orchestrator: Agent;
  subagents: Record<string, Agent>;
  /** Runs the orchestrator, then shuts down any MCP runtimes it started. */
  run(input: string, options?: RunOptions): Promise<RunResult>;
}

/** One agent's resolved plugin mounts: the plugin plus its per-agent allowlist. */
interface Mount {
  plugin: Plugin;
  allowlist: string[] | true;
}

function resolveMounts(
  agentName: string,
  refs: Record<string, string[] | true> | undefined,
  registry: Map<string, Plugin>,
): Mount[] {
  if (!refs) return [];
  return Object.entries(refs).map(([name, allowlist]) => {
    const plugin = registry.get(name);
    if (!plugin) {
      throw new AgentError(
        `agent "${agentName}" references unknown plugin "${name}" — not in the plugins registry`,
      );
    }
    return { plugin, allowlist };
  });
}

/** Base instructions + each mounted plugin's fragment, double-newline joined. */
function mountedInstructions(base: string, mounts: Mount[]): string {
  const fragments = mounts
    .map((m) => m.plugin.manifest.instructions)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return [base, ...fragments].join("\n\n");
}

/** Config-level hooks first, then each mounted plugin's code hooks. */
function mountedHooks(configHooks: HookSet | undefined, mounts: Mount[]): HookSet | undefined {
  const pluginHooks = mounts
    .map((m) => m.plugin.hooks)
    .filter((h): h is HookSet => h !== undefined);
  if (pluginHooks.length === 0) return configHooks;
  return mergeHooks(configHooks ? [configHooks, ...pluginHooks] : pluginHooks);
}

/** Does `name` (prefixed `server__tool`) survive an unprefixed allowlist? */
function allowed(name: string, allowlist: string[] | true, serverNames: string[]): boolean {
  if (allowlist === true) return true;
  for (const server of serverNames) {
    const prefix = `${server}__`;
    if (name.startsWith(prefix)) return allowlist.includes(name.slice(prefix.length));
  }
  return false;
}

export function orchestrate(config: OrchestrateConfig): Team {
  const registry = new Map<string, Plugin>();
  for (const plugin of config.plugins ?? []) registry.set(plugin.manifest.name, plugin);

  // Validate every plugin reference eagerly: unknown names throw here, at
  // orchestrate() time, not lazily inside run().
  const orchestratorMounts = resolveMounts("orchestrator", config.orchestrator.plugins, registry);
  const subagentMounts = new Map<string, Mount[]>();
  for (const [name, spec] of Object.entries(config.subagents)) {
    subagentMounts.set(name, resolveMounts(name, spec.plugins, registry));
  }

  // One shared McpPluginRuntime per MCP-bearing plugin that is actually
  // mounted somewhere. Construction is cheap; connections are lazy.
  const runtimes = new Map<string, McpPluginRuntime>();
  const allMounts = [...orchestratorMounts, ...[...subagentMounts.values()].flat()];
  for (const { plugin } of allMounts) {
    const { name } = plugin.manifest;
    const mcp = plugin.manifest.mcp;
    if (mcp && mcp.length > 0 && !runtimes.has(name)) {
      runtimes.set(name, new McpPluginRuntime(name, mcp.map((s) => resolveEnv(s))));
    }
  }

  // Construct the Agents synchronously so callers can inspect and override
  // (e.g. swap `client`) before run(). We retain each tools array reference:
  // the Agent aliases it, so appending MCP tools later lands on the agent.
  const subagents: Record<string, Agent> = {};
  const toolArrays = new Map<Agent, AgentTool[]>();

  for (const [name, spec] of Object.entries(config.subagents)) {
    const mounts = subagentMounts.get(name)!;
    const tools = [...(spec.tools ?? [])];
    const agent = new Agent({
      name,
      model: spec.model,
      instructions: mountedInstructions(spec.instructions, mounts),
      tools,
      maxTurns: spec.maxTurns,
      maxCostNanoUsd: spec.maxCostNanoUsd,
      toolLimit: spec.toolLimit,
      client: config.client,
      hooks: mountedHooks(config.hooks, mounts),
    });
    toolArrays.set(agent, tools);
    subagents[name] = agent;
  }

  // Orchestrator tools = its own plugin mounts (MCP tools appended at mount
  // time) + one asTool() handle per subagent. Subagents never see each other.
  const orchestratorTools: AgentTool[] = Object.entries(subagents).map(([name, agent]) => {
    const description = config.subagents[name]?.description;
    return agent.asTool(description !== undefined ? { description } : {});
  });
  const orchestrator = new Agent({
    name: "orchestrator",
    model: config.orchestrator.model,
    instructions: mountedInstructions(config.orchestrator.instructions, orchestratorMounts),
    tools: orchestratorTools,
    maxTurns: config.orchestrator.maxTurns,
    maxCostNanoUsd: config.maxCostNanoUsd,
    toolLimit: config.orchestrator.toolLimit,
    client: config.client,
    hooks: mountedHooks(config.hooks, orchestratorMounts),
  });
  toolArrays.set(orchestrator, orchestratorTools);

  // Memoized async MCP mounting: fetch each mounted plugin's tools once (the
  // runtime is shared) and append the per-agent-filtered slice to each
  // mounting agent's tool array.
  let mounted: Promise<void> | undefined;
  const mountMcpTools = (): Promise<void> => (mounted ??= (async () => {
    if (runtimes.size === 0) return;
    const pluginTools = new Map<string, AgentTool[]>();
    for (const [name, runtime] of runtimes) pluginTools.set(name, await runtime.tools());

    const append = (agent: Agent, mounts: Mount[]) => {
      const target = toolArrays.get(agent)!;
      for (const { plugin, allowlist } of mounts) {
        const tools = pluginTools.get(plugin.manifest.name);
        if (!tools) continue; // plugin has no MCP servers
        const serverNames = (plugin.manifest.mcp ?? []).map((s) => s.name);
        for (const t of tools) {
          if (allowed(t.name, allowlist, serverNames)) target.push(t);
        }
      }
    };
    append(orchestrator, orchestratorMounts);
    for (const [name, agent] of Object.entries(subagents)) {
      append(agent, subagentMounts.get(name)!);
    }
  })());

  return {
    orchestrator,
    subagents,
    async run(input: string, options?: RunOptions): Promise<RunResult> {
      try {
        await mountMcpTools();
        return await orchestrator.run(input, options);
      } finally {
        await Promise.all([...runtimes.values()].map((r) => r.shutdown()));
      }
    },
  };
}
