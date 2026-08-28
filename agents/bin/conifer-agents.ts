#!/usr/bin/env node
// conifer-agents — CLI. Hand-rolled arg parsing, no dependencies.
//
//   conifer-agents export --to mcp <manifest.json>
//
// Prints the compiled mcpServers config to stdout; anything the target format
// cannot express is listed on stderr. Exit 1 on unknown targets or invalid
// manifests.

import { readFileSync } from "node:fs";
import { loadManifest } from "../src/plugins/manifest.ts";
import { exportToMcp } from "../src/export/mcp.ts";
import { AgentError } from "../src/errors.ts";

const USAGE = `usage: conifer-agents export --to mcp <manifest.json>`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runExport(args: string[]): void {
  let to: string | undefined;
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--to") {
      to = args[++i];
      if (to === undefined) fail(`--to requires a value\n${USAGE}`);
    } else if (arg.startsWith("--")) {
      fail(`unknown option: ${arg}\n${USAGE}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      fail(`unexpected argument: ${arg}\n${USAGE}`);
    }
  }
  if (to === undefined) fail(`missing --to <target>\n${USAGE}`);
  if (to !== "mcp") fail(`unknown export target "${to}" (supported: mcp)`);
  if (file === undefined) fail(`missing manifest file\n${USAGE}`);

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    fail(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const { mcpServers, skipped } = exportToMcp(loadManifest(json));
    process.stdout.write(`${JSON.stringify({ mcpServers }, null, 2)}\n`);
    for (const s of skipped) {
      process.stderr.write(`skipped ${s.field}: ${s.reason}\n`);
    }
  } catch (err) {
    if (err instanceof AgentError) fail(err.message);
    throw err;
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "export") {
  runExport(rest);
} else if (command === undefined || command === "--help" || command === "-h") {
  fail(USAGE);
} else {
  fail(`unknown command: ${command}\n${USAGE}`);
}
