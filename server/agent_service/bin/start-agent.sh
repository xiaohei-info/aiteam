#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${ROOT}/runtime/node" --import "${ROOT}/node_modules/tsx/dist/esm/index.mjs" "${ROOT}/bin/start-agent.mjs" "$@"
