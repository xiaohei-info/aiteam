#!/usr/bin/env bash
# Content-addressed image verified from the deployment OCI manifest/config/archive.
# No tag/registry fallback, host credentials, host data directory or real network.
set -euo pipefail
image='sha256:8d1952becd2119115e995accbdc7cdb88d9bc147df08653e0b47455ee08a0df0'
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
actual=$(docker image inspect "$image" --format '{{.Id}} {{.Os}}/{{.Architecture}}')
[[ "$actual" == "$image linux/amd64" ]] || { echo 'Approved Hindsight image is unavailable' >&2; exit 1; }
name="aiteam-s04-native-probe-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run --name "$name" --rm --pull=never --platform linux/amd64 --network none \
  --memory=3g --cpus=2 --pids-limit=256 \
  --entrypoint /app/api/.venv/bin/python \
  --mount "type=bind,source=$script_dir/s04_hindsight_native_probe.py,target=/tmp/s04_probe.py,readonly" \
  -e HINDSIGHT_API_LOG_LEVEL=WARNING -e LITELLM_LOCAL_MODEL_COST_MAP=True \
  "$image" /tmp/s04_probe.py
