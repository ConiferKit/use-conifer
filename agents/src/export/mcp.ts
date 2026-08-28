// export/mcp.ts — compile a plugin manifest to the standard mcpServers config
// consumed by MCP-aware harnesses (Claude Desktop, etc.).
//
// ${VAR} placeholders are preserved verbatim: the target harness resolves them
// at its own load time. Anything with no MCP equivalent (hooks, instructions)
// is reported in `skipped` rather than dropped silently.

import { AgentError } from "../errors.ts";
import type { PluginManifest } from "../plugins/manifest.ts";

export interface McpExport {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }
                            | { url: string; headers?: Record<string, string> }>;
  skipped: { field: string; reason: string }[];
}

export function exportToMcp(manifest: PluginManifest): McpExport {
  // Object.create(null): server names like "__proto__" must behave as normal
  // keys for both assignment and duplicate detection. JSON output is unchanged.
  const mcpServers: McpExport["mcpServers"] = Object.create(null);
  const skipped: McpExport["skipped"] = [];

  for (const spec of manifest.mcp ?? []) {
    if (Object.prototype.hasOwnProperty.call(mcpServers, spec.name)) {
      throw new AgentError(
        `plugin "${manifest.name}": duplicate MCP server name "${spec.name}" — server names must be unique in an mcpServers config`,
      );
    }
    if (spec.toolAllowlist !== undefined) {
      skipped.push({
        field: `mcp/${spec.name}/toolAllowlist`,
        reason:
          "mcpServers config cannot express a tool allowlist, so the target harness " +
          "will expose ALL of this server's tools; re-narrow in the target harness if needed",
      });
    }
    if (spec.transport === "stdio") {
      mcpServers[spec.name] = {
        command: spec.command as string,
        ...(spec.args !== undefined ? { args: spec.args } : {}),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
      };
    } else {
      mcpServers[spec.name] = {
        url: spec.url as string,
        ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
      };
    }
  }

  if (!manifest.mcp || manifest.mcp.length === 0) {
    skipped.push({
      field: "mcp",
      reason: "manifest declares no MCP servers; the exported mcpServers config is empty",
    });
  }
  if (manifest.hooks !== undefined) {
    skipped.push({
      field: "hooks",
      reason: "hooks reference local code and cannot run as MCP config",
    });
  }
  if (manifest.instructions !== undefined) {
    skipped.push({
      field: "instructions",
      reason: "instructions have no MCP equivalent; paste into the target harness's system prompt",
    });
  }

  return { mcpServers, skipped };
}
