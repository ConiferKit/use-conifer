// plugins/manifest.ts — plugin manifest validation and env resolution.
//
// The authoritative schema lives at sdk/contracts/plugin-manifest.schema.json
// (JSON Schema draft 2020-12). Validation here is hand-rolled structural
// checking that mirrors that schema exactly — no validator dependency.

import { PluginValidationError } from "../errors.ts";
import type { HookSet } from "../hooks.ts";

export interface McpServerSpec {
  name: string;
  transport: "stdio" | "http";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http
  url?: string;
  headers?: Record<string, string>;
  toolAllowlist?: string[];
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  mcp?: McpServerSpec[];
  /** "preToolCall": "./hooks.js#audit" — NON-PORTABLE (see schema $comment). */
  hooks?: Record<string, string>;
  instructions?: string;
}

/** A loaded, resolved plugin. */
export interface Plugin {
  manifest: PluginManifest;
  /** Only for definePlugin(). */
  hooks?: HookSet;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkStringMap(
  v: unknown,
  path: string,
  problems: string[],
): void {
  if (!isRecord(v)) {
    problems.push(`${path}: expected an object of string values`);
    return;
  }
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") problems.push(`${path}/${k}: expected a string`);
  }
}

function checkStringArray(v: unknown, path: string, problems: string[]): void {
  if (!Array.isArray(v)) {
    problems.push(`${path}: expected an array of strings`);
    return;
  }
  v.forEach((item, i) => {
    if (typeof item !== "string") problems.push(`${path}/${i}: expected a string`);
  });
}

const MANIFEST_KEYS = new Set(["name", "version", "description", "mcp", "hooks", "instructions"]);
const SERVER_KEYS = new Set(["name", "transport", "command", "args", "env", "url", "headers", "toolAllowlist"]);

function checkServer(v: unknown, path: string, problems: string[]): void {
  if (!isRecord(v)) {
    problems.push(`${path}: expected an object`);
    return;
  }
  for (const key of Object.keys(v)) {
    if (!SERVER_KEYS.has(key)) problems.push(`${path}/${key}: unknown property`);
  }
  if (typeof v.name !== "string") problems.push(`${path}/name: required, must be a string`);
  if (v.transport !== "stdio" && v.transport !== "http") {
    problems.push(`${path}/transport: required, must be "stdio" or "http"`);
  }
  if (v.transport === "stdio" && typeof v.command !== "string") {
    problems.push(`${path}/command: required for stdio transport`);
  }
  if (v.transport === "http" && typeof v.url !== "string") {
    problems.push(`${path}/url: required for http transport`);
  }
  if (v.command !== undefined && typeof v.command !== "string") {
    problems.push(`${path}/command: expected a string`);
  }
  if (v.url !== undefined && typeof v.url !== "string") {
    problems.push(`${path}/url: expected a string`);
  }
  if (v.args !== undefined) checkStringArray(v.args, `${path}/args`, problems);
  if (v.env !== undefined) checkStringMap(v.env, `${path}/env`, problems);
  if (v.headers !== undefined) checkStringMap(v.headers, `${path}/headers`, problems);
  if (v.toolAllowlist !== undefined) checkStringArray(v.toolAllowlist, `${path}/toolAllowlist`, problems);
}

/** Validate an unknown value as a PluginManifest, throwing PluginValidationError with all problems. */
export function loadManifest(json: unknown): PluginManifest {
  const problems: string[] = [];
  if (!isRecord(json)) {
    throw new PluginValidationError({ plugin: "<unknown>", problems: ["/: expected an object"] });
  }
  for (const key of Object.keys(json)) {
    if (!MANIFEST_KEYS.has(key)) problems.push(`/${key}: unknown property`);
  }
  if (typeof json.name !== "string") {
    problems.push("/name: required, must be a string");
  } else if (!NAME_PATTERN.test(json.name)) {
    problems.push(`/name: "${json.name}" does not match ${NAME_PATTERN}`);
  }
  if (typeof json.version !== "string") problems.push("/version: required, must be a string");
  if (json.description !== undefined && typeof json.description !== "string") {
    problems.push("/description: expected a string");
  }
  if (json.instructions !== undefined && typeof json.instructions !== "string") {
    problems.push("/instructions: expected a string");
  }
  if (json.hooks !== undefined) checkStringMap(json.hooks, "/hooks", problems);
  if (json.mcp !== undefined) {
    if (!Array.isArray(json.mcp)) {
      problems.push("/mcp: expected an array");
    } else {
      json.mcp.forEach((server, i) => checkServer(server, `/mcp/${i}`, problems));
    }
  }
  if (problems.length > 0) {
    const plugin = typeof json.name === "string" ? json.name : "<unknown>";
    throw new PluginValidationError({ plugin, problems });
  }
  return json as unknown as PluginManifest;
}

/** Validate a manifest and pair it with in-process code hooks. No env resolution. */
export function definePlugin(manifest: PluginManifest, hooks?: HookSet): Plugin;
/** Unvalidated input is accepted and structurally validated at runtime. */
export function definePlugin(manifest: Record<string, unknown>, hooks?: HookSet): Plugin;
export function definePlugin(manifest: unknown, hooks?: HookSet): Plugin {
  const validated = loadManifest(manifest);
  return hooks ? { manifest: validated, hooks } : { manifest: validated };
}

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Interpolate ${VAR} placeholders in env values, header values, and url from
 * the provided environment (default process.env). Collects ALL missing
 * variable names into a single PluginValidationError.
 */
export function resolveEnv(
  spec: McpServerSpec,
  env: Record<string, string | undefined> = process.env,
): McpServerSpec {
  const missing = new Set<string>();
  const interpolate = (value: string, path: string): string =>
    value.replace(VAR_PATTERN, (_match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        missing.add(`${path}: missing environment variable ${name}`);
        return "";
      }
      return resolved;
    });
  const mapValues = (
    record: Record<string, string> | undefined,
    path: string,
  ): Record<string, string> | undefined => {
    if (!record) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(record)) out[k] = interpolate(v, `${path}/${k}`);
    return out;
  };
  const resolved: McpServerSpec = {
    ...spec,
    ...(spec.env ? { env: mapValues(spec.env, "env") } : {}),
    ...(spec.headers ? { headers: mapValues(spec.headers, "headers") } : {}),
    ...(spec.url !== undefined ? { url: interpolate(spec.url, "url") } : {}),
  };
  if (missing.size > 0) {
    throw new PluginValidationError({ plugin: spec.name, problems: [...missing] });
  }
  return resolved;
}
