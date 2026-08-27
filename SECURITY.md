# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/ConiferKit/use-conifer/security/advisories/new),
or email **security@conifer.build**.

Include what you need to describe the issue: the affected version, what an
attacker can do, and the steps to reproduce. You will get an acknowledgement
within three business days.

## Scope

This repository is the Conifer SDK: the TypeScript and Python clients, the MCP
server, and the vendored wire contract. Vulnerabilities in the gateway itself
(`api.conifer.build`), in billing, or in the console are also welcome through
the same channels — say which surface you are reporting so it reaches the right
people.

## If you have leaked a key

Revoke it at [the console](https://conifer.build/console#/keys). Revocation
reaches the gateway within seconds, and a revoked key cannot be reinstated,
which is the intended behavior. Mint a replacement and update
`CONIFER_API_KEY`.

## What the SDK does with your key

It reads `CONIFER_API_KEY` from the environment and sends it as a bearer
credential to the base URL you configured, and nothing else. It never logs the
key, never places it in a URL, and opens no connection of its own beyond the
`fetch` implementation you can inject. If you find a path where a credential
reaches a log line, an error message, or a URL, that is a vulnerability under
this policy and we want to hear about it.
