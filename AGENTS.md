# sdk/ — agent notes

## sdk/agents (conifer-agents)

`sdk/agents/` is a separate package (`conifer-agents`): client-side agent
orchestration on top of `conifer-sdk` (Agent run loop, subagents-as-tools,
`orchestrate()`, portable MCP plugins, `conifer-agents export`).

- Verify gate: `bash sdk/agents/scripts/check.sh` (typecheck + full test suite).
  Run it before committing anything under `sdk/agents/`.
- Live tests in `sdk/agents/tests/live.test.ts` are gated: the gateway test on
  `CONIFER_API_KEY`, the MCP stdio test on `CONIFER_MCP_LIVE=1` (with a 60s
  timeout). Both skip cleanly when their gate is unset, so the suite is
  keyless-green.
- It is NOT part of the `sdk-public` split and is NOT included in any publish
  or release process until explicitly approved. Do not add it to release
  scripts or the public mirror.
