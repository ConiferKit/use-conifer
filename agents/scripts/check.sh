#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npm test
echo "conifer-agents: check OK"
