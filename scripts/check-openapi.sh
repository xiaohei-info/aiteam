#!/usr/bin/env bash
# Generate and validate all three runtime OpenAPI documents.
set -euo pipefail

output_dir="${1:-$(mktemp -d "${TMPDIR:-/tmp}/aiteam-openapi.XXXXXX")}"
mkdir -p "$output_dir"

export OPERATION_SYSTEM_USERNAME="${OPERATION_SYSTEM_USERNAME:-sysadmin}"
export OPERATION_SYSTEM_PASSWORD="${OPERATION_SYSTEM_PASSWORD:-changeme-me}"
export OPERATOR_URL="${OPERATOR_URL:-http://operator.invalid}"
export AITEAM_ENV="${AITEAM_ENV:-test}"

PYTHONPATH=server python scripts/export_openapi.py "$output_dir"
(
  cd server/agent_service
  pnpm exec tsx scripts/export-openapi.ts "$output_dir/agent.json"
)
python scripts/check_openapi.py "$output_dir/operation.json" "$output_dir/manager.json" "$output_dir/agent.json"
