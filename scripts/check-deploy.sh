#!/usr/bin/env bash
# Deployment/release quality gate used locally and in CI. It never mutates a
# database, pulls an image, starts a service, or contacts taiyi.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

shell_files=()
while IFS= read -r file; do shell_files+=("${file}"); done < <(find deploy scripts -type f -name '*.sh' -print | sort)
(( ${#shell_files[@]} )) || { echo '[deploy-check][ERR] no deployment shell files found' >&2; exit 1; }
for file in "${shell_files[@]}"; do
  bash -n "${file}"
done
echo "[deploy-check] bash syntax OK (${#shell_files[@]} files)"

COMPOSE_FILE=deploy/docker/docker-compose.yml
docker compose -f "${COMPOSE_FILE}" config --quiet
echo '[deploy-check] docker compose config OK (default profile)'

default_services="$(docker compose -f "${COMPOSE_FILE}" config --services)"
profile_services="$(docker compose -f "${COMPOSE_FILE}" --profile lightrag config --services)"
for service in postgres operation manager agent; do
  grep -qx "${service}" <<<"${default_services}" || { echo "[deploy-check][ERR] default Compose profile missing ${service}" >&2; exit 1; }
done
if grep -Eq '^(lightrag|lightrag-postgres)$' <<<"${default_services}"; then
  echo '[deploy-check][ERR] LightRAG services must not start in the default profile' >&2
  exit 1
fi
for service in lightrag-postgres lightrag; do
  grep -qx "${service}" <<<"${profile_services}" || { echo "[deploy-check][ERR] lightrag profile missing ${service}" >&2; exit 1; }
done
echo '[deploy-check] Compose profile boundary OK (LightRAG opt-in)'

# Every image in the release Compose graph must have an immutable-looking
# version reference. Environment overrides are checked too, so CI catches a
# caller supplying :latest even when the checked-in fallback is safe.
images=()
while IFS= read -r image; do [[ -n "${image}" ]] && images+=("${image}"); done < <(docker compose -f "${COMPOSE_FILE}" --profile lightrag config --images)
(( ${#images[@]} )) || { echo '[deploy-check][ERR] Compose returned no images' >&2; exit 1; }
for image in "${images[@]}"; do
  if [[ "${image}" == *@sha256:* ]]; then
    [[ "${image}" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "[deploy-check][ERR] invalid image digest: ${image}" >&2; exit 1; }
    continue
  fi
  [[ "${image}" == *:* ]] || { echo "[deploy-check][ERR] unpinned image reference: ${image}" >&2; exit 1; }
  tag="${image##*:}"
  case "${tag}" in
    ""|latest|dev|test|edge)
      echo "[deploy-check][ERR] mutable/unpinned image reference: ${image}" >&2
      exit 1
      ;;
  esac
done
echo "[deploy-check] fixed image references OK (${#images[@]} images)"

# The LightRAG database operation is part of the release gate, but CI only runs
# its non-mutating bootstrap contract.
bash deploy/lightrag/init-db.sh --dry-run >/tmp/aiteam-lightrag-init-db.out
grep -q 'extension vector' /tmp/aiteam-lightrag-init-db.out
echo '[deploy-check] LightRAG PG bootstrap dry-run OK'
bash scripts/validate-lightrag-env.sh >/tmp/aiteam-lightrag-env.out
grep -q 'OK (non-mutating' /tmp/aiteam-lightrag-env.out
bash scripts/lightrag-ops.sh --dry-run backup >/tmp/aiteam-lightrag-backup.out
bash scripts/lightrag-ops.sh --dry-run upgrade --image ghcr.io/hkuds/lightrag:1.5.6 >/tmp/aiteam-lightrag-upgrade.out
bash scripts/lightrag-ops.sh --dry-run rollback --image ghcr.io/hkuds/lightrag:1.5.6 >/tmp/aiteam-lightrag-rollback.out
echo '[deploy-check] LightRAG validate/backup/upgrade/rollback dry-runs OK'

# Reject credentials accidentally committed to deployment material while allowing
# variable references, generated-secret instructions, and explicit placeholders.
python3 - <<'PY'
import pathlib
import re
import sys

roots = [pathlib.Path(root) for root in ("deploy", "scripts", "docs/部署运维", ".github/workflows")]
files = sorted({path for root in roots if root.exists() for path in root.rglob("*") if path.is_file()})
private_key = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")
token_prefix = re.compile(r"(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{16,}")
secret_assignment = re.compile(
    r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:API_?KEY(?:_[A-Z0-9]+)*|ACCESS_?KEY(?:_[A-Z0-9]+)*|"
    r"PRIVATE_?KEY|CREDENTIALS?(?:_KEY)?|PASSWORD|PASSWD|SECRET(?:_[A-Z0-9]+)*|"
    r"TOKEN(?:_[A-Z0-9]+)*)\b\s*[:=]\s*(?P<value>[^#\s]+)",
    re.I,
)
safe_exact = {"postgres", "apprwpass", "aiteam_test", "aiteam_v1", "wrong-token", "your-strong-token", "***"}
safe_prefixes = (
    "dev-", "test-", "example-", "placeholder-", "changeme", "change-me",
    "<", "...", "your-", "wrong-",
)

def is_placeholder(value: str) -> bool:
    value = value.strip().strip("'\\\"").lower()
    return not value or value in safe_exact or value.startswith(safe_prefixes) or value.startswith("$")

violations = []
for path in files:
    name = path.as_posix()
    if name == "scripts/check-deploy.sh":
        continue
    for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
        if private_key.search(line):
            violations.append(f"{name}:{number}")
            continue
        scan_line = re.sub(r"\$\{[^}]*\}", "", line)
        if token_prefix.search(scan_line):
            violations.append(f"{name}:{number}")
            continue
        for found in secret_assignment.finditer(scan_line):
            if not is_placeholder(found.group("value")):
                violations.append(f"{name}:{number}")
                break
if violations:
    print("[deploy-check][ERR] possible committed secret:", *violations, sep="\n", file=sys.stderr)
    sys.exit(1)
print("[deploy-check] static secret scan OK")
PY

python3 - <<'PY'
from pathlib import Path
import re

compose = Path("deploy/docker/docker-compose.yml").read_text()
agent = re.search(r"(?ms)^  agent:\n.*?(?=^volumes:)", compose)
if not agent:
    raise SystemExit("[deploy-check][ERR] Agent service block is missing")
private_agent_keys = []
for line in agent.group(0).splitlines():
    if line.lstrip().startswith("#"):
        continue
    match = re.match(r"^\s+([A-Z][A-Z0-9_]*)\s*:", line)
    if match and (
        match.group(1).startswith("LIGHTRAG_")
        or match.group(1).startswith("HINDSIGHT_")
        or match.group(1).startswith("AITEAM_HINDSIGHT_")
        or "PRIVATE_KEY" in match.group(1)
    ):
        private_agent_keys.append(match.group(1))
if private_agent_keys:
    raise SystemExit("[deploy-check][ERR] Agent Compose environment contains Manager-only keys: " + ", ".join(private_agent_keys))
print("[deploy-check] Agent Compose credential boundary OK")
PY

grep -q -- '-u LIGHTRAG_DB_PASSWORD' scripts/ctl.sh
grep -q -- '-u HINDSIGHT_SERVICE_TOKEN' scripts/ctl.sh
grep -q -- '-u AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY' scripts/ctl.sh
echo '[deploy-check] Agent local credential inheritance guards present'

# Keep stale Agent process groups from surviving a PID-file rotation. These are
# static assertions only; this gate never stops a live process.
grep -q 'setsid env' scripts/ctl.sh
grep -q 'process_group_alive' scripts/ctl.sh
grep -q 'kill -KILL -- "-${pid}"' scripts/ctl.sh
grep -q 'AITEAM_AGENT_SANDBOX_READY' scripts/ctl.sh
echo '[deploy-check] stale Agent PID/process-group and production launch guards present'

bash scripts/check-agent-sandbox.sh --dry-run >/tmp/aiteam-agent-sandbox-dry-run.out
grep -q 'native bwrap/Landlock/Seatbelt execution is deferred' /tmp/aiteam-agent-sandbox-dry-run.out
echo '[deploy-check] Agent sandbox dry-run entrypoint OK'
