#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.ts")).sort()
  .map((f) => join("tests", f));
const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", ...files],
  { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
