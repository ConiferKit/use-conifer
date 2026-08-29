import { AgentError, ToolLimitError, type ToolSourceCount } from "./errors.ts";
import type { AgentTool } from "./types.ts";

export const DEFAULT_TOOL_CAP = 128;

export function preflightTools(
  agent: string, tools: AgentTool[], cap: number,
): { warnings: { count: number; cap: number }[] } {
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new AgentError(`agent "${agent}" has a duplicate tool name "${t.name}"`);
    seen.add(t.name);
  }
  if (tools.length > cap) {
    const bySource = new Map<string, number>();
    for (const t of tools) {
      const s = t.source ?? "native";
      bySource.set(s, (bySource.get(s) ?? 0) + 1);
    }
    const sources: ToolSourceCount[] = [...bySource.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);
    throw new ToolLimitError({ agent, count: tools.length, cap, sources });
  }
  const warnings = tools.length >= Math.ceil(cap * 0.8) ? [{ count: tools.length, cap }] : [];
  return { warnings };
}
