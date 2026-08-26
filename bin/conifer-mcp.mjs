#!/usr/bin/env node
// The published MCP entry point.
//
// A shim rather than a shebang on the server itself: the server is TypeScript,
// and a `.ts` bin only runs on a Node new enough to strip types. This runs the
// COMPILED server, so `npx conifer-mcp` works on any Node >= 18 — which is the
// difference between "add one line to your MCP config" and "first install a
// toolchain".
import "../dist/mcp/server.js";
